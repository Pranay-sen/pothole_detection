"""
Public Pothole Reporting Site — Flask
======================================
Read-only map of ALL active potholes for the public to see.
Users can upload photos to report new potholes (runs YOLO model).
Shares the same database.db and best.pt model as the admin server.
Runs on port 8080 (separate from admin on port 5000).
"""

import os
import uuid
import time
import sqlite3
import threading
import logging

import cv2
import numpy as np
from flask import Flask, request, jsonify, send_from_directory
from ultralytics import YOLO

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "database.db")
MODEL_PATH = os.path.join(BASE_DIR, "best.pt")
STATIC_DIR = os.path.join(BASE_DIR, "static")
SNAPSHOT_DIR = os.path.join(STATIC_DIR, "detections")
PUBLIC_SITE_DIR = os.path.join(BASE_DIR, "public_site")
CONFIDENCE_THRESHOLD = 0.35

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("pothole_public")

# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder=STATIC_DIR)
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
log.info("Loading YOLOv8 model for public site from %s ...", MODEL_PATH)
model = YOLO(MODEL_PATH)
log.info("Public site model loaded successfully.")

# ---------------------------------------------------------------------------
# Database helpers (thread-safe, independent of app.py)
# ---------------------------------------------------------------------------
_db_lock = threading.Lock()


def _get_conn():
    """Return a NEW connection each time (safe for threads)."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_public_db():
    """Ensure status column + public upload camera row exist."""
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    conn = _get_conn()

    # Add status column if not present
    existing = conn.execute("PRAGMA table_info(potholes)").fetchall()
    known_names = {row["name"] for row in existing}
    if "status" not in known_names:
        conn.execute("ALTER TABLE potholes ADD COLUMN status TEXT DEFAULT 'active'")

    # Backfill existing rows so NULL → 'active'
    conn.execute("UPDATE potholes SET status = 'active' WHERE status IS NULL")

    # Ensure a camera row exists for public uploads
    cam = conn.execute(
        "SELECT id FROM cameras WHERE name = 'Public User Upload'"
    ).fetchone()
    if not cam:
        conn.execute("""
            INSERT INTO cameras (name, latitude, longitude, stream_url, location_source)
            VALUES ('Public User Upload', 0, 0, 'user_upload', 'user_upload')
        """)

    conn.commit()
    conn.close()
    log.info("Public DB initialization complete.")


# ---------------------------------------------------------------------------
# Routes — static pages
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    """Serve the public site entry page."""
    return send_from_directory(PUBLIC_SITE_DIR, "index.html", max_age=0)


@app.route("/public_site/<path:filename>")
def serve_public_static(filename):
    """Serve CSS / JS / images for the public site."""
    return send_from_directory(PUBLIC_SITE_DIR, filename)


@app.route("/static/detections/<path:filename>")
def serve_detection_image(filename):
    """Serve pothole crop images from the shared detections folder."""
    return send_from_directory(SNAPSHOT_DIR, filename)


# ---------------------------------------------------------------------------
# Routes — APIs
# ---------------------------------------------------------------------------
@app.route("/api/potholes", methods=["GET"])
def get_potholes():
    """Return all ACTIVE potholes (hides fixed ones from public)."""
    conn = _get_conn()
    rows = conn.execute("""
        SELECT
            p.id,
            p.camera_id,
            c.name  AS camera_name,
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
        WHERE (p.status IS NULL OR p.status = 'active')
        ORDER BY p.timestamp DESC
    """).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/upload", methods=["POST"])
def upload_photo():
    """
    Accept a user-submitted photo + GPS coordinates.
    Run YOLO inference.  If pothole detected → store in DB.
    """
    if "photo" not in request.files:
        return jsonify({"error": "No photo provided"}), 400

    lat = request.form.get("lat")
    lng = request.form.get("lng")
    accuracy = request.form.get("accuracy")

    if lat is None or lng is None:
        return jsonify({
            "error": "Location not provided. Please allow location access in your browser."
        }), 400

    try:
        lat = float(lat)
        lng = float(lng)
        gps_accuracy = float(accuracy) if accuracy else None
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid location coordinates"}), 400

    # Read image from upload into OpenCV
    file = request.files["photo"]
    file_bytes = np.frombuffer(file.read(), np.uint8)
    image = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)

    if image is None:
        return jsonify({
            "error": "Could not read image. Please try a different photo."
        }), 400

    # Run YOLO inference
    try:
        results = model(image, verbose=False)
    except Exception as exc:
        log.error("YOLO inference failed on user upload: %s", exc)
        return jsonify({"error": "Model inference failed. Please try again."}), 500

    detections = results[0].boxes if results and len(results) > 0 else []
    if detections is None or len(detections) == 0:
        return jsonify({
            "detected": False,
            "message": "No pothole detected in this image. Please make sure the pothole is clearly visible.",
        })

    # Filter by confidence threshold
    valid_detections = []
    for box in detections:
        conf = float(box.conf[0])
        if conf >= CONFIDENCE_THRESHOLD:
            valid_detections.append((box, conf))

    if not valid_detections:
        return jsonify({
            "detected": False,
            "message": "No pothole detected with sufficient confidence. Try a closer or different angle.",
        })

    # Get public upload camera ID
    conn = _get_conn()
    cam = conn.execute(
        "SELECT id FROM cameras WHERE name = 'Public User Upload'"
    ).fetchone()
    if not cam:
        conn.close()
        return jsonify({"error": "System not initialised properly."}), 500
    camera_id = cam["id"]

    stored = 0
    for box, conf in valid_detections:
        # Crop the detection from the frame
        height, width = image.shape[:2]
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        x1 = max(int(x1), 0)
        y1 = max(int(y1), 0)
        x2 = min(int(x2), width)
        y2 = min(int(y2), height)

        if x2 <= x1 or y2 <= y1:
            continue

        crop = image[y1:y2, x1:x2]
        if crop.size == 0:
            continue

        filename = f"user_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}.jpg"
        filepath = os.path.join(SNAPSHOT_DIR, filename)
        image_path = f"/static/detections/{filename}"
        cv2.imwrite(filepath, crop)

        class_id = int(box.cls[0]) if box.cls is not None else -1
        detection_label = (
            model.names.get(class_id, "pothole")
            if isinstance(model.names, dict)
            else "pothole"
        )

        conn.execute("""
            INSERT INTO potholes (
                camera_id, lat, lng, confidence, detection_label,
                image_path, location_source, gps_accuracy, status
            ) VALUES (?, ?, ?, ?, ?, ?, 'user_upload', ?, 'active')
        """, (
            camera_id, lat, lng, round(conf, 4),
            detection_label, image_path, gps_accuracy,
        ))
        stored += 1

    conn.commit()
    conn.close()

    if stored > 0:
        return jsonify({
            "detected": True,
            "message": (
                f"Pothole detected! {stored} detection(s) reported successfully. "
                "Thank you for contributing!"
            ),
            "count": stored,
        })

    return jsonify({
        "detected": False,
        "message": "Detection found but could not be saved. Please try again.",
    })


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    init_public_db()
    log.info("==============================================")
    log.info("  Public Pothole Reporting Site Ready!")
    log.info("  Open: http://127.0.0.1:8080")
    log.info("==============================================")
    app.run(host="0.0.0.0", port=8080, debug=False)
