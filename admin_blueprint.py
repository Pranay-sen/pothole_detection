"""
Admin Blueprint — Pothole Management Features
===============================================
Adds /admin map page with "Mark as Fixed" capability.
Adds /remove_pothole/<id> and /restore_pothole/<id> APIs.
Does NOT touch existing React frontend or any existing routes.
"""

import os
import sqlite3
import threading

from flask import Blueprint, request, jsonify, send_from_directory

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "database.db")
ADMIN_SITE_DIR = os.path.join(BASE_DIR, "admin_site")

# ---------------------------------------------------------------------------
# Blueprint
# ---------------------------------------------------------------------------
admin_bp = Blueprint("admin", __name__)


# ---------------------------------------------------------------------------
# Database helpers (independent — no imports from app.py)
# ---------------------------------------------------------------------------
def _get_conn():
    """Return a new thread-safe connection to the shared database."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_admin_db():
    """
    Add the 'status' column to potholes if it doesn't exist yet.
    Backfill existing rows to 'active'.
    """
    conn = _get_conn()
    existing = conn.execute("PRAGMA table_info(potholes)").fetchall()
    known_names = {row["name"] for row in existing}
    if "status" not in known_names:
        conn.execute("ALTER TABLE potholes ADD COLUMN status TEXT DEFAULT 'active'")
    # Backfill NULL → 'active'
    conn.execute("UPDATE potholes SET status = 'active' WHERE status IS NULL")
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Routes — Admin pages
# ---------------------------------------------------------------------------
@admin_bp.route("/admin")
def admin_page():
    """Serve the standalone admin map page."""
    return send_from_directory(ADMIN_SITE_DIR, "index.html", max_age=0)


@admin_bp.route("/admin_site/<path:filename>")
def serve_admin_static(filename):
    """Serve CSS / JS for the admin map page."""
    return send_from_directory(ADMIN_SITE_DIR, filename)


# ---------------------------------------------------------------------------
# Routes — Pothole management APIs
# ---------------------------------------------------------------------------
@admin_bp.route("/admin/potholes", methods=["GET"])
def admin_potholes():
    """Return all potholes INCLUDING the status field."""
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
            p.gps_accuracy,
            p.status
        FROM potholes p
        LEFT JOIN cameras c ON c.id = p.camera_id
        ORDER BY p.timestamp DESC
    """).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@admin_bp.route("/remove_pothole/<int:pothole_id>", methods=["POST"])
def remove_pothole(pothole_id):
    """Mark a pothole as fixed (soft delete — keeps DB record)."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT id FROM potholes WHERE id = ?", (pothole_id,)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "Pothole not found"}), 404
    conn.execute(
        "UPDATE potholes SET status = 'fixed' WHERE id = ?", (pothole_id,)
    )
    conn.commit()
    conn.close()
    return jsonify({
        "status": "ok",
        "message": f"Pothole #{pothole_id} marked as fixed. CCTV detection remains active.",
    })


@admin_bp.route("/restore_pothole/<int:pothole_id>", methods=["POST"])
def restore_pothole(pothole_id):
    """Restore a previously-fixed pothole back to active."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT id FROM potholes WHERE id = ?", (pothole_id,)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "Pothole not found"}), 404
    conn.execute(
        "UPDATE potholes SET status = 'active' WHERE id = ?", (pothole_id,)
    )
    conn.commit()
    conn.close()
    return jsonify({
        "status": "ok",
        "message": f"Pothole #{pothole_id} restored to active.",
    })
