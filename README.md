# RoadWatch — Road Damage Detection & Tracking Platform

RoadWatch is a full-stack road intelligence platform integrating computer vision, geospatial mapping, and automated hazard tracking. It detects and catalogs road surface hazards (such as potholes) using a custom-trained **YOLO11s** deep learning model, stores geospatial hazard telemetry in **MongoDB**, and provides a responsive operator workspace with real-time **Leaflet + OpenStreetMap** visualization.

---

## 🏛 Architecture Overview

```
roadwatch/
├── backend/                       # Node.js Express 4.21 API Server
│   ├── src/
│   │   ├── config/db.js           # Mongoose MongoDB connection
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
│   ├── public/samples/            # Sample road damage images for testing
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
│   └── infer_server.py            # Python warm inference HTTP server (Port 5001)
│
├── package.json                   # Root package with npm workspaces (`backend`, `frontend`)
├── run.py                         # Unified cross-platform launcher & setup orchestrator
└── .env.example                   # Environment configuration template
```

---

## Quick start on Windows

Install **Node.js 22 LTS** (including npm) and **64-bit Python 3.10–3.13**. The first run
needs internet access and free disk space for Node packages, Python packages and the
MongoDB runtime.

```powershell
git clone --branch main https://github.com/Pranay-sen/pothole_detection.git
cd pothole_detection
.\runall.bat
```

Open [RoadWatch](http://localhost:5173/) when the API and inference engine are ready.
You can also download the repository ZIP and double-click **runall.bat** in the extracted
folder. To install dependencies ahead of the demo, double-click **setup.bat** first.
On macOS or Linux, use `python3 run.py --setup` and `python3 run.py`.

- Setup runs `npm ci` and prepares a project-local Python environment when the selected
  Python lacks the inference packages. The Windows/Linux bootstrap installs CPU PyTorch.
- Run All starts the frontend, API and YOLO engine on ports 5173, 3000 and 5001.
- The API starts a local MongoDB instance when no URI is configured. It seeds four
  sample reports once and persists reports and photos under `.roadwatch/data/`.
- To use your own MongoDB, set `MONGODB_URI` in `.env` using `.env.example`. Auto-seeding
  is only enabled for the built-in local database.
- The trained `model/best.pt` and sample photos are included in the checkout.
  Upload `frontend/public/samples/pothole_1.jpg` in Live Detection to try the model.
  The training dataset and experiment outputs are not needed to run inference.

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
