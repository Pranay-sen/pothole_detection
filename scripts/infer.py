"""
RoadWatch YOLO inference utility
Runs pothole detection using YOLO11s model (model/best.pt)
Usage:
    python scripts/infer.py --image <path_or_url> [--conf 0.25] [--save <out_path>]
"""
import sys
import os
import json
import argparse
import base64
import time
from io import BytesIO

def load_model(model_path):
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Model file not found at {model_path}")
    from ultralytics import YOLO
    return YOLO(model_path)

def run_detection(model, image_input, conf=0.25):
    from PIL import Image
    t0 = time.time()
    
    # Handle base64 input or file path
    if isinstance(image_input, str):
        if image_input.startswith("data:image") or len(image_input) > 500:
            # Base64 string
            if "base64," in image_input:
                image_input = image_input.split("base64,")[1]
            image_data = base64.b64decode(image_input)
            img = Image.open(BytesIO(image_data)).convert("RGB")
        elif os.path.exists(image_input):
            img = Image.open(image_input).convert("RGB")
        else:
            raise FileNotFoundError(f"Image not found: {image_input}")
    else:
        img = image_input

    orig_w, orig_h = img.size
    results = model(img, conf=conf, verbose=False)
    infer_ms = round((time.time() - t0) * 1000, 1)
    
    detections = []
    if results and len(results) > 0:
        res = results[0]
        boxes = res.boxes
        for b in boxes:
            box = [round(float(coord), 1) for coord in b.xyxy[0].tolist()]
            confidence = round(float(b.conf[0].item()), 3)
            cls_idx = int(b.cls[0].item())
            cls_name = model.names.get(cls_idx, "pothole")
            
            # Normalized coordinates [ymin, xmin, ymax, xmax] for UI overlay
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
            
    return {
        "success": True,
        "count": len(detections),
        "inferenceMs": infer_ms,
        "imageWidth": orig_w,
        "imageHeight": orig_h,
        "detections": detections
    }

def main():
    parser = argparse.ArgumentParser(description="RoadWatch Pothole Inference")
    parser.add_argument("--image", required=True, help="Image file path or base64")
    parser.add_argument("--conf", type=float, default=0.25, help="Confidence threshold (default: 0.25)")
    parser.add_argument("--model", default=os.path.join(os.path.dirname(__file__), "..", "model", "best.pt"), help="Path to best.pt")
    
    args = parser.parse_args()
    try:
        model = load_model(args.model)
        result = run_detection(model, args.image, conf=args.conf)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
