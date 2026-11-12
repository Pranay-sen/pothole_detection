# Pothole Tracking & Detection Backend

A production-ready Node.js & Express REST API powered by MongoDB Atlas for storing, deleting, and geospatially querying road potholes.

---

## 📁 Project Structure

```text
potholeBackend/
├── .env                  # Environment variables (MONGODB_URL / MONGODB_URI, PORT)
├── .env.example          # Sample environment configuration template
├── .gitignore            # Git ignore file (node_modules, .env, logs)
├── package.json          # Node dependencies & npm scripts (start, dev, seed, test)
├── README.md             # Complete API documentation & usage guide
├── scripts/
│   └── seedPotholes.js   # Script to populate MongoDB Atlas with 4 sample potholes
├── src/
│   ├── app.js            # Express application setup & middleware
│   ├── server.js         # Server entrypoint and DB initialization
│   ├── config/
│   │   └── db.js         # Mongoose MongoDB connection handler (Atlas DNS fallback)
│   ├── controllers/
│   │   └── potholeController.js # Handlers for Set, Delete, Search & List
│   ├── middlewares/
│   │   └── errorHandler.js      # 404 and global error handling
│   ├── models/
│   │   └── Pothole.js    # Mongoose schema with GeoJSON 2dsphere index
│   └── routes/
│       └── potholeRoutes.js # Express router endpoints
└── test/
    ├── integration.test.js # End-to-end CRUD and Geospatial search test
    └── smoke.test.js       # Route verification smoke test
```

---

## 📍 Saved Sample Potholes in MongoDB Atlas

Four sample potholes have been saved into your MongoDB database (`Raksha` / `pothole_db` on Atlas).

### Summary Table

| UUID | Type | Latitude | Longitude | Road / Locality | Severity | Priority | Status |
|---|---|---|---|---|---|---|---|
| `pothole-blr-001` | `deep_crater` | `12.9752` | `77.6094` | MG Road, Central Business District | Critical | High | Verified |
| `pothole-blr-002` | `surface_pothole` | `12.9719` | `77.6412` | 100ft Road, Indiranagar | Medium | Medium | Pending Inspection |
| `pothole-blr-003` | `edge_break` | `12.9352` | `77.6245` | 80ft Road, Koramangala 4th Block | Low | Low | Scheduled |
| `pothole-blr-004` | `manhole_subsidence` | `12.9279` | `77.6805` | Outer Ring Road, Bellandur | High | Immediate Repair | In Progress |

---

### Detailed Saved Payloads

#### 1. Pothole `pothole-blr-001`
```json
{
  "uuid": "pothole-blr-001",
  "type": "deep_crater",
  "coordinate": {
    "latitude": 12.9752,
    "longitude": 77.6094
  },
  "location": {
    "type": "Point",
    "coordinates": [77.6094, 12.9752]
  },
  "data": {
    "roadName": "MG Road",
    "locality": "Central Business District",
    "city": "Bengaluru",
    "severity": "critical",
    "depthCm": 18,
    "widthCm": 65,
    "surfaceCondition": "wet_asphalt",
    "reportedBy": "sensor_car_42",
    "priority": "high",
    "status": "verified"
  }
}
```

#### 2. Pothole `pothole-blr-002`
```json
{
  "uuid": "pothole-blr-002",
  "type": "surface_pothole",
  "coordinate": {
    "latitude": 12.9719,
    "longitude": 77.6412
  },
  "location": {
    "type": "Point",
    "coordinates": [77.6412, 12.9719]
  },
  "data": {
    "roadName": "100ft Road",
    "locality": "Indiranagar",
    "city": "Bengaluru",
    "severity": "medium",
    "depthCm": 8,
    "widthCm": 35,
    "surfaceCondition": "dry_asphalt",
    "reportedBy": "citizen_mobile_app_88",
    "priority": "medium",
    "status": "pending_inspection"
  }
}
```

#### 3. Pothole `pothole-blr-003`
```json
{
  "uuid": "pothole-blr-003",
  "type": "edge_break",
  "coordinate": {
    "latitude": 12.9352,
    "longitude": 77.6245
  },
  "location": {
    "type": "Point",
    "coordinates": [77.6245, 12.9352]
  },
  "data": {
    "roadName": "80ft Road",
    "locality": "Koramangala 4th Block",
    "city": "Bengaluru",
    "severity": "low",
    "depthCm": 5,
    "widthCm": 25,
    "surfaceCondition": "broken_curb_edge",
    "reportedBy": "inspection_drone_07",
    "priority": "low",
    "status": "scheduled"
  }
}
```

#### 4. Pothole `pothole-blr-004`
```json
{
  "uuid": "pothole-blr-004",
  "type": "manhole_subsidence",
  "coordinate": {
    "latitude": 12.9279,
    "longitude": 77.6805
  },
  "location": {
    "type": "Point",
    "coordinates": [77.6805, 12.9279]
  },
  "data": {
    "roadName": "Outer Ring Road (near Bellandur EcoSpace)",
    "locality": "Bellandur",
    "city": "Bengaluru",
    "severity": "high",
    "depthCm": 14,
    "widthCm": 55,
    "surfaceCondition": "collapsed_manhole_surround",
    "reportedBy": "traffic_patrol_15",
    "priority": "immediate_repair",
    "status": "in_progress"
  }
}
```

---

## ⚙️ Setup & Installation

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment (`.env`)
Make sure your `.env` contains your MongoDB Atlas connection string:
```env
PORT=5000
MONGODB_URL=mongodb+srv://<username>:<password>@cluster0.ioyyzrw.mongodb.net/Raksha?appName=Cluster0
```

### 3. Re-seed Sample Data Anytime
```bash
npm run seed
```

### 4. Run the Server

**Development Mode (auto-restart with nodemon):**
```bash
npm run dev
```

**Production Mode:**
```bash
npm start
```

---

## 🚀 API Endpoints

### 1. Set Pothole (Create or Update)
Creates a new pothole record or updates an existing one if the `uuid` already exists.

- **URL:** `POST /api/potholes`
- **Headers:** `Content-Type: application/json`
- **Body Parameters:**
  - `uuid` *(string, optional)*: Unique identifier. Automatically generated if omitted.
  - `type` *(string, required)*: Category of pothole (e.g. `"deep_crater"`, `"surface_pothole"`, `"edge_break"`).
  - `coordinate` *(object or array, required)*:
    - As object: `{"latitude": 12.9752, "longitude": 77.6094}` (or `{"lat": ..., "lng": ...}`)
    - As array: `[12.9752, 77.6094]`
  - `data` *(object / mixed, optional)*: Any additional metadata, e.g. depth, width, photos, reportedBy, status.

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/potholes \
  -H "Content-Type: application/json" \
  -d '{
    "uuid": "pothole-custom-005",
    "type": "deep_crater",
    "coordinate": {
      "latitude": 12.9752,
      "longitude": 77.6094
    },
    "data": {
      "severity": "high",
      "depthCm": 15,
      "reportedBy": "mobile_app"
    }
  }'
```

---

### 2. Delete Pothole
Removes a pothole from MongoDB using its unique identifier (`uuid`).

- **URL:** `DELETE /api/potholes/:uuid` *(or `DELETE /api/potholes` with `uuid` in body/query)*

**Example Request:**
```bash
curl -X DELETE http://localhost:3000/api/potholes/pothole-blr-001
```

---

### 3. Search API: Check Area for Potholes
Determines whether a given area has potholes based on coordinates and a search radius using MongoDB's `$near` 2dsphere geospatial index.

- **URL:** `GET /api/potholes/search` *(also supports `POST /api/potholes/search`)*
- **Query Parameters:**
  - `latitude` *(number, required)*: Center latitude (-90 to 90)
  - `longitude` *(number, required)*: Center longitude (-180 to 180)
  - `radius` *(number, optional)*: Search radius in meters (default: `100`m)
  - `limit` *(number, optional)*: Max results to return (default: `50`)

#### Quick Test: Search near MG Road (`pothole-blr-001` within 200m)
```bash
curl "http://localhost:3000/api/potholes/search?latitude=12.9752&longitude=77.6094&radius=200"
```

**Response (Pothole Detected):**
```json
{
  "success": true,
  "hasPothole": true,
  "count": 1,
  "searchArea": {
    "center": {
      "latitude": 12.9752,
      "longitude": 77.6094
    },
    "radiusMeters": 200
  },
  "message": "Found 1 pothole(s) in this area within 200m.",
  "potholes": [
    {
      "uuid": "pothole-blr-001",
      "type": "deep_crater",
      "coordinate": {
        "latitude": 12.9752,
        "longitude": 77.6094
      },
      "data": {
        "roadName": "MG Road",
        "severity": "critical",
        "depthCm": 18
      }
    }
  ]
}
```

#### Quick Test: Search an area with No Potholes
```bash
curl "http://localhost:3000/api/potholes/search?latitude=13.1000&longitude=77.5000&radius=200"
```

**Response (Clear Area):**
```json
{
  "success": true,
  "hasPothole": false,
  "count": 0,
  "searchArea": {
    "center": {
      "latitude": 13.1,
      "longitude": 77.5
    },
    "radiusMeters": 200
  },
  "message": "No potholes found in this area within 200m.",
  "potholes": []
}
```

---

### Additional Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | API status and endpoint directory |
| `GET` | `/health` | Server and MongoDB connection health check |
| `GET` | `/api/potholes` | Get all registered potholes (supports `?page=1&limit=50`) |
| `GET` | `/api/potholes/:uuid` | Get a specific pothole by its `uuid` |

---

## 🧪 Testing & Verification

Run the automated integration test:
```bash
node test/integration.test.js
```
