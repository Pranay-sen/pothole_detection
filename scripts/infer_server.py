"""
RoadWatch YOLO Model Warm Inference HTTP Server
Keeps the YOLO11s model resident in memory for fast sub-100ms inference.
Zero third-party web frameworks needed (uses Python built-in http.server).
Usage:
    python scripts/infer_server.py [--port 5001]
"""
import os
import sys
import json
import base64
import time
from io import BytesIO
from http.server import HTTPServer, BaseHTTPRequestHandler
from PIL import Image
from ultralytics import YOLO

PORT = 5001
MODEL_PATH = os.path.join(os.path.dirname(__file__), "..", "model", "best.pt")
model = None

def get_model():
    global model
    if model is None:
        print(f"Loading YOLO model from {MODEL_PATH}...")
        model = YOLO(MODEL_PATH)
        print("Model loaded into memory successfully.")
    return model

class InferenceHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health' or self.path == '/':
            m = get_model()
            payload = json.dumps({
                "status": "UP",
                "model": "YOLO11s",
                "classes": m.names,
                "target": "pothole"
            }).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == '/detect':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            
            try:
                data = json.loads(body.decode('utf-8'))
                image_data = data.get('image', '')
                conf = float(data.get('confidence', 0.25))

                if not image_data:
                    raise ValueError("Missing 'image' field (base64 string or file path)")

                t0 = time.time()
                if image_data.startswith("data:image") or len(image_data) > 500:
                    if "base64," in image_data:
                        image_data = image_data.split("base64,")[1]
                    raw_bytes = base64.b64decode(image_data)
                    img = Image.open(BytesIO(raw_bytes)).convert("RGB")
                elif os.path.exists(image_data):
                    img = Image.open(image_data).convert("RGB")
                else:
                    raise FileNotFoundError(f"Image not found: {image_data}")

                orig_w, orig_h = img.size
                m = get_model()
                results = m(img, conf=conf, verbose=False)
                infer_ms = round((time.time() - t0) * 1000, 1)

                detections = []
                if results and len(results) > 0:
                    res = results[0]
                    for b in res.boxes:
                        box = [round(float(coord), 1) for coord in b.xyxy[0].tolist()]
                        confidence = round(float(b.conf[0].item()), 3)
                        cls_idx = int(b.cls[0].item())
                        cls_name = m.names.get(cls_idx, "pothole")

                        xmin, ymin, xmax, ymax = box
                        norm_box = [
                            round(ymin / orig_h, 4),
                            round(xmin / orig_w, 4),
                            round(ymax / orig_h, 4),
                            round(xmax / orig_w, 4)
                        ]
                        detections.append({
                            "class": cls_name,
                            "confidence": confidence,
                            "bbox": box,
                            "normalizedBbox": norm_box
                        })

                response = {
                    "success": True,
                    "count": len(detections),
                    "inferenceMs": infer_ms,
                    "imageWidth": orig_w,
                    "imageHeight": orig_h,
                    "detections": detections
                }
                status_code = 200
            except Exception as e:
                response = {"success": False, "error": str(e)}
                status_code = 400

            payload = json.dumps(response).encode('utf-8')
            self.send_response(status_code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        # Concise logging
        sys.stderr.write(f"[infer-server] {args[0]} {args[1]}\n")

def run(port=PORT):
    get_model() # Pre-load model
    server_address = ('127.0.0.1', port)
    httpd = HTTPServer(server_address, InferenceHandler)
    print(f"RoadWatch YOLO inference server running on http://127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping inference server...")
        httpd.server_close()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    run(port)
