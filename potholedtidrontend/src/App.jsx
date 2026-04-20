import { useEffect, useRef, useState } from 'react';
import './App.css';

const DEFAULT_CENTER = [28.6139, 77.209];
const POLL_INTERVAL_MS = 5000;

const BUTTON_GUIDE = [
  ['Connect Phone', 'Phone IP save karta hai aur live GPS / stream test karta hai.'],
  ['Start Detection', 'Background loop har 5 second me frame uthakar model chalata hai.'],
  ['Stop Detection', 'Continuous detection loop pause karta hai.'],
  ['Scan Now', 'Ek manual instant inference run karta hai.'],
  ['Clear Markers', 'Map aur feed se saved pothole rows clear karta hai.'],
];

function formatTimestamp(value) {
  if (!value) {
    return 'Waiting for detections';
  }

  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function getLocationSourceLabel(source) {
  const labels = {
    phone_live: 'Phone live GPS',
    browser_fallback: 'Browser fallback',
    last_known: 'Last known device location',
    camera_static: 'Static CCTV location',
  };

  return labels[source] || source || 'Unknown';
}

function loadLeaflet() {
  if (window.L) {
    return Promise.resolve(window.L);
  }

  return new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-leaflet="true"]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      css.dataset.leaflet = 'true';
      document.head.appendChild(css);
    }

    const existing = document.querySelector('script[data-leaflet="true"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.L), { once: true });
      existing.addEventListener('error', () => reject(new Error('Leaflet failed to load')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.async = true;
    script.dataset.leaflet = 'true';
    script.onload = () => resolve(window.L);
    script.onerror = () => reject(new Error('Leaflet failed to load'));
    document.body.appendChild(script);
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || data.message || `Request failed (${response.status})`);
  }

  return data;
}

function App() {
  const [phoneInput, setPhoneInput] = useState('');
  const [systemStatus, setSystemStatus] = useState('Waiting for phone setup');
  const [isBusy, setIsBusy] = useState(false);
  const [statusData, setStatusData] = useState({
    detection_running: false,
    cameras: 0,
    potholes_detected: 0,
    phone_camera: null,
  });
  const [potholes, setPotholes] = useState([]);
  const [lastRefresh, setLastRefresh] = useState('');
  const [streamStamp, setStreamStamp] = useState(Date.now());
  const [browserLocation, setBrowserLocation] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const mapNodeRef = useRef(null);
  const mapRef = useRef(null);
  const potholeLayerRef = useRef(null);
  const phoneMarkerRef = useRef(null);
  const previewMovedRef = useRef(false);

  const phoneCamera = statusData.phone_camera;
  const shotUrl = phoneCamera ? `/phone_snapshot?t=${streamStamp}` : '';

  useEffect(() => {
    if (!navigator.geolocation) {
      return undefined;
    }

    let watcher;
    const successCb = (position) => {
      setBrowserLocation({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      });
    };
    
    const errorCb = (err) => {
      if (err.code === err.TIMEOUT || err.code === err.POSITION_UNAVAILABLE) {
        navigator.geolocation.clearWatch(watcher);
        watcher = navigator.geolocation.watchPosition(successCb, () => {}, { enableHighAccuracy: false, maximumAge: 10000, timeout: 8000 });
      }
    };

    watcher = navigator.geolocation.watchPosition(successCb, errorCb, { enableHighAccuracy: true, maximumAge: 10000, timeout: 8000 });

    return () => navigator.geolocation.clearWatch(watcher);
  }, []);

  useEffect(() => {
    let cancelled = false;

    loadLeaflet()
      .then((L) => {
        if (cancelled || !mapNodeRef.current || mapRef.current) {
          return;
        }

        const map = L.map(mapNodeRef.current, {
          zoomControl: true,
          preferCanvas: true,
        }).setView(DEFAULT_CENTER, 13);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors',
        }).addTo(map);

        mapRef.current = map;
        potholeLayerRef.current = L.layerGroup().addTo(map);
      })
      .catch((error) => {
        setSystemStatus(error.message);
      });

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let active = true;

    const refresh = async () => {
      try {
        const [status, potholeRows] = await Promise.all([
          fetchJson('/status'),
          fetchJson('/potholes'),
        ]);

        if (!active) {
          return;
        }

        setStatusData(status);
        setPotholes(potholeRows);
        setLastRefresh(new Date().toLocaleTimeString());
        setStreamStamp(Date.now());
        setPreviewError('');

        if (status.phone_camera) {
          const rawIp = status.phone_camera.stream_url
            .replace(/^https?:\/\//, '')
            .replace(/\/video\/?$/, '');
          setPhoneInput((current) => current || rawIp);
        }

        if (!status.phone_camera && potholeRows.length === 0 && !status.detection_running) {
          setSystemStatus('Phone setup pending');
        }
      } catch (error) {
        if (active) {
          setSystemStatus(error.message);
        }
      }
    };

    refresh();
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const L = window.L;
    const map = mapRef.current;
    const layer = potholeLayerRef.current;

    if (!L || !map || !layer) {
      return;
    }

    layer.clearLayers();

    potholes.forEach((pothole) => {
      const marker = L.circleMarker([pothole.lat, pothole.lng], {
        radius: 8,
        color: '#ff6b6b',
        weight: 2,
        fillColor: '#ff2d55',
        fillOpacity: 0.8,
      });

      marker.bindPopup(
        `
          <strong>Pothole #${pothole.id}</strong><br />
          Confidence: ${(pothole.confidence * 100).toFixed(1)}%<br />
          Location: ${pothole.lat.toFixed(6)}, ${pothole.lng.toFixed(6)}<br />
          Time: ${formatTimestamp(pothole.timestamp)}
        `,
      );

      marker.addTo(layer);
    });

    if (phoneCamera) {
      if (!phoneMarkerRef.current) {
        phoneMarkerRef.current = L.circleMarker([phoneCamera.latitude, phoneCamera.longitude], {
          radius: 10,
          color: '#2dd4bf',
          weight: 3,
          fillColor: '#7dd3fc',
          fillOpacity: 0.9,
        }).addTo(map);
        phoneMarkerRef.current.bindPopup('Phone camera live location');
      } else {
        phoneMarkerRef.current.setLatLng([phoneCamera.latitude, phoneCamera.longitude]);
      }

      if (!previewMovedRef.current) {
        map.setView([phoneCamera.latitude, phoneCamera.longitude], 16);
        previewMovedRef.current = true;
      }
    } else if (phoneMarkerRef.current) {
      map.removeLayer(phoneMarkerRef.current);
      phoneMarkerRef.current = null;
      previewMovedRef.current = false;
    }
  }, [potholes, phoneCamera]);

  useEffect(() => {
    if (mapRef.current && browserLocation && !phoneCamera && !previewMovedRef.current) {
      mapRef.current.setView([browserLocation.lat, browserLocation.lng], 15);
    }
  }, [browserLocation, phoneCamera]);

  async function connectPhone() {
    if (!phoneInput.trim()) {
      setSystemStatus('Enter your phone IP or full IP Webcam URL');
      return;
    }

    setIsBusy(true);
    try {
      const payload = {
        ip: phoneInput.trim(),
      };

      if (browserLocation) {
        payload.browser_lat = browserLocation.lat;
        payload.browser_lng = browserLocation.lng;
      }

      const result = await fetchJson('/setup_phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      setSystemStatus(
        result.gps_live
          ? `Phone connected. Live GPS locked at ${result.lat.toFixed(6)}, ${result.lng.toFixed(6)}`
          : `Phone connected using ${getLocationSourceLabel(result.location_source)} until phone GPS becomes available.`,
      );

      setStatusData((current) => ({
        ...current,
        detection_running: true,
        phone_camera: {
          id: current.phone_camera?.id ?? 0,
          name: 'Phone Camera',
          latitude: result.lat,
          longitude: result.lng,
          stream_url: result.stream_url,
          location_source: result.location_source,
          gps_accuracy: result.gps_accuracy,
        },
      }));
    } catch (error) {
      setSystemStatus(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function startDetection() {
    setIsBusy(true);
    try {
      const result = await fetchJson('/start', { method: 'POST' });
      setSystemStatus(result.message);
      setStatusData((current) => ({ ...current, detection_running: true }));
    } catch (error) {
      setSystemStatus(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function stopDetection() {
    setIsBusy(true);
    try {
      const result = await fetchJson('/stop', { method: 'POST' });
      setSystemStatus(result.message);
      setStatusData((current) => ({ ...current, detection_running: false }));
    } catch (error) {
      setSystemStatus(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function runInstantScan() {
    setIsBusy(true);
    try {
      const result = await fetchJson('/detect', { method: 'POST' });
      setSystemStatus(result.message);
    } catch (error) {
      setSystemStatus(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function clearPotholes() {
    setIsBusy(true);
    try {
      const result = await fetchJson('/clear_potholes', { method: 'POST' });
      setPotholes([]);
      setSystemStatus(result.message);
    } catch (error) {
      setSystemStatus(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <div className="glow glow-a" />
      <div className="glow glow-b" />

      <header className="hero-card">
        <div>
          <p className="eyebrow">Pothole Detection Control Room</p>
          <h1>Phone camera, live GPS, and real-time road anomaly mapping.</h1>
          <p className="hero-copy">
            Connect your Android IP Webcam stream, let YOLOv8 inspect fresh frames every few
            seconds, and drop markers on the map using the phone&apos;s current location.
          </p>
        </div>

        <div className="stats-grid">
          <div className="stat-card">
            <span>Cameras</span>
            <strong>{statusData.cameras}</strong>
          </div>
          <div className="stat-card">
            <span>Potholes</span>
            <strong>{statusData.potholes_detected}</strong>
          </div>
              <div className="stat-card">
                <span>Detection</span>
                <strong>{statusData.detection_running ? 'Running' : 'Stopped'}</strong>
              </div>
              <div className="stat-card">
                <span>Model</span>
                <strong>{statusData.model_file || 'best.pt'}</strong>
              </div>
        </div>
      </header>

      <main className="dashboard-grid">
        <section className="panel control-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Phone Setup</p>
              <h2>Connect IP Webcam</h2>
            </div>
            <span className={`status-pill ${statusData.detection_running ? 'online' : 'offline'}`}>
              {statusData.detection_running ? 'Live' : 'Idle'}
            </span>
          </div>

          <label className="input-group">
            <span>Phone IP or URL</span>
            <input
              type="text"
              placeholder="192.168.1.8 or http://192.168.1.8:8080/video"
              value={phoneInput}
              onChange={(event) => setPhoneInput(event.target.value)}
            />
          </label>

          <div className="button-grid">
            <button onClick={connectPhone} disabled={isBusy}>
              Connect Phone
            </button>
            <button className="secondary" onClick={startDetection} disabled={isBusy}>
              Start Detection
            </button>
            <button className="secondary" onClick={stopDetection} disabled={isBusy}>
              Stop Detection
            </button>
            <button className="ghost" onClick={runInstantScan} disabled={isBusy}>
              Scan Now
            </button>
            <button className="ghost danger" onClick={clearPotholes} disabled={isBusy}>
              Clear Markers
            </button>
          </div>

          <div className="status-box">
            <strong>System status</strong>
            <p>{systemStatus}</p>
            <small>Last refresh: {lastRefresh || 'Fetching...'}</small>
          </div>

          <div className="info-grid">
            <div>
              <span>Phone stream</span>
              <strong>{phoneCamera?.stream_url || 'Not connected yet'}</strong>
            </div>
            <div>
              <span>Live location</span>
              <strong>
                {phoneCamera
                  ? `${phoneCamera.latitude.toFixed(6)}, ${phoneCamera.longitude.toFixed(6)}`
                  : 'Waiting for GPS'}
              </strong>
            </div>
            <div>
              <span>Location source</span>
              <strong>{getLocationSourceLabel(phoneCamera?.location_source)}</strong>
            </div>
            <div>
              <span>GPS accuracy</span>
              <strong>
                {phoneCamera?.gps_accuracy
                  ? `${Number(phoneCamera.gps_accuracy).toFixed(1)} m`
                  : browserLocation?.accuracy
                    ? `Browser approx ${browserLocation.accuracy.toFixed(1)} m`
                    : 'Not reported'}
              </strong>
            </div>
          </div>

          <div className="button-guide">
            {BUTTON_GUIDE.map(([title, text]) => (
              <article key={title}>
                <strong>{title}</strong>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel preview-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Camera Preview</p>
              <h2>Latest phone frame</h2>
            </div>
          </div>

          <div className="preview-frame">
            {shotUrl ? (
              <img
                src={shotUrl}
                alt="Phone camera preview"
                onError={() => setPreviewError('Phone preview unavailable. Check IP Webcam app or reconnect the phone.')}
              />
            ) : (
              <div className="preview-placeholder">
                Start the IP Webcam app on your phone, then connect it here.
              </div>
            )}
          </div>
          {previewError ? <p className="preview-error">{previewError}</p> : null}
        </section>

        <section className="panel map-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Live Map</p>
              <h2>Detected potholes and current phone position</h2>
            </div>
          </div>
          <div className="map-canvas" ref={mapNodeRef} />
        </section>

        <section className="panel detections-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Detection Feed</p>
              <h2>Recent potholes</h2>
            </div>
          </div>

          <div className="plugin-link-box">
            <span>Online plugin/feed</span>
            <a href="/plugin/live-feed.json" target="_blank" rel="noreferrer">
              Open live JSON feed
            </a>
          </div>

          <div className="detection-list">
            {potholes.length === 0 ? (
              <div className="empty-state">
                No potholes stored yet. Point the phone at a pothole and keep detection running.
              </div>
            ) : (
              potholes.slice(0, 8).map((pothole) => (
                <article className="detection-item" key={pothole.id}>
                  {pothole.image_path ? (
                    <img
                      className="detection-thumb"
                      src={pothole.image_path}
                      alt={`Pothole ${pothole.id}`}
                    />
                  ) : null}
                  <div>
                    <strong>Pothole #{pothole.id}</strong>
                    <p>{formatTimestamp(pothole.timestamp)}</p>
                    <p>{pothole.camera_name || 'Unknown source'}</p>
                  </div>
                  <div className="detection-meta">
                    <span>{(pothole.confidence * 100).toFixed(1)}% model match</span>
                    <small>
                      {pothole.lat.toFixed(6)}, {pothole.lng.toFixed(6)}
                    </small>
                    <small>{pothole.detection_label || 'pothole'}</small>
                    <small>{getLocationSourceLabel(pothole.location_source)}</small>
                    <small>
                      {pothole.gps_accuracy
                        ? `GPS accuracy ${Number(pothole.gps_accuracy).toFixed(1)} m`
                        : 'GPS accuracy not reported'}
                    </small>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
