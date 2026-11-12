"""Install and run RoadWatch from a fresh clone."""
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
WINDOWS = os.name == "nt"
STATE = ROOT / ".roadwatch"
VENV_PYTHON = ROOT / ".venv" / ("Scripts/python.exe" if WINDOWS else "bin/python")
MODEL = ROOT / "model" / "best.pt"
SAMPLE = ROOT / "frontend" / "public" / "samples" / "pothole_1.jpg"
ML_IMPORTS = ("torch", "torchvision", "ultralytics", "PIL")


def run(*command):
    subprocess.run(command, cwd=ROOT, check=True)


def ensure_dependencies():
    npm = shutil.which("npm.cmd" if WINDOWS else "npm")
    node = shutil.which("node")
    if not npm or not node:
        raise SystemExit("Install Node.js 22 LTS, then run setup again.")
    if not MODEL.is_file() or MODEL.stat().st_size < 1_000_000:
        raise SystemExit("Missing model/best.pt. Clone or download the main branch from GitHub.")

    STATE.mkdir(exist_ok=True)
    config = STATE / "ultralytics"
    config.mkdir(exist_ok=True)
    os.environ.setdefault("YOLO_CONFIG_DIR", str(config))
    lock = (ROOT / "package-lock.json").read_bytes()
    stamp = STATE / "npm-lock"
    if not (ROOT / "node_modules/mongodb-memory-server-core/package.json").is_file() or not stamp.exists() or stamp.read_bytes() != lock:
        print("Installing Node dependencies...", flush=True)
        run(npm, "ci", "--no-audit", "--no-fund")
        stamp.write_bytes(lock)

    if all(importlib.util.find_spec(name) for name in ML_IMPORTS):
        return sys.executable

    if not VENV_PYTHON.exists():
        if not (3, 10) <= sys.version_info[:2] <= (3, 13):
            raise SystemExit("Install 64-bit Python 3.10 through 3.13, then run setup again.")
        run(sys.executable, "-m", "venv", str(ROOT / ".venv"))

    python = str(VENV_PYTHON)
    if subprocess.run([python, "-c", "import torch, torchvision, ultralytics, PIL"], capture_output=True).returncode:
        print("Installing CPU inference dependencies...", flush=True)
        if WINDOWS or sys.platform.startswith("linux"):
            run(python, "-m", "pip", "install", "torch==2.7.1", "torchvision==0.22.1",
                "--index-url", "https://download.pytorch.org/whl/cpu")
        run(python, "-m", "pip", "install", "-r", str(ROOT / "requirements.txt"))
    return python


def check_ports():
    for port in (3000, 5001, 5173):
        with socket.socket() as probe:
            probe.settimeout(0.5)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                raise SystemExit(f"Port {port} is in use. Stop that service and run RoadWatch again.")


def start_services(python):
    check_ports()
    env = {**os.environ, "PYTHON_EXECUTABLE": python}
    commands = [
        ("backend", ["node", "scripts/start-local-backend.js"], ROOT),
        ("inference", [python, "-u", "scripts/infer_server.py", "5001"], ROOT),
        ("frontend", ["node", str(ROOT / "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1"], ROOT / "frontend"),
    ]
    processes = []
    try:
        for name, command, cwd in commands:
            processes.append((name, subprocess.Popen(command, cwd=cwd, env=env)))
        print("Open http://localhost:5173 after the API and model are ready. Press Ctrl+C to stop.", flush=True)
        while True:
            for name, process in processes:
                if process.poll() is not None:
                    raise SystemExit(f"RoadWatch {name} exited ({process.returncode}). Check the output above.")
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for _, process in processes:
            if process.poll() is None:
                process.terminate()
        for _, process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--setup", action="store_true", help="Install dependencies and prepare MongoDB")
    mode.add_argument("--test", action="store_true", help="Run API tests and inference on a bundled sample")
    args = parser.parse_args()

    python = ensure_dependencies()
    if args.setup:
        run("node", "scripts/start-local-backend.js", "--setup")
        run(shutil.which("npm.cmd" if WINDOWS else "npm"), "run", "build:frontend")
        print("Setup complete. Run runall.bat to start RoadWatch.")
    elif args.test:
        run(shutil.which("npm.cmd" if WINDOWS else "npm"), "test")
        run(python, "scripts/infer.py", "--image", str(SAMPLE))
    else:
        start_services(python)


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"RoadWatch setup failed: {error}") from None
