"""
Pothole Detection System — All Servers Launcher
=================================================
Starts BOTH servers in one command:
  • Admin  site  →  http://127.0.0.1:5000  (existing dashboard + /admin map)
  • Public site  →  http://127.0.0.1:8080  (public map + user upload)

Usage:
    python run_all.py
"""

import os
import sys
import subprocess
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def main():
    print()
    print("=" * 58)
    print("  Pothole Detection System — Starting All Servers")
    print("=" * 58)
    print()

    python = sys.executable

    # ── 0. Install requirements ──────────────────────────────
    print("Checking and installing requirements...")
    req_path = os.path.join(BASE_DIR, "requirements.txt")
    if os.path.exists(req_path):
        subprocess.run([python, "-m", "pip", "install", "-r", req_path], cwd=BASE_DIR)
    print()

    # ── 1. Start Admin Server (port 5000) ──────────────────
    print("[1/2] Starting Admin Server on port 5000 ...")
    admin_proc = subprocess.Popen(
        [python, os.path.join(BASE_DIR, "app.py")],
        cwd=BASE_DIR,
    )

    # Small delay so admin initialises DB before public tries
    time.sleep(3)

    # ── 2. Start Public Server (port 8080) ─────────────────
    print("[2/2] Starting Public Server on port 8080 ...")
    public_proc = subprocess.Popen(
        [python, os.path.join(BASE_DIR, "public_app.py")],
        cwd=BASE_DIR,
    )

    print()
    print("=" * 58)
    print("  ADMIN  dashboard : http://127.0.0.1:5000")
    print("  ADMIN  map       : http://127.0.0.1:5000/admin")
    print("  PUBLIC site      : http://127.0.0.1:8080")
    print("=" * 58)
    print()
    print("Press Ctrl+C to stop all servers.")
    print()

    try:
        # Wait for either process to exit
        while True:
            admin_ret = admin_proc.poll()
            public_ret = public_proc.poll()

            if admin_ret is not None:
                print(f"[!] Admin server exited (code {admin_ret})")
                break
            if public_ret is not None:
                print(f"[!] Public server exited (code {public_ret})")
                break

            time.sleep(1)
    except KeyboardInterrupt:
        pass

    print("\nShutting down all servers ...")
    for proc in [admin_proc, public_proc]:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    print("All servers stopped.")


if __name__ == "__main__":
    main()
