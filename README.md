# RoadWatch — Road Damage Detection & Tracking Platform

RoadWatch is a full-stack road intelligence platform integrating computer vision, geospatial mapping, and automated hazard tracking. It detects and catalogs road surface hazards (such as potholes) using a custom-trained **YOLO11s** deep learning model, stores geospatial hazard telemetry in **MongoDB Atlas**, and provides a responsive operator workspace with real-time **Leaflet + OpenStreetMap** visualization.

---

## 🏛 Architecture Overview

```
roadwatch/
├── backend/                       # Node.js Express 4.21 API Server
│   ├── src/
│   │   ├── config/db.js           # Mongoose MongoDB connection & Atlas DNS fallback
│   │   ├── controllers/
│   │   │   ├── potholeController.js # CRUD, stats, and non-destructive status updates
│   │   │   └── detectController.js  # Detection endpoint bridge (warm server + CLI fallback)
│   │   ├── models/Pothole.js      # GeoJSON 2dsphere schema with flexible metadata
│   │   ├── routes/
│   │   │   ├── potholeRoutes.js   # /api/potholes endpoints
│   │   │   └── detectRoutes.js    # /api/detect endpoints
│   │   ├── middlewares/           # Global error handler & 404 router
│   │   ├── app.js                 # Express app setup, CORS, JSON limit (25MB)
│   │   └── server.js              # Server entry point (Port 3000)
│   ├── scripts/seedPotholes.js    # Seed 4 realistic potholes in Bengaluru
│   ├── test/                      # Smoke & integration tests
│   └── package.json
│
├── frontend/                      # Modern Vite Application
│   ├── public/samples/            # Sample road damage images for 1-click testing
│   ├── index.html                 # 7 interactive views (Overview, Detection, Reports, Map, Submit, Admin, Settings)
│   ├── app.js                     # Modular application logic with real API integration
│   ├── styles.css                 # Curated design system (DM Sans + Manrope, dark glassmorphism)
│   ├── vite.config.js             # Vite dev server with proxy to backend
│   └── package.json
│
├── model/                         # ML Model Artifacts
│   └── best.pt                    # Custom-trained YOLO11s weights (Pothole class)
│
├── scripts/
│   ├── dev.js                     # Node.js concurrent dev server launcher
│   ├── infer.py                   # CLI inference utility (PyTorch + Ultralytics)
│   └── infer_server.py            # Zero-dependency Python warm inference HTTP server (Port 5001)
│
├── package.json                   # Root package with npm workspaces (`backend`, `frontend`)
├── run.py                         # Unified cross-platform launcher & setup orchestrator
└── .env.example                   # Environment configuration template
```

---

## 🚀 Quick Start (One Command)

### Prerequisites
- **Node.js**: v18+ and `npm`
- **Python**: 3.10+ with `torch` and `ultralytics` (`pip install torch ultralytics pillow`)

### 1. One-Command Setup
Install all npm workspaces and verify Python ML dependencies:
```bash
python run.py --setup
```
*(Alternatively: `npm install` at root)*

### 2. Start Full-Stack Application
On Windows, double-click **`runall.bat`** or run `.\runall.bat` in PowerShell.
It uses the existing Python launcher and supports an installed Anaconda environment.
See [IMPROVEMENTS.md](IMPROVEMENTS.md) for the enhancement and verification details.

Start the backend, frontend, and warm ML inference engine concurrently:
```bash
python run.py
```
*(Alternatively: `npm run dev` at root)*

### 3. Open in Browser
- **Frontend Workspace**: [http://localhost:5173](http://localhost:5173)
- **Backend API**: [http://localhost:3000](http://localhost:3000)
- **YOLO Inference Engine**: [http://127.0.0.1:5001](http://127.0.0.1:5001)

---

## 🧪 Running Tests

Execute the automated test suite covering route registration, API contracts, and YOLO inference:
```bash
python run.py --test
```
*(Or run individual tests: `npm run test` or `node backend/test/smoke.test.js`)*

---

## 📡 API Reference

### Health & Diagnostics
| Method | Route | Description |
|---|---|---|
| `GET` | `/` | API version and available endpoint directory |
| `GET` | `/health` | Server status and MongoDB connection state |

### Pothole Management (`/api/potholes`)
| Method | Route | Description |
|---|---|---|
| `GET` | `/api/potholes/stats` | Aggregated dashboard metrics (`total`, `open`, `inProgress`, `fixed`, `highSeverity`) |
| `GET` | `/api/potholes` | Paginated list of pothole records (`?page=1&limit=50`) |
| `POST` | `/api/potholes` | Create a new pothole report with GeoJSON location |
| `GET` | `/api/potholes/:uuid` | Retrieve single pothole record by UUID |
| `PATCH`| `/api/potholes/:uuid/status` | Non-destructively update status within `data` object (`open`, `in_progress`, `fixed`) |
| `DELETE`| `/api/potholes/:uuid` | Delete pothole record from database |
| `GET` | `/api/potholes/search` | Geospatial search (`?latitude=...&longitude=...&radius=500`) |

### Machine Learning Inference (`/api/detect`)
| Method | Route | Description |
|---|---|---|
| `GET` | `/api/detect/status` | Model status, loaded weights, and supported classes |
| `POST` | `/api/detect` | Run YOLO11s inference on base64 image or file path (returns bounding boxes, confidence, latency) |

---

## 🤖 YOLO11s Model Details
- **Architecture**: Ultralytics YOLO11s (Single class: `pothole`)
- **Weights File**: `model/best.pt` (18.3 MB)
- **Input Resolution**: 640 × 640 px
- **Inference Latency**: ~100–350 ms on CPU
- **Warm Server**: `scripts/infer_server.py` keeps the model memory-resident for sub-100ms warm inferences without loading overhead.

---

## 🗺 Geospatial & Map Integration
- **Map Provider**: Leaflet 1.9.4 with standard OpenStreetMap tiles (no API keys required).
- **Coordinate System**: GeoJSON `Point` (`[longitude, latitude]`) with MongoDB 2dsphere indexing.
- **Marker Color Coding**:
  - 🔴 **Red**: Critical / High severity
  - 🟠 **Amber**: Medium severity
  - 🟢 **Green**: Low severity
  - ⚪ **Gray**: Fixed / Resolved
