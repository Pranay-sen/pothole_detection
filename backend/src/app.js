const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const potholeRoutes = require('./routes/potholeRoutes');
const { notFoundHandler, errorHandler } = require('./middlewares/errorHandler');

const app = express();

// Core Middleware
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));

// Simple Request Logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

// Root & Health check endpoints
app.get('/', (req, res) => {
  res.status(200).json({
    name: 'RoadWatch Pothole Detection & Tracking API',
    version: '1.0.0',
    status: 'Running',
    endpoints: {
      stats: 'GET /api/potholes/stats',
      setPothole: 'POST /api/potholes',
      deletePothole: 'DELETE /api/potholes/:uuid',
      searchArea: 'GET /api/potholes/search?latitude=...&longitude=...&radius=100',
      getAllPotholes: 'GET /api/potholes',
      getPotholeByUuid: 'GET /api/potholes/:uuid',
      updateStatus: 'PATCH /api/potholes/:uuid/status',
      detectPotholes: 'POST /api/detect',
      detectStatus: 'GET /api/detect/status'
    }
  });
});

app.get('/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatusMap = {
    0: 'Disconnected',
    1: 'Connected',
    2: 'Connecting',
    3: 'Disconnecting'
  };

  res.status(200).json({
    status: 'UP',
    database: dbStatusMap[dbState] || 'Unknown',
    timestamp: new Date().toISOString()
  });
});

// Mount Routes
const detectRoutes = require('./routes/detectRoutes');
app.use('/api/potholes', (req, res, next) => {
  if (req.path !== '/stats' && mongoose.connection.readyState !== 1) {
    return res.status(503).json({ success: false, error: { message: 'Database unavailable. Check the MongoDB connection and retry.' } });
  }
  next();
}, potholeRoutes);
app.use('/api/detect', detectRoutes);

// Error Handling Middlewares
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
