const express = require('express');
const router = express.Router();
const { detectPotholes, getDetectStatus, proxyIpcamFrame } = require('../controllers/detectController');

// Status route
router.get('/status', getDetectStatus);

// IP Webcam Frame Proxy route
router.get('/ipcam-frame', proxyIpcamFrame);

// Detection route (accepts { image } or { ipcamUrl })
router.post('/', detectPotholes);

module.exports = router;
