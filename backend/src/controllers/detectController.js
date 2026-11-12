const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const MODEL_PATH = path.resolve(__dirname, '../../../model/best.pt');
const INFER_SCRIPT = path.resolve(__dirname, '../../../scripts/infer.py');

/**
 * Normalize IP Camera URL to an actual snapshot endpoint
 * Handles:
 * - http://10.12.4.147:8080 -> http://10.12.4.147:8080/shot.jpg
 * - 10.12.4.147:8080 -> http://10.12.4.147:8080/shot.jpg
 * - http://10.12.4.147:8080/video -> http://10.12.4.147:8080/shot.jpg (for snapshots)
 * - http://10.12.4.147:4747 -> http://10.12.4.147:4747/cam/1/frame.jpg (DroidCam)
 */
function normalizeIpcamUrl(rawUrl) {
  if (!rawUrl) return '';
  let url = rawUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
  }
  try {
    const parsed = new URL(url);
    const p = parsed.pathname.toLowerCase();
    if (p === '/' || p === '' || p === '/video' || p === '/videofeed') {
      if (parsed.port === '4747') {
        parsed.pathname = '/cam/1/frame.jpg';
      } else {
        parsed.pathname = '/shot.jpg';
      }
    }
    return parsed.toString();
  } catch (e) {
    return url;
  }
}

/**
 * Fetch a remote image buffer from an IP Webcam / network camera URL
 */
function fetchRemoteImage(targetUrl) {
  const normUrl = normalizeIpcamUrl(targetUrl);
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(normUrl);
      const client = parsed.protocol === 'https:' ? https : http;

      const req = client.get(normUrl, { timeout: 6000 }, (res) => {
        // Handle redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchRemoteImage(res.headers.location));
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`IP camera returned HTTP status ${res.statusCode} at ${normUrl}`));
        }

        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          // Check if returned data is HTML web page instead of image
          const startStr = buffer.slice(0, 80).toString('utf8').toLowerCase();
          if (startStr.includes('<!doctype') || startStr.includes('<html')) {
            if (!normUrl.includes('/shot.jpg')) {
              const retryUrl = normUrl.replace(/\/+$/, '') + '/shot.jpg';
              return resolve(fetchRemoteImage(retryUrl));
            }
            return reject(new Error(`IP camera URL returned a web page instead of image. Make sure IP Webcam is streaming.`));
          }
          resolve(buffer);
        });
      });

      req.on('error', err => reject(new Error(`Cannot connect to IP camera at ${normUrl} (${err.message}). Is phone on same WiFi?`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Connection to IP camera timed out at ${normUrl}. Check phone IP and WiFi.`));
      });
    } catch (e) {
      reject(new Error(`Invalid IP camera URL: ${e.message}`));
    }
  });
}

/**
 * Helper to call warm inference server on 127.0.0.1:5001
 */
function callWarmServer(image, confidence) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ image, confidence });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 5001,
        path: '/detect',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 8000
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            resolve(data);
          } catch (e) {
            reject(new Error(`Invalid JSON from warm infer server: ${raw}`));
          }
        });
      }
    );

    req.on('error', err => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Warm inference server timed out'));
    });
    req.write(postData);
    req.end();
  });
}

/**
 * Fallback: Call python scripts/infer.py CLI
 */
function callCliInference(image, confidence) {
  return new Promise((resolve, reject) => {
    let tempFile = null;
    let imageArg = image;

    if (image.startsWith('data:image') || image.length > 500) {
      const ext = image.includes('image/png') ? '.png' : '.jpg';
      tempFile = path.resolve(__dirname, `../../../scripts/temp_${Date.now()}${ext}`);
      const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(tempFile, Buffer.from(base64Data, 'base64'));
      imageArg = tempFile;
    }

    const args = [INFER_SCRIPT, '--image', imageArg, '--conf', String(confidence || 0.25)];
    execFile(process.env.PYTHON_EXECUTABLE || 'python', args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (tempFile && fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch (e) { /* ignore */ }
      }

      if (error) {
        return reject(new Error(`Inference CLI failed: ${stderr || error.message}`));
      }

      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch (e) {
        reject(new Error(`Failed to parse CLI output: ${stdout}`));
      }
    });
  });
}

/**
 * @desc    Run YOLO pothole detection on an image or live IP webcam URL
 * @route   POST /api/detect
 * @body    { image?: "<base64>", ipcamUrl?: "http://...", confidence?: 0.25 }
 */
const detectPotholes = async (req, res, next) => {
  try {
    let { image, ipcamUrl, confidence = 0.25 } = req.body;
    if ((image !== undefined && typeof image !== 'string') ||
        (ipcamUrl !== undefined && typeof ipcamUrl !== 'string') ||
        typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return res.status(400).json({ success: false, error: { message: 'Image and camera URL must be strings; confidence must be a number between 0 and 1.' } });
    }

    let capturedBase64 = null;
    if (ipcamUrl) {
      try {
        const buffer = await fetchRemoteImage(ipcamUrl);
        capturedBase64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
        image = capturedBase64;
      } catch (ipErr) {
        return res.status(400).json({
          success: false,
          error: { message: `IP Webcam capture error: ${ipErr.message}` }
        });
      }
    }

    if (!image) {
      return res.status(400).json({
        success: false,
        error: { message: "Field 'image' or 'ipcamUrl' is required" }
      });
    }

    if (!fs.existsSync(MODEL_PATH)) {
      return res.status(503).json({
        success: false,
        error: { message: "Model file 'model/best.pt' is not available on server" }
      });
    }

    let result;
    try {
      result = await callWarmServer(image, confidence);
    } catch (warmErr) {
      result = await callCliInference(image, confidence);
    }

    if (capturedBase64 && result.success) {
      result.frame = capturedBase64;
    }

    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Proxy snapshot frame from IP camera to bypass browser CORS
 * @route   GET /api/detect/ipcam-frame?url=http://...
 */
const proxyIpcamFrame = async (req, res, next) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) {
      return res.status(400).json({ success: false, error: "Query parameter 'url' is required" });
    }

    const buffer = await fetchRemoteImage(targetUrl);
    res.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    res.status(200).send(buffer);
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Get detection engine status
 * @route   GET /api/detect/status
 */
const getDetectStatus = (req, res) => {
  const modelExists = fs.existsSync(MODEL_PATH);
  let modelSize = 0;
  if (modelExists) {
    modelSize = fs.statSync(MODEL_PATH).size;
  }

  res.status(200).json({
    success: true,
    model: {
      name: 'YOLO11s (Pothole Detection)',
      file: 'model/best.pt',
      available: modelExists,
      sizeBytes: modelSize,
      classes: ['pothole'],
      engine: 'PyTorch / Ultralytics'
    }
  });
};

module.exports = {
  detectPotholes,
  proxyIpcamFrame,
  getDetectStatus,
  normalizeIpcamUrl
};
