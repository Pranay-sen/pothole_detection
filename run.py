#!/usr/bin/env python3
"""
RoadWatch Unified Full-Stack Launcher & Environment Setup
One command to install dependencies, test, and start:
- Node.js Express Backend (Port 3000)
- React/Vite Frontend (Port 5173)
- YOLO11s Inference Engine (Port 5001)

Usage:
    python run.py           # Start all services concurrently
    python run.py --setup   # Install all npm and verify Python dependencies
    python run.py --test    # Run backend smoke & API tests
"""
import os
import sys
import time
import signal
import argparse
import subprocess
import shutil
import socket

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
IS_WINDOWS = sys.platform.startswith('win')

# Ensure UTF-8 output on Windows console
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

CHILD_PROCESSES = []

def print_banner():
    banner = r"""
  +==============================================================+
  |                 ROADWATCH -- FULL-STACK LAUNCHER             |
  |       Road Intelligence & YOLO11s Pothole Detection          |
  +==============================================================+
    """
    print(banner)

def run_command(cmd, cwd=ROOT_DIR, check=True):
    print(f"--> Running: {' '.join(cmd) if isinstance(cmd, list) else cmd} (in {os.path.relpath(cwd, ROOT_DIR) or '.'})")
    shell = IS_WINDOWS and not isinstance(cmd, list)
    return subprocess.run(cmd, cwd=cwd, shell=shell, check=check)

def check_python_environment():
    print("\n🔍 Checking Python ML dependencies...")
    try:
        import torch
        import ultralytics
        from ultralytics import YOLO
        print(f"  ✓ PyTorch: {torch.__version__}")
        print(f"  ✓ Ultralytics: {ultralytics.__version__}")
    except ImportError as e:
        print(f"  ⚠️ Warning: {e}")
        print("  To enable YOLO detection: pip install torch ultralytics pillow")

    model_path = os.path.join(ROOT_DIR, 'model', 'best.pt')
    if os.path.exists(model_path):
        size_mb = os.path.getsize(model_path) / (1024 * 1024)
        print(f"  ✓ Model: {model_path} ({size_mb:.1f} MB) found.")
    else:
        print(f"  ⚠️ Model file not found at {model_path}. Pothole detection will show unavailable.")

def setup_dependencies():
    print_banner()
    print("📦 Setting up RoadWatch dependencies...\n")
    check_python_environment()

    npm_cmd = 'npm.cmd' if IS_WINDOWS else 'npm'
    if not shutil.which(npm_cmd):
        print(f"❌ Error: '{npm_cmd}' not found in PATH. Please install Node.js.")
        sys.exit(1)

    print("\n📦 Running root-level 'npm install' (npm workspaces)...")
    run_command([npm_cmd, 'install'], cwd=ROOT_DIR)

    print("\n🔨 Building frontend assets for validation...")
    run_command([npm_cmd, 'run', 'build:frontend'], cwd=ROOT_DIR)

    print("\n✅ Setup complete! You can now start the application with:")
    print("    python run.py\n")

def run_tests():
    print_banner()
    print("🧪 Running RoadWatch Test Suite...\n")
    npm_cmd = 'npm.cmd' if IS_WINDOWS else 'npm'

    print("1. Route smoke tests and regression tests:")
    run_command(['node', 'test/smoke.test.js'], cwd=os.path.join(ROOT_DIR, 'backend'))
    run_command(['node', '--test', 'test/regressions.test.cjs'], cwd=os.path.join(ROOT_DIR, 'backend'))

    print("\n2. Backend API routes test:")
    run_command(['node', 'test/api.test.js'], cwd=os.path.join(ROOT_DIR, 'backend'))

    print("\n3. Testing YOLO11s model inference:")
    test_img = os.path.join(ROOT_DIR, 'RDD_pothole', 'test', 'images', 'China_Drone_000286.jpg')
    if os.path.exists(test_img):
        run_command([sys.executable, 'scripts/infer.py', '--image', test_img], cwd=ROOT_DIR)

    print("\n🎉 All tests passed successfully!")

def start_child_process(name, cmd, cwd, color_code):
    print(f"  [{name}] Launching: {' '.join(cmd) if isinstance(cmd, list) else cmd}")
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=IS_WINDOWS and isinstance(cmd, str),
        text=True,
        bufsize=1
    )
    CHILD_PROCESSES.append((name, proc))

    import threading
    def stream_output(process, tag, color):
        for line in iter(process.stdout.readline, ''):
            if line:
                line_str = line.rstrip()
                # Filter noisy logs
                print(f"\033[{color}m[{tag}]\033[0m {line_str}")
        process.stdout.close()

    t = threading.Thread(target=stream_output, args=(proc, name, color_code), daemon=True)
    t.start()
    return proc

def shutdown_all(signum=None, frame=None):
    print("\n\n🛑 Shutting down RoadWatch services...")
    for name, proc in CHILD_PROCESSES:
        try:
            if IS_WINDOWS:
                subprocess.run(['taskkill', '/pid', str(proc.pid), '/T', '/F'], capture_output=True)
            else:
                proc.terminate()
        except Exception:
            pass
    print("✓ All services stopped. Goodbye!\n")
    sys.exit(0)

def kill_ports(ports):
    """Check ports without terminating unrelated applications."""
    for port in ports:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.5)
            if probe.connect_ex(('127.0.0.1', port)) == 0:
                raise SystemExit(f'Port {port} is already in use. Stop the existing service before running RoadWatch again.')

def start_services():
    print_banner()
    os.environ.setdefault('PYTHON_EXECUTABLE', sys.executable)

    # Clear any stale processes occupying ports
    print("Checking service ports (3000, 5001, 5173)...")
    kill_ports([3000, 5001, 5173])

    # Check node_modules
    if not os.path.exists(os.path.join(ROOT_DIR, 'node_modules')):
        print("ℹ node_modules not detected. Running initial setup first...\n")
        setup_dependencies()

    npm_cmd = 'npm.cmd' if IS_WINDOWS else 'npm'
    npx_cmd = 'npx.cmd' if IS_WINDOWS else 'npx'

    # Register exit handlers
    signal.signal(signal.SIGINT, shutdown_all)
    signal.signal(signal.SIGTERM, shutdown_all)

    print("\n🚀 Starting RoadWatch Full-Stack Services:\n")

    # 1. Warm YOLO Inference Server (Python on Port 5001)
    infer_server = os.path.join(ROOT_DIR, 'scripts', 'infer_server.py')
    if os.path.exists(infer_server) and os.path.exists(os.path.join(ROOT_DIR, 'model', 'best.pt')):
        start_child_process("YOLO-ML", [sys.executable, infer_server, "5001"], ROOT_DIR, "35")
        time.sleep(1.0)

    # 2. Node.js Express Backend (Port 3000)
    backend_dir = os.path.join(ROOT_DIR, 'backend')
    start_child_process("BACKEND", ['node', 'src/server.js'], backend_dir, "34")
    time.sleep(1.2)

    # 3. Vite Frontend Server (Port 5173)
    frontend_dir = os.path.join(ROOT_DIR, 'frontend')
    vite_script = os.path.join(ROOT_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
    start_child_process("FRONTEND", ['node', vite_script, '--host', '--strictPort', '--port', '5173'], frontend_dir, "32")

    print("\n" + "="*62)
    print("  🌐 ACCESS ROADWATCH IN YOUR BROWSER:")
    print("     Frontend Application:  http://localhost:5173")
    print("     Backend API & Health:  http://localhost:3000")
    print("     YOLO Inference Engine: http://127.0.0.1:5001")
    print("="*62)
    print("\n  Press Ctrl+C at any time to cleanly stop all servers.\n")

    reported_dead = set()
    try:
        while True:
            time.sleep(1)
            for name, proc in CHILD_PROCESSES:
                if proc.poll() is not None and name not in reported_dead:
                    reported_dead.add(name)
                    print(f"⚠️ Service '{name}' exited with code {proc.returncode}")
    except KeyboardInterrupt:
        shutdown_all()

def main():
    parser = argparse.ArgumentParser(description="RoadWatch Rebuild Full-Stack Launcher")
    parser.add_argument('--setup', action='store_true', help='Install dependencies & build frontend')
    parser.add_argument('--test', action='store_true', help='Run test suite')
    args = parser.parse_args()

    if args.setup:
        setup_dependencies()
    elif args.test:
        run_tests()
    else:
        start_services()

if __name__ == '__main__':
    main()
