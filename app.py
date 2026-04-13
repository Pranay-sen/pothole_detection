"""
Pothole Detection Web System — Flask + YOLOv8
==============================================
Uses phone camera (via IP Webcam app) with real GPS location.
Detects potholes and shows them on the Leaflet map in real-time.
"""

import os
import glob
import time
import threading
import logging
import sqlite3
import math
import uuid
import json
import shutil
from urllib.parse import urlparse
import requests
from datetime import datetime, timedelta

import cv2
from flask import Flask, request, jsonify, send_from_directory
from ultralytics import YOLO

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "database.db")
CCTV_FEED_DIR = os.path.join(BASE_DIR, "cctv_feed")
MODEL_PATH = os.path.join(BASE_DIR, "best.pt")
STATIC_DIR = os.path.join(BASE_DIR, "static")
FRONTEND_BUILD_DIR = os.path.join(STATIC_DIR, "frontend")
SNAPSHOT_DIR = os.path.join(STATIC_DIR, "detections")
DETECTION_EXPORT_DIR = os.path.join(BASE_DIR, "saved_detections")
DETECTION_INTERVAL = 5          # seconds between detection sweeps
DUPLICATE_DIST_THRESHOLD = 0.0005   # ~50 m in lat/lng degrees
DUPLICATE_TIME_THRESHOLD = 300      # seconds (5 min)
CONFIDENCE_THRESHOLD = 0.35         # minimum YOLO confidence
DEFAULT_LAT = 28.6139
DEFAULT_LNG = 77.2090

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("pothole")

# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder=STATIC_DIR)
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


@app.after_request
def add_no_cache_headers(response):
    if request.path == "/" or response.mimetype == "text/html":
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# ---------------------------------------------------------------------------
# Load YOLO model ONCE at startup
# ---------------------------------------------------------------------------
log.info("Loading YOLOv8 model from %s ...", MODEL_PATH)
model = YOLO(MODEL_PATH)
log.info("Model loaded successfully.")

# ---------------------------------------------------------------------------
# Database helpers (thread-safe)
# ---------------------------------------------------------------------------
_db_lock = threading.Lock()


def _get_conn() -> sqlite3.Connection:
    """Return a NEW connection each time (safe for threads)."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_db():
    """Create tables if they don't exist."""
    os.makedirs(STATIC_DIR, exist_ok=True)
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    os.makedirs(DETECTION_EXPORT_DIR, exist_ok=True)
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS cameras (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            latitude    REAL    NOT NULL,
            longitude   REAL    NOT NULL,
            stream_url  TEXT    NOT NULL
        );
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS potholes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            camera_id   INTEGER NOT NULL,
            lat         REAL    NOT NULL,
            lng         REAL    NOT NULL,
            confidence  REAL    NOT NULL,
            timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (camera_id) REFERENCES cameras(id)
        );
    """)
    conn.commit()

    pothole_columns = {
        "detection_label": "TEXT",
        "image_path": "TEXT",
        "location_source": "TEXT",
        "gps_accuracy": "REAL",
    }
    for column_name, column_type in pothole_columns.items():
        existing = conn.execute("PRAGMA table_info(potholes)").fetchall()
        known_names = {row["name"] for row in existing}
        if column_name not in known_names:
            conn.execute(f"ALTER TABLE potholes ADD COLUMN {column_name} {column_type}")

    camera_columns = {
        "location_source": "TEXT DEFAULT 'camera_static'",
        "gps_accuracy": "REAL",
    }
    for column_name, column_type in camera_columns.items():
        existing = conn.execute("PRAGMA table_info(cameras)").fetchall()
        known_names = {row["name"] for row in existing}
        if column_name not in known_names:
            conn.execute(f"ALTER TABLE cameras ADD COLUMN {column_name} {column_type}")

    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# GPS fetching from IP Webcam app
# ---------------------------------------------------------------------------

def _normalize_phone_urls(raw_source: str):
    """Return stable base, stream and snapshot URLs for IP Webcam / direct streams."""
    source = (raw_source or "").strip()
    if not source:
        return None

    if not source.startswith(("http://", "https://", "rtsp://")):
        source = f"http://{source}"

    parsed = urlparse(source)
    scheme = parsed.scheme or "http"
    netloc = parsed.netloc or parsed.path
    path = parsed.path if parsed.netloc else ""

    if not netloc:
        return None

    if ":" not in netloc and scheme in {"http", "https"}:
        netloc = f"{netloc}:8080"

    base_url = f"{scheme}://{netloc}"

    if path.endswith("/shot.jpg"):
        stream_url = f"{base_url}/video"
        shot_url = f"{base_url}/shot.jpg"
    elif path.endswith("/video") or path == "":
        stream_url = f"{base_url}/video"
        shot_url = f"{base_url}/shot.jpg"
    else:
        stream_url = source
        shot_url = f"{base_url}/shot.jpg"

    return {
        "base_url": base_url.rstrip("/"),
        "stream_url": stream_url,
        "shot_url": shot_url,
    }


def _extract_lat_lng(value):
    """Walk arbitrary JSON and try to extract latitude/longitude."""
    if isinstance(value, dict):
        lat = value.get("lat", value.get("latitude", value.get("gps_lat")))
        lng = value.get("lng", value.get("lon", value.get("longitude", value.get("gps_lng"))))
        if lat is not None and lng is not None:
            try:
                lat = float(lat)
                lng = float(lng)
                if lat != 0.0 or lng != 0.0:
                    return (lat, lng)
            except (TypeError, ValueError):
                pass

        for nested in value.values():
            coords = _extract_lat_lng(nested)
            if coords:
                return coords

    if isinstance(value, list):
        if len(value) >= 2:
            try:
                lat = float(value[0])
                lng = float(value[1])
                if -90 <= lat <= 90 and -180 <= lng <= 180 and (lat != 0.0 or lng != 0.0):
                    return (lat, lng)
            except (TypeError, ValueError):
                pass

        for nested in value:
            coords = _extract_lat_lng(nested)
            if coords:
                return coords

    return None


def _extract_accuracy(value):
    """Walk arbitrary JSON and try to extract GPS accuracy-like metadata."""
    if isinstance(value, dict):
        for key in (
            "accuracy",
            "gps_accuracy",
            "horizontal_accuracy",
            "horizontalAccuracy",
            "precision",
            "hdop",
        ):
            if key in value:
                try:
                    number = float(value[key])
                    if number > 0:
                        return number
                except (TypeError, ValueError):
                    pass

        for nested in value.values():
            found = _extract_accuracy(nested)
            if found is not None:
                return found

    if isinstance(value, list):
        for nested in value:
            found = _extract_accuracy(nested)
            if found is not None:
                return found

    return None


def _save_detection_crop(frame, box, camera_id):
    """Save a crop image for the detection feed and return its public path."""
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = box.xyxy[0].tolist()

    x1 = max(int(x1), 0)
    y1 = max(int(y1), 0)
    x2 = min(int(x2), width)
    y2 = min(int(y2), height)

    if x2 <= x1 or y2 <= y1:
        return None

    crop = frame[y1:y2, x1:x2]
    if crop.size == 0:
        return None

    filename = f"cam{camera_id}_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}.jpg"
    absolute_path = os.path.join(SNAPSHOT_DIR, filename)
    public_path = f"/static/detections/{filename}"
    cv2.imwrite(absolute_path, crop)
    return public_path


def _export_detection_bundle(detection_id, detection_row):
    """Write a per-detection folder with image and metadata for later review."""
    target_dir = os.path.join(DETECTION_EXPORT_DIR, f"pothole_{detection_id}")
    os.makedirs(target_dir, exist_ok=True)

    exported = dict(detection_row)
    image_path = exported.get("image_path")
    if image_path:
        source_file = os.path.join(BASE_DIR, image_path.lstrip("/").replace("/", os.sep))
        if os.path.exists(source_file):
            _, ext = os.path.splitext(source_file)
            exported_name = f"detection{ext or '.jpg'}"
            shutil.copy2(source_file, os.path.join(target_dir, exported_name))
            exported["saved_image"] = exported_name

    metadata_path = os.path.join(target_dir, "metadata.json")
    with open(metadata_path, "w", encoding="utf-8") as handle:
        json.dump(exported, handle, indent=2)

def get_phone_gps(source_url: str):
    """
    Fetch real-time GPS from IP Webcam Android app.
    IP Webcam exposes sensors at: http://<ip>:8080/sensors.json
    Returns (lat, lng) or None on failure.
    """
    urls = _normalize_phone_urls(source_url)
    if not urls:
        return None

    base_url = urls["base_url"]
    candidate_urls = [
        f"{base_url}/sensors.json",
        f"{base_url}/gps.json",
    ]

    try:
        for gps_url in candidate_urls:
            resp = requests.get(gps_url, timeout=3)
            resp.raise_for_status()
            payload = resp.json()
            coords = _extract_lat_lng(payload)
            if coords:
                lat, lng = coords
                accuracy = _extract_accuracy(payload)
                log.info("  GPS from phone: %.6f, %.6f", lat, lng)
                return {
                    "lat": lat,
                    "lng": lng,
                    "accuracy": accuracy,
                    "location_source": "phone_live",
                }
    except Exception as e:
        log.warning("  Could not fetch GPS from phone: %s", e)

    return None


# ---------------------------------------------------------------------------
# Frame capture helpers
# ---------------------------------------------------------------------------

def capture_frame_from_source(stream_url: str):
    """
    Capture a single frame based on stream_url type:
      - "0"              -> laptop webcam (OpenCV device 0)
      - "images"         -> read images from ./cctv_feed/ folder
      - "http://..."     -> IP camera stream (phone)
    Returns a BGR numpy array or None on failure.
    """
    # --- Laptop webcam ---
    if stream_url.strip() == "0":
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            log.warning("Webcam (device 0) could not be opened.")
            return None
        ret, frame = cap.read()
        cap.release()
        if not ret or frame is None:
            log.warning("Failed to read frame from webcam.")
            return None
        return frame

    # --- Image folder mode ---
    if stream_url.strip().lower() == "images":
        patterns = ["*.jpg", "*.jpeg", "*.png", "*.bmp"]
        files = []
        for pat in patterns:
            files.extend(glob.glob(os.path.join(CCTV_FEED_DIR, pat)))
        if not files:
            log.warning("No images found in %s", CCTV_FEED_DIR)
            return None
        # Pick latest modified file
        files.sort(key=os.path.getmtime, reverse=True)
        img = cv2.imread(files[0])
        if img is None:
            log.warning("Could not read image: %s", files[0])
        return img

    # --- IP camera / Phone camera (IP Webcam app) ---
    if stream_url.startswith("http") or stream_url.startswith("rtsp"):
        # For IP Webcam app, use shot.jpg for single frame (more reliable)
        urls = _normalize_phone_urls(stream_url) or {}
        shot_url = urls.get("shot_url", stream_url)
        try:
            import numpy as np
            resp = requests.get(shot_url, timeout=5)
            if resp.status_code == 200:
                img_array = np.frombuffer(resp.content, dtype=np.uint8)
                frame = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
                if frame is not None:
                    return frame
        except Exception as e:
            log.warning("  shot.jpg failed, trying video stream: %s", e)

        # Fallback: OpenCV video capture
        cap = cv2.VideoCapture(stream_url)
        if not cap.isOpened():
            log.warning("IP camera stream could not be opened: %s", stream_url)
            return None
        ret, frame = cap.read()
        cap.release()
        if not ret or frame is None:
            log.warning("Failed to read frame from IP stream: %s", stream_url)
            return None
        return frame

    log.warning("Unknown stream_url type: %s", stream_url)
    return None


# ---------------------------------------------------------------------------
# Duplicate check
# ---------------------------------------------------------------------------

def _haversine_approx(lat1, lng1, lat2, lng2):
    """Quick Euclidean approximation in degree-space."""
    return math.sqrt((lat1 - lat2) ** 2 + (lng1 - lng2) ** 2)


def is_duplicate(conn, lat, lng, camera_id):
    """Check if a near-identical pothole was already recorded recently."""
    cutoff = (datetime.utcnow() - timedelta(seconds=DUPLICATE_TIME_THRESHOLD)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    rows = conn.execute(
        "SELECT lat, lng FROM potholes WHERE camera_id = ? AND timestamp >= ?",
        (camera_id, cutoff),
    ).fetchall()
    for r in rows:
        if _haversine_approx(lat, lng, r["lat"], r["lng"]) < DUPLICATE_DIST_THRESHOLD:
            return True
    return False


# ---------------------------------------------------------------------------
# Detection logic
# ---------------------------------------------------------------------------

def run_detection_cycle(force_store: bool = False):
    """Go through every camera, capture frame, run YOLO, store detections."""
    conn = _get_conn()
    cameras = conn.execute("SELECT * FROM cameras").fetchall()
    conn.close()

    if not cameras:
        log.info("No cameras configured. Skipping detection.")
        return

    for cam in cameras:
        cam_id = cam["id"]
        cam_name = cam["name"]
        cam_lat = cam["latitude"]
        cam_lng = cam["longitude"]
        stream_url = cam["stream_url"]
        location_source = cam["location_source"] if "location_source" in cam.keys() else "camera_static"
        gps_accuracy = cam["gps_accuracy"] if "gps_accuracy" in cam.keys() else None

        log.info("Processing camera '%s' (id=%d) ...", cam_name, cam_id)

        # --- Try to get REAL GPS from phone ---
        real_lat, real_lng = cam_lat, cam_lng
        if stream_url.startswith("http"):
            gps = get_phone_gps(stream_url)
            if gps:
                real_lat, real_lng = gps["lat"], gps["lng"]
                gps_accuracy = gps.get("accuracy")
                location_source = gps.get("location_source", "phone_live")
                # Update camera location in DB with latest GPS
                with _db_lock:
                    c = _get_conn()
                    c.execute(
                        "UPDATE cameras SET latitude=?, longitude=?, location_source=?, gps_accuracy=? WHERE id=?",
                        (real_lat, real_lng, location_source, gps_accuracy, cam_id),
                    )
                    c.commit()
                    c.close()

        # --- Capture frame ---
        frame = capture_frame_from_source(stream_url)
        if frame is None:
            log.info("  -> No frame captured, skipping.")
            continue

        # --- Run YOLOv8 ---
        try:
            results = model(frame, verbose=False)
        except Exception as exc:
            log.error("  -> YOLO inference failed: %s", exc)
            continue

        detections = results[0].boxes if results and len(results) > 0 else []
        if detections is None or len(detections) == 0:
            log.info("  -> No detections.")
            continue

        stored = 0
        with _db_lock:
            conn = _get_conn()
            for box in detections:
                conf = float(box.conf[0])
                if conf < CONFIDENCE_THRESHOLD:
                    continue

                class_id = int(box.cls[0]) if box.cls is not None else -1
                detection_label = model.names.get(class_id, "pothole") if isinstance(model.names, dict) else "pothole"
                image_path = _save_detection_crop(frame, box, cam_id)

                # Small offset so multiple potholes don't overlap
                x_center = float(box.xywhn[0][0])
                y_center = float(box.xywhn[0][1])
                offset_lat = (x_center - 0.5) * 0.001
                offset_lng = (y_center - 0.5) * 0.001
                det_lat = real_lat + offset_lat
                det_lng = real_lng + offset_lng

                if not force_store and is_duplicate(conn, det_lat, det_lng, cam_id):
                    log.info("  -> Duplicate skipped (conf=%.2f)", conf)
                    continue

                conn.execute(
                    """
                    INSERT INTO potholes (
                        camera_id, lat, lng, confidence, detection_label, image_path, location_source, gps_accuracy
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        cam_id,
                        det_lat,
                        det_lng,
                        round(conf, 4),
                        detection_label,
                        image_path,
                        location_source,
                        gps_accuracy,
                    ),
                )
                detection_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                row = conn.execute(
                    """
                    SELECT
                        p.id,
                        p.camera_id,
                        p.lat,
                        p.lng,
                        p.confidence,
                        p.timestamp,
                        p.detection_label,
                        p.image_path,
                        p.location_source,
                        p.gps_accuracy,
                        ? AS camera_name
                    FROM potholes p
                    WHERE p.id = ?
                    """,
                    (cam_name, detection_id),
                ).fetchone()
                _export_detection_bundle(detection_id, row)
                stored += 1

            conn.commit()
            conn.close()

        log.info("  -> %d new pothole(s) stored.", stored)


# ---------------------------------------------------------------------------
# Background detection thread
# ---------------------------------------------------------------------------
_detection_thread = None
_detection_running = False


def _detection_loop():
    global _detection_running
    log.info("Background detection thread started (interval=%ds).", DETECTION_INTERVAL)
    while _detection_running:
        try:
            run_detection_cycle()
        except Exception as exc:
            log.error("Detection cycle error: %s", exc)
        time.sleep(DETECTION_INTERVAL)
    log.info("Background detection thread stopped.")


def start_detection_thread():
    global _detection_thread, _detection_running
    if _detection_running:
        return
    _detection_running = True
    _detection_thread = threading.Thread(target=_detection_loop, daemon=True)
    _detection_thread.start()
    log.info("Detection thread auto-started.")


def get_frontend_index_path():
    return os.path.join(FRONTEND_BUILD_DIR, "index.html")


def frontend_is_built():
    return os.path.exists(get_frontend_index_path())


def get_phone_camera_row():
    conn = _get_conn()
    row = conn.execute(
        """
        SELECT id, name, latitude, longitude, stream_url, location_source, gps_accuracy
        FROM cameras
        WHERE name = 'Phone Camera'
        LIMIT 1
        """
    ).fetchone()
    conn.close()
    if row:
        location_source = row["location_source"] if "location_source" in row.keys() else None
        if (
            float(row["latitude"]) == DEFAULT_LAT
            and float(row["longitude"]) == DEFAULT_LNG
            and location_source in (None, "camera_static", "last_known")
        ):
            return None
    return row


# ---------------------------------------------------------------------------
# Flask routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    if frontend_is_built():
        return send_from_directory(FRONTEND_BUILD_DIR, "index.html", max_age=0)

    return jsonify({
        "status": "frontend_not_built",
        "message": "Frontend build not found. Run `npm install` and `npm run build` inside potholedtidrontend."
    }), 503


@app.route("/add_camera", methods=["POST"])
def add_camera():
    """Add a new camera source."""
    data = request.get_json(force=True)
    name = data.get("name")
    lat = data.get("lat")
    lng = data.get("lng")
    stream_url = data.get("stream_url")

    if not all([name, lat is not None, lng is not None, stream_url]):
        return jsonify({"error": "Missing required fields: name, lat, lng, stream_url"}), 400

    with _db_lock:
        conn = _get_conn()
        conn.execute(
            "INSERT INTO cameras (name, latitude, longitude, stream_url) VALUES (?, ?, ?, ?)",
            (name, float(lat), float(lng), str(stream_url)),
        )
        conn.commit()
        conn.close()

    log.info("Camera added: %s -> %s", name, stream_url)
    return jsonify({"status": "ok", "message": f"Camera '{name}' added."})


@app.route("/setup_phone", methods=["POST"])
def setup_phone():
    """
    Quick setup: user provides phone IP, we create/update the phone camera.
    Body: { "ip": "192.168.1.5" } or { "ip": "192.168.1.5:8080" }
    """
    data = request.get_json(force=True)
    ip = data.get("ip", "").strip()
    browser_lat = data.get("browser_lat")
    browser_lng = data.get("browser_lng")

    if not ip:
        return jsonify({"error": "Please provide your phone IP address"}), 400

    urls = _normalize_phone_urls(ip)
    if not urls:
        return jsonify({"error": "Invalid phone IP or URL"}), 400

    stream_url = urls["stream_url"]
    gps = get_phone_gps(stream_url)

    with _db_lock:
        conn = _get_conn()
        # Check if phone camera already exists
        existing = conn.execute(
            """
            SELECT id, latitude, longitude, location_source
            FROM cameras
            WHERE name = 'Phone Camera'
            """
        ).fetchone()

        location_source = "phone_live"
        gps_accuracy = gps.get("accuracy") if gps else None
        if gps:
            lat = gps["lat"]
            lng = gps["lng"]
            location_source = gps.get("location_source", "phone_live")
        elif browser_lat is not None and browser_lng is not None:
            lat = float(browser_lat)
            lng = float(browser_lng)
            location_source = "browser_fallback"
        elif existing and not (
            float(existing["latitude"]) == DEFAULT_LAT and float(existing["longitude"]) == DEFAULT_LNG
        ):
            lat = float(existing["latitude"])
            lng = float(existing["longitude"])
            location_source = "last_known"
        else:
            conn.close()
            return jsonify({
                "error": "Live GPS not available from phone. Enable GPS in IP Webcam or open this dashboard on the same device and allow browser location."
            }), 400

        if existing:
            conn.execute(
                "UPDATE cameras SET latitude=?, longitude=?, stream_url=?, location_source=?, gps_accuracy=? WHERE id=?",
                (lat, lng, stream_url, location_source, gps_accuracy, existing["id"]),
            )
            log.info("Phone camera updated: %s", stream_url)
        else:
            conn.execute(
                """
                INSERT INTO cameras (name, latitude, longitude, stream_url, location_source, gps_accuracy)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                ("Phone Camera", lat, lng, stream_url, location_source, gps_accuracy),
            )
            log.info("Phone camera added: %s", stream_url)
        conn.commit()
        conn.close()

    # Auto-start detection if not already running
    start_detection_thread()

    return jsonify({
        "status": "ok",
        "message": f"Phone camera connected! Stream: {stream_url}",
        "lat": lat,
        "lng": lng,
        "stream_url": stream_url,
        "gps_live": gps is not None,
        "location_source": location_source,
        "gps_accuracy": gps_accuracy,
    })


@app.route("/cameras", methods=["GET"])
def list_cameras():
    """Return all registered cameras."""
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM cameras").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/detect", methods=["POST"])
def detect_now():
    """Trigger one detection cycle manually."""
    threading.Thread(target=run_detection_cycle, kwargs={"force_store": True}, daemon=True).start()
    return jsonify({"status": "ok", "message": "Detection cycle triggered. Duplicate filter bypassed for this manual scan."})


@app.route("/potholes", methods=["GET"])
def get_potholes():
    """Return all pothole records as JSON."""
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT
            p.id,
            p.camera_id,
            c.name AS camera_name,
            p.lat,
            p.lng,
            p.confidence,
            p.timestamp,
            p.detection_label,
            p.image_path,
            p.location_source,
            p.gps_accuracy
        FROM potholes p
        LEFT JOIN cameras c ON c.id = p.camera_id
        ORDER BY p.timestamp DESC
        """
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


def export_all_detection_bundles():
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT
            p.id,
            p.camera_id,
            c.name AS camera_name,
            p.lat,
            p.lng,
            p.confidence,
            p.timestamp,
            p.detection_label,
            p.image_path,
            p.location_source,
            p.gps_accuracy
        FROM potholes p
        LEFT JOIN cameras c ON c.id = p.camera_id
        ORDER BY p.id
        """
    ).fetchall()
    conn.close()
    for row in rows:
        _export_detection_bundle(row["id"], row)
    return len(rows)


@app.route("/phone_snapshot", methods=["GET"])
def phone_snapshot():
    """Proxy latest phone frame through Flask so the frontend stays same-origin."""
    phone_camera = get_phone_camera_row()
    if not phone_camera:
        return jsonify({"error": "Phone camera not configured"}), 404

    frame = capture_frame_from_source(phone_camera["stream_url"])
    if frame is None:
        return jsonify({"error": "Phone frame unavailable. Check IP Webcam app and Wi-Fi connection."}), 503

    filename = os.path.join(SNAPSHOT_DIR, "_latest_phone_frame.jpg")
    ok = cv2.imwrite(filename, frame)
    if not ok:
        return jsonify({"error": "Could not cache latest phone frame"}), 500

    return send_from_directory(SNAPSHOT_DIR, "_latest_phone_frame.jpg", max_age=0)


@app.route("/start", methods=["POST"])
def start_detection():
    """Start continuous background detection thread."""
    start_detection_thread()
    return jsonify({"status": "ok", "message": "Background detection started."})


@app.route("/stop", methods=["POST"])
def stop_detection():
    """Stop background detection thread."""
    global _detection_running
    _detection_running = False
    return jsonify({"status": "ok", "message": "Background detection stopping..."})


@app.route("/clear_potholes", methods=["POST"])
def clear_potholes():
    """Clear all pothole records."""
    with _db_lock:
        conn = _get_conn()
        conn.execute("DELETE FROM potholes")
        conn.commit()
        conn.close()
    return jsonify({"status": "ok", "message": "All potholes cleared."})


@app.route("/status", methods=["GET"])
def status():
    """Return detection system status."""
    conn = _get_conn()
    cam_count = conn.execute("SELECT COUNT(*) as cnt FROM cameras").fetchone()["cnt"]
    pot_count = conn.execute("SELECT COUNT(*) as cnt FROM potholes").fetchone()["cnt"]
    conn.close()
    phone_camera = get_phone_camera_row()
    return jsonify({
        "detection_running": _detection_running,
        "cameras": cam_count,
        "potholes_detected": pot_count,
        "phone_camera": dict(phone_camera) if phone_camera else None,
        "frontend_built": frontend_is_built(),
        "model_file": os.path.basename(MODEL_PATH),
        "confidence_threshold": CONFIDENCE_THRESHOLD,
        "detection_interval": DETECTION_INTERVAL,
    })


@app.route("/plugin/live-feed.json", methods=["GET"])
def plugin_live_feed():
    """Public JSON feed for online viewing / lightweight integrations."""
    return jsonify({
        "status": status().get_json(),
        "potholes": get_potholes().get_json(),
    })


@app.route("/export_detections", methods=["POST"])
def export_detections():
    count = export_all_detection_bundles()
    return jsonify({"status": "ok", "exported": count, "folder": DETECTION_EXPORT_DIR})


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    init_db()
    log.info("==============================================")
    log.info("  Pothole Detection System Ready!")
    log.info("  Open: http://127.0.0.1:5000")
    log.info("==============================================")
    app.run(host="0.0.0.0", port=5000, debug=False)
