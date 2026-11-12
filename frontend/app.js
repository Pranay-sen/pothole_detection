'use strict';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// State management (strictly real backend data)
let reports = [];
let stats = { total: 0, open: 0, inProgress: 0, fixed: 0 };
let activeReportId = null;
let dashboardMap = null;
let explorerMap = null;
let submitMiniMap = null;
let submitMarker = null;
let userLocationMarker = null;
let currentUserCoords = null;
let dashboardMarkers = [];
let explorerMarkers = [];
let reportPage = 1;
const REPORT_PAGE_SIZE = 20;
let reportsLoading = false;
let reportsError = '';
let reportsRequest = null;
let modalTrigger = null;
let nearbyReportIds = null;
let submitLocationVersion = 0;

// Bound API waits so unavailable services never leave the interface stuck.
function apiFetch(url, options = {}) {
  return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(30000) });
}

function savePreferences() {
  try {
    localStorage.setItem('roadwatch.preferences', JSON.stringify({
      compact: $('#compactToggle').checked, banner: $('#bannerToggle').checked
    }));
  } catch { /* Preferences remain usable when browser storage is disabled. */ }
}

function restorePreferences() {
  try {
    const preferences = JSON.parse(localStorage.getItem('roadwatch.preferences') || '{}');
    $('#compactToggle').checked = preferences.compact === true;
    $('#bannerToggle').checked = preferences.banner !== false;
    document.body.classList.toggle('compact-mode', preferences.compact === true);
    $('#statusBanner').classList.toggle('hidden', preferences.banner === false);
  } catch { /* Use the defaults for invalid or unavailable storage. */ }
}

function syncNavigationAccess() {
  const mobile = window.matchMedia('(max-width: 960px)').matches;
  $('#sidebar').inert = mobile && !$('#sidebar').classList.contains('open');
}

// Detection State
let activeSource = 'webcam';
let webcamStream = null;
let detectionLoopId = null;
let isDetecting = false;
let isIpcamActive = false;
let ipcamLoopId = null;
let isAutoRegisterEnabled = false;
let lastAutoRegisterTime = 0;
let autoRegisteredCount = 0;

let detectionStats = {
  frames: 0,
  detected: 0,
  totalConf: 0,
  lastLatency: 0
};
let lastDetectionResult = null;
let reportPhotoPromise = Promise.resolve(null);

function validReportPhoto(photo) {
  return typeof photo === 'string' && photo.length <= 1400000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(photo);
}

// Keep attachments small and strip camera metadata by rendering fresh JPEG pixels.
async function prepareReportPhoto(source) {
  if (source instanceof File && (!['image/jpeg', 'image/png', 'image/webp'].includes(source.type) || source.size > 10 * 1024 * 1024)) {
    throw new Error('Choose a JPG, PNG or WEBP image smaller than 10 MB.');
  }
  const objectUrl = source instanceof File ? URL.createObjectURL(source) : null;
  const image = new Image();
  try {
    image.src = objectUrl || source;
    await image.decode();
    const scale = Math.min(1, 960 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const photo = canvas.toDataURL('image/jpeg', 0.75);
    if (!validReportPhoto(photo)) throw new Error('This photo is too large to attach. Choose a smaller image.');
    return photo;
  } finally { if (objectUrl) URL.revokeObjectURL(objectUrl); }
}

function clearReportPhoto() {
  reportPhotoPromise = Promise.resolve(null);
  $('#photoInput').value = '';
  $('#reportPhotoPreview').removeAttribute('src');
  $('#reportPhotoAttachment').classList.add('hidden');
  $('#uploadFile').classList.add('hidden');
}

async function attachReportPhoto(source, name = 'Detection frame') {
  const pending = prepareReportPhoto(source);
  reportPhotoPromise = pending;
  $('#uploadFile').textContent = 'Preparing photo…';
  $('#uploadFile').classList.remove('hidden');
  try {
    const photo = await pending;
    if (reportPhotoPromise !== pending) return;
    $('#reportPhotoPreview').src = photo;
    $('#reportPhotoAttachment').classList.remove('hidden');
    $('#uploadFile').textContent = `Attached: ${name}`;
  } catch (error) {
    if (reportPhotoPromise !== pending) return;
    clearReportPhoto();
    toast('Photo not attached', error.message, 'error');
  }
}

// DOM Helper utilities
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = val => String(val ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

function severityClass() { return ''; }
function severityBadge() { return ''; }

function statusClass(status) {
  const s = String(status || '').toLowerCase().replace(/[\s_]+/g, '-');
  if (s === 'fixed' || s === 'resolved') return 'fixed';
  if (s === 'in-progress' || s === 'pending-inspection') return 'in-progress';
  return 'open';
}

function statusBadge(status) {
  const s = String(status || 'Open');
  const cls = statusClass(s);
  return `<span class="status-pill ${cls}">${escapeHTML(s.replace(/_/g, ' ').toUpperCase())}</span>`;
}

// Toast notification
function toast(title, message, kind = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${kind === 'error' ? 'error' : ''}`;
  item.innerHTML = `<span class="toast-icon">${kind === 'error' ? '!' : '✓'}</span><div><b>${escapeHTML(title)}</b><p>${escapeHTML(message)}</p></div><button class="toast-close" aria-label="Dismiss">×</button>`;
  const region = $('#toastRegion');
  if (region) region.appendChild(item);
  const remove = () => item.remove();
  const closeBtn = $('.toast-close', item);
  if (closeBtn) closeBtn.addEventListener('click', remove);
  window.setTimeout(remove, 4500);
}

// Map tile layers
const STREET_TILE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const SAT_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

function createCustomPin(status = 'open') {
  const st = String(status || '').toLowerCase();
  const pinClass = (st === 'fixed' || st === 'resolved') ? 'fixed' : 'high';
  return L.divIcon({
    className: 'custom-leaflet-marker',
    html: `<div class="map-pin ${pinClass}"><span>●</span></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 24],
    popupAnchor: [0, -24]
  });
}

function createUserGpsPin() {
  return L.divIcon({
    className: 'user-gps-container',
    html: `<div class="user-gps-pulse"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -10]
  });
}

// Live High-Accuracy Device GPS Tracking
let liveGpsPosition = null;
let gpsWatchId = null;

function startGpsTracking() {
  if (!('geolocation' in navigator)) return;
  if (gpsWatchId !== null) return;

  gpsWatchId = navigator.geolocation.watchPosition(
    pos => {
      liveGpsPosition = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        source: 'gps',
        timestamp: Date.now()
      };
      currentUserCoords = liveGpsPosition;
    },
    err => {
      console.warn('GPS continuous tracker notice:', err.message);
    },
    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 5000
    }
  );
}

// Request real, un-cached device GPS with high precision
async function getPreciseGpsCoordinates(timeoutMs = 12000) {
  // If we already have a recent GPS fix (less than 45s old):
  if (liveGpsPosition && (Date.now() - liveGpsPosition.timestamp < 45000)) {
    return liveGpsPosition;
  }

  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      return reject(new Error('Geolocation is not supported by your browser.'));
    }

    navigator.geolocation.getCurrentPosition(
      pos => {
        liveGpsPosition = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          source: 'gps',
          timestamp: Date.now()
        };
        currentUserCoords = liveGpsPosition;
        resolve(liveGpsPosition);
      },
      err => {
        let msg = 'Could not acquire precise device GPS.';
        if (err.code === 1) msg = 'Location permission was denied in your browser settings.';
        else if (err.code === 2) msg = 'Location unavailable. Ensure Windows Location Services are enabled.';
        else if (err.code === 3) msg = 'GPS acquisition timed out. Retrying satellite fix...';
        reject(new Error(msg));
      },
      {
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 0 // Do not accept stale cache
      }
    );
  });
}

// General location getter (Falls back to IP only for initial viewport centering)
async function getUserCoordinates(allowIpFallback = true) {
  if (liveGpsPosition) return liveGpsPosition;

  try {
    const coords = await getPreciseGpsCoordinates(8000);
    return coords;
  } catch (err) {
    if (!allowIpFallback) {
      throw err;
    }
    return await fallbackIpLocation();
  }
}

async function fallbackIpLocation() {
  try {
    const res = await fetch('https://ipapi.co/json/');
    const data = await res.json();
    if (data && data.latitude && data.longitude) {
      const approx = {
        lat: Number(data.latitude),
        lng: Number(data.longitude),
        city: data.city || '',
        region: data.region || '',
        source: 'network-approximate'
      };
      if (!currentUserCoords) currentUserCoords = approx;
      return approx;
    }
  } catch (e) {
    // Default coordinates (New Delhi)
  }
  return { lat: 28.6139, lng: 77.2090, source: 'default' };
}

// Navigation between views
function goToView(viewName) {
  const target = $(`#view-${viewName}`);
  if (!target) return;
  if (viewName !== 'detection') { stopWebcam(); stopIpcam(); }
  $$('.view').forEach(v => v.classList.toggle('active', v === target));
  $$('.nav-item[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === viewName));
  const activeNav = $(`.nav-item[data-view="${viewName}"]`);
  if (activeNav) {
    $('#breadcrumbCurrent').textContent = $('span:nth-child(2)', activeNav).textContent.trim();
  }
  $('#sidebar').classList.remove('open');
  document.body.classList.remove('nav-is-open');
  syncNavigationAccess();
  $('#menuButton').setAttribute('aria-expanded', 'false');
  $$('.nav-item[data-view]').forEach(btn => {
    if (btn.dataset.view === viewName) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (viewName === 'map') {
    setTimeout(() => {
      initExplorerMap();
      if (explorerMap) {
        explorerMap.invalidateSize();
        renderExplorerMarkers();
      }
    }, 120);
  }
  if (viewName === 'dashboard') {
    setTimeout(() => {
      initDashboardMap();
      if (dashboardMap) {
        dashboardMap.invalidateSize();
        renderDashboardMarkers();
      }
    }, 120);
  }
  if (viewName === 'submit') {
    setTimeout(async () => {
      await initSubmitMiniMap();
      if (submitMiniMap) submitMiniMap.invalidateSize();
    }, 120);
  }
  if (viewName === 'reports') renderReportsTable();
  if (viewName === 'admin') renderAdminTable();
  if (viewName === 'settings') runDiagnostics();
}

// API Calls
async function fetchHealth() {
  try {
    const res = await apiFetch('/health');
    const data = await res.json();
    if (!res.ok) throw new Error('Health check failed');
    const isUp = data.status === 'UP';
    const connected = data.database === 'Connected';
    $('#sidebarSummaryText').textContent = connected ? 'Live services connected' : 'Database unavailable — check Settings';
    $('#sidebarApiState').textContent = isUp ? 'Online' : 'Offline';
    $('#sidebarDbState').textContent = data.database || 'Connected';
    $('#systemStatusDot').style.background = isUp ? '#35d99a' : '#ef616b';
    return data;
  } catch (err) {
    $('#sidebarSummaryText').textContent = 'Backend unavailable — check Settings';
    $('#sidebarApiState').textContent = 'Disconnected';
    $('#sidebarDbState').textContent = 'Offline';
    $('#systemStatusDot').style.background = '#ef616b';
    return null;
  }
}

async function fetchStats() {
  try {
    const res = await apiFetch('/api/potholes/stats');
    if (!res.ok) throw new Error('Stats request failed');
    const data = await res.json();
    if (data.success && data.stats) {
      stats = data.stats;
      updateStatsUI();
    }
  } catch (err) {
    console.warn('Failed to load stats:', err);
  }
}

async function fetchReports() {
  if (reportsRequest) return reportsRequest;
  reportsLoading = true;
  reportsError = '';
  renderReportsTable();
  reportsRequest = loadReports();
  try { await reportsRequest; }
  finally {
    reportsRequest = null;
    reportsLoading = false;
    renderReportsTable();
  }
}

async function loadReports() {
  try {
    let data;
    const items = [];
    let page = 1;
    do {
      const res = await apiFetch(`/api/potholes?limit=500&page=${page}`);
      if (!res.ok) throw new Error('Reports are unavailable. Check the backend and database, then retry.');
      data = await res.json();
      if (!data.success || !Array.isArray(data.data)) throw new Error('The server returned an invalid reports response.');
      items.push(...data.data);
      page++;
    } while (page <= data.totalPages);
    if (data.success && Array.isArray(data.data)) {
      reports = items.map(item => {
        const d = item.data || {};
        const lat = item.coordinate?.latitude ?? (item.location?.coordinates ? item.location.coordinates[1] : 28.6139);
        const lng = item.coordinate?.longitude ?? (item.location?.coordinates ? item.location.coordinates[0] : 77.2090);
        return {
          id: item.uuid,
          type: item.type || 'pothole',
          title: d.roadName ? `${d.roadName} Pothole` : `Pothole ${item.uuid.substring(0, 8)}`,
          road: d.roadName || 'Unnamed Road',
          area: d.locality ? `${d.locality}, ${d.city || ''}` : (d.city || 'Verified Location'),
          city: d.city || 'Verified Location',
          severity: d.severity || 'medium',
          status: d.status || 'open',
          reported: item.createdAt ? new Date(item.createdAt).toLocaleDateString() : 'Recent',
          date: item.createdAt ? new Date(item.createdAt).toISOString().split('T')[0] : 'Today',
          lat: Number(lat),
          lng: Number(lng),
          description: d.description || `Reported ${item.type || 'hazard'}`,
          photo: validReportPhoto(d.photo) ? d.photo : null,
          raw: item
        };
      });
      $('#navReportCount').textContent = reports.length;
      renderAllViews();
    }
  } catch (err) {
    reportsError = err.name === 'TimeoutError' ? 'The server took too long. Please retry.' : err.message;
  }
}

function updateStatsUI() {
  const total = stats.total || reports.length;
  const open = stats.open || 0;
  const inProgress = stats.inProgress || 0;
  const fixed = stats.fixed || 0;

  if ($('#metricTotal')) $('#metricTotal').textContent = total;
  if ($('#metricOpen')) $('#metricOpen').textContent = open;
  if ($('#metricInProgress')) $('#metricInProgress').textContent = inProgress;
  if ($('#metricFixed')) $('#metricFixed').textContent = fixed;

  if ($('#stripTotal')) $('#stripTotal').textContent = total;
  if ($('#stripOpen')) $('#stripOpen').textContent = open;
  if ($('#stripInProgress')) $('#stripInProgress').textContent = inProgress;
  if ($('#stripFixed')) $('#stripFixed').textContent = fixed;

  if ($('#adminAwaitingCount')) $('#adminAwaitingCount').textContent = open;
  if ($('#adminProgressCount')) $('#adminProgressCount').textContent = inProgress;
  if ($('#adminFixedCount')) $('#adminFixedCount').textContent = fixed;
  if ($('#metricUrgentPill')) $('#metricUrgentPill').textContent = `${open} open`;

  const rate = total > 0 ? Math.round((fixed / total) * 100) : 0;
  if ($('#metricResolutionProgress')) $('#metricResolutionProgress').style.width = `${rate}%`;
  if ($('#metricResolutionRate')) $('#metricResolutionRate').textContent = `${rate}% rate`;

  renderBarChart();
}

// Maps Initialization
async function initDashboardMap() {
  if (dashboardMap) return;
  const container = $('#dashboardMap');
  if (!container) return;

  const coords = currentUserCoords || { lat: 28.6139, lng: 77.2090 };
  const defaultCenter = reports.length > 0 ? [reports[0].lat, reports[0].lng] : [coords.lat, coords.lng];
  dashboardMap = L.map('dashboardMap', { zoomControl: false }).setView(defaultCenter, 13);
  L.control.zoom({ position: 'topright' }).addTo(dashboardMap);

  L.tileLayer(STREET_TILE, {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  }).addTo(dashboardMap);

  const loader = $('#dashboardMapLoading');
  if (loader) loader.style.display = 'none';

  renderDashboardMarkers();
}

async function initExplorerMap() {
  if (explorerMap) return;
  const container = $('#explorerMap');
  if (!container) return;

  const coords = currentUserCoords || { lat: 28.6139, lng: 77.2090 };
  const defaultCenter = reports.length > 0 ? [reports[0].lat, reports[0].lng] : [coords.lat, coords.lng];
  explorerMap = L.map('explorerMap').setView(defaultCenter, 13);

  L.tileLayer(STREET_TILE, {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  }).addTo(explorerMap);

  renderExplorerMarkers();
}

// Interactive Mini-Map inside Submit Report Form
async function initSubmitMiniMap() {
  if (submitMiniMap) return;
  const container = $('#submitMiniMap');
  if (!container) return;

  const coords = currentUserCoords || (reports[0] ? { lat: reports[0].lat, lng: reports[0].lng } : { lat: 28.6139, lng: 77.2090 });
  submitMiniMap = L.map('submitMiniMap').setView([coords.lat, coords.lng], 13);

  L.tileLayer(STREET_TILE, {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  }).addTo(submitMiniMap);

  // The initial viewport is context, never an automatically selected report location.
  $('#locationStatus').textContent = 'No location selected. Click the map to place your report pin.';

  // Click on mini-map to drop/update pin and auto-fill coordinates
  submitMiniMap.on('click', (e) => {
    const { lat, lng } = e.latlng;
    setSubmitLocation(lat, lng);
  });
}

async function setSubmitLocation(lat, lng, source = 'map', accuracy = null) {
  const version = ++submitLocationVersion;
  const label = source === 'gps' ? `Device location${Number.isFinite(accuracy) ? ` · accuracy ±${Math.round(accuracy)} m` : ''}` : 'Report pin selected';
  $('#latitude').value = lat.toFixed(6);
  $('#longitude').value = lng.toFixed(6);
  $('#locationStatus').textContent = `${label} · ${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  if (submitMiniMap) {
    if (submitMarker) {
      submitMarker.setLatLng([lat, lng]);
    } else {
      submitMarker = L.marker([lat, lng], {
        draggable: true,
        icon: createCustomPin('high', 'open')
      }).addTo(submitMiniMap);

      submitMarker.on('dragend', (evt) => {
        const pos = evt.target.getLatLng();
        setSubmitLocation(pos.lat, pos.lng);
      });
    }
    submitMiniMap.panTo([lat, lng]);
  }

  // Reverse Geocode with OpenStreetMap Nominatim
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
    const data = await res.json();
    if (version !== submitLocationVersion) return;
    if (data && data.address) {
      const road = data.address.road || data.address.street || data.address.neighbourhood || '';
      const city = data.address.city || data.address.town || data.address.suburb || data.address.county || '';
      if (road && !$('#roadName').value) $('#roadName').value = road;
      if (city && !$('#city').value) $('#city').value = city;
      if (road || city) {
        $('#locationStatus').textContent = `${label} · ${road ? road + ', ' : ''}${city} (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
      }
    }
  } catch (e) {
    // Graceful offline fallback
  }
}

function resetSubmitLocation() {
  submitLocationVersion++;
  if (submitMarker && submitMiniMap) submitMiniMap.removeLayer(submitMarker);
  submitMarker = null;
  $('#latitude').value = '';
  $('#longitude').value = '';
  $('#locationStatus').textContent = 'No location selected. Click the map to place your report pin.';
}

// Markers Rendering
function renderDashboardMarkers() {
  if (!dashboardMap) return;
  dashboardMarkers.forEach(m => dashboardMap.removeLayer(m));
  dashboardMarkers = [];

  let countActive = 0, countFixed = 0;

  const query = ($('#mapSearch')?.value || '').trim().toLowerCase();
  reports.filter(r => !query || [r.id, r.title, r.road, r.area, r.city].some(value => String(value).toLowerCase().includes(query))).forEach(r => {
    const st = String(r.status).toLowerCase();
    if (st === 'fixed' || st === 'resolved') countFixed++;
    else countActive++;

    const icon = createCustomPin(r.status);
    const marker = L.marker([r.lat, r.lng], { icon }).addTo(dashboardMap);
    marker.bindPopup(`
      <div style="min-width:180px;">
        <b style="font-size:12px;display:block;margin-bottom:4px;">${escapeHTML(r.title)}</b>
        <span style="font-size:10px;color:#77859a;display:block;margin-bottom:6px;">${escapeHTML(r.road)}, ${escapeHTML(r.city)}</span>
        <div style="display:flex;gap:5px;align-items:center;margin-bottom:8px;">
          ${statusBadge(r.status)}
        </div>
        <p style="font-size:10px;color:#55667d;margin:0 0 6px;">${escapeHTML(r.description)}</p>
        <button class="button button-quiet" style="width:100%;min-height:26px;font-size:9px;">View Details</button>
      </div>
    `);
    marker.on('popupopen', event => {
      const button = event.popup.getElement().querySelector('button');
      if (button) button.onclick = () => openReport(r.id);
    });
    dashboardMarkers.push(marker);
  });

  if ($('#legendActive')) $('#legendActive').textContent = countActive;
  if ($('#legendFixed')) $('#legendFixed').textContent = countFixed;

  if (reports.length > 0 && dashboardMarkers.length > 0) {
    const group = L.featureGroup(dashboardMarkers);
    dashboardMap.fitBounds(group.getBounds().pad(0.15));
  }
}

function renderExplorerMarkers(items = reports) {
  if (!explorerMap) return;
  explorerMarkers.forEach(m => explorerMap.removeLayer(m));
  explorerMarkers = [];

  const q = ($('#explorerSearch')?.value || '').trim().toLowerCase();

  const filtered = items.filter(r => {
    const matchesQ = !q || [r.title, r.road, r.area, r.id].some(v => String(v).toLowerCase().includes(q));
    return matchesQ;
  });

  filtered.forEach(r => {
    const icon = createCustomPin(r.status);
    const marker = L.marker([r.lat, r.lng], { icon }).addTo(explorerMap);
    marker.bindPopup(`
      <div style="min-width:190px;">
        <b style="font-size:12px;display:block;margin-bottom:4px;">${escapeHTML(r.title)}</b>
        <span style="font-size:10px;color:#77859a;display:block;margin-bottom:6px;">${escapeHTML(r.road)}, ${escapeHTML(r.city)}</span>
        <div style="display:flex;gap:5px;margin-bottom:8px;">
          ${statusBadge(r.status)}
        </div>
        <div style="font-size:9px;color:#8a99ac;margin-bottom:8px;">Coordinates: ${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}</div>
        <button class="button button-quiet" style="width:100%;min-height:26px;font-size:9px;">View Record</button>
      </div>
    `);
    marker.on('popupopen', event => {
      const button = event.popup.getElement().querySelector('button');
      if (button) button.onclick = () => openReport(r.id);
    });
    explorerMarkers.push(marker);
  });

  if (filtered.length > 0) {
    const group = L.featureGroup(explorerMarkers);
    explorerMap.fitBounds(group.getBounds().pad(0.2));
  }
}

// Lists & Telemetry
function reportThumb(report) {
  if (validReportPhoto(report.photo)) return `<img class="report-thumb report-photo-thumb" src="${escapeHTML(report.photo)}" alt="Photo of reported road damage" loading="lazy" />`;
  return '<span class="report-thumb report-no-photo" aria-label="No photo" title="No photo attached">▧</span>';
}

function renderRecentReports() {
  const container = $('#recentReports');
  if (!container) return;
  const recent = reports.slice(0, 5);
  if (recent.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:25px 15px;"><h3>No hazard reports yet</h3><p>Submit a report or use Live Detection to record verified hazards into the database.</p></div>';
    return;
  }
  container.innerHTML = recent.map((r, i) => `
    <article class="recent-item" tabindex="0" role="button" data-report-id="${escapeHTML(r.id)}" aria-label="View ${escapeHTML(r.title)}">
      ${reportThumb(r)}
      <div class="report-copy">
        <b>${escapeHTML(r.title)}</b>
        <small>${escapeHTML(r.area)}</small>
        <div class="report-meta">${statusBadge(r.status)}<span class="recent-time">${escapeHTML(r.reported)}</span></div>
      </div>
    </article>
  `).join('');

  $$('.recent-item', container).forEach(item => {
    item.addEventListener('click', () => openReport(item.dataset.reportId));
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openReport(item.dataset.reportId);
      }
    });
  });
}

function renderAttention() {
  const container = $('#attentionList');
  if (!container) return;
  const urgent = reports.filter(r => {
    const s = String(r.status).toLowerCase();
    return s !== 'fixed' && s !== 'resolved';
  });
  $('#attentionCountBadge').textContent = urgent.length;

  if (urgent.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:25px 15px;"><h3>All clear</h3><p>No open reports awaiting review.</p></div>';
    return;
  }
  container.innerHTML = urgent.slice(0, 4).map(r => `
    <div class="attention-item" style="cursor:pointer;" onclick="window.roadwatchOpenReport('${r.id}')">
      <i class="attention-dot"></i>
      <div>
        <b>${escapeHTML(r.title)}</b>
        <small>${escapeHTML(r.area)} · ${escapeHTML(r.id)}</small>
      </div>
      <span class="attention-age">${escapeHTML(r.reported)}</span>
    </div>
  `).join('');
}

function renderBarChart() {
  const container = $('#barChart');
  if (!container) return;
  const open = reports.filter(r => {
    const s = String(r.status).toLowerCase();
    return s === 'open' || s === 'verified';
  }).length;
  const inProgress = reports.filter(r => {
    const s = String(r.status).toLowerCase();
    return s === 'in_progress' || s === 'in-progress' || s === 'pending_inspection';
  }).length;
  const fixed = reports.filter(r => {
    const s = String(r.status).toLowerCase();
    return s === 'fixed' || s === 'resolved';
  }).length;

  const counts = [open, inProgress, fixed];
  const max = Math.max(...counts, 1);

  container.innerHTML = counts.map(c => {
    const h = reports.length === 0 ? 0 : Math.round((c / max) * 90) + 10;
    return `
      <div class="bar-group" title="Count: ${c}">
        <i class="bar primary" style="height:${h}%;"></i>
      </div>
    `;
  }).join('');
}

// Reports Directory Table
function filteredReports() {
  const q = ($('#reportSearch')?.value || $('#globalSearch')?.value || '').trim().toLowerCase();
  const status = $('#statusFilter')?.value || 'all';

  return reports.filter(r => {
    if (nearbyReportIds && !nearbyReportIds.has(r.id)) return false;
    const matchesQ = !q || [r.id, r.title, r.road, r.area, r.city, r.type].some(v => String(v).toLowerCase().includes(q));
    const s = String(r.status).toLowerCase();
    const matchesStatus = status === 'all' || s === status || (status === 'fixed' && s === 'resolved') || (status === 'in_progress' && s === 'pending_inspection');
    return matchesQ && matchesStatus;
  });
}

function reportRow(r, i, admin = false) {
  const isFixed = String(r.status).toLowerCase() === 'fixed';
  const actions = admin ? `
    <div style="display:flex;gap:6px;">
      <button class="button button-outline" style="min-height:28px;padding:0 8px;font-size:9px" data-action="toggle-status" data-id="${escapeHTML(r.id)}">
        ${isFixed ? 'Reopen' : 'Mark Fixed'}
      </button>
      <button class="button button-quiet" style="min-height:28px;padding:0 8px;font-size:9px" data-action="in-progress" data-id="${escapeHTML(r.id)}">
        In Progress
      </button>
    </div>
  ` : `
    <div class="table-actions">
      <button class="table-action" title="View details" aria-label="View details" data-action="view" data-id="${escapeHTML(r.id)}">↗</button>
      <button class="table-action" title="Update status" aria-label="Update status" data-action="status" data-id="${escapeHTML(r.id)}">✎</button>
      <button class="table-action delete" title="Delete record" aria-label="Delete record" data-action="delete" data-id="${escapeHTML(r.id)}">×</button>
    </div>
  `;

  return `
    <tr>
      <td>
        <div class="table-report">
          ${reportThumb(r)}
          <div>
            <b>${escapeHTML(r.title)}</b>
            <small>${escapeHTML(r.id)} · ${escapeHTML(r.type)}</small>
          </div>
        </div>
      </td>
      <td>
        <b style="display:block;color:#52637a;font-size:10px;margin-bottom:4px;">${escapeHTML(r.road)}</b>
        <span style="font-size:9px;color:#9aa6b4;">${escapeHTML(r.area)}</span>
      </td>
      <td>${statusBadge(r.status)}</td>
      ${admin ? '' : `<td>${escapeHTML(r.date)}</td>`}
      <td>${actions}</td>
    </tr>
  `;
}

function renderReportsTable() {
  const result = filteredReports();
  const tbody = $('#reportTableBody');
  if (!tbody) return;
  const pages = Math.max(1, Math.ceil(result.length / REPORT_PAGE_SIZE));
  reportPage = Math.max(1, Math.min(reportPage, pages));
  const start = (reportPage - 1) * REPORT_PAGE_SIZE;
  tbody.innerHTML = result.slice(start, start + REPORT_PAGE_SIZE).map((r, i) => reportRow(r, i, false)).join('');
  $('#reportEmpty').classList.toggle('hidden', result.length > 0 || reportsLoading || !!reportsError);
  const state = $('#reportsLoadState');
  if (state) {
    state.classList.toggle('hidden', !reportsLoading && !reportsError);
    $('#reportsLoadMessage').textContent = reportsLoading ? 'Loading road reports…' : `${reportsError}${reports.length ? ' Showing previously loaded reports.' : ''}`;
    $('#retryReports').classList.toggle('hidden', reportsLoading);
  }
  tbody.setAttribute('aria-busy', String(reportsLoading));
  $('#tableCount').textContent = result.length ? `Showing ${start + 1}–${Math.min(start + REPORT_PAGE_SIZE, result.length)} of ${result.length} reports` : 'Showing 0 reports';
  $('#currPageBtn').textContent = `${reportPage} / ${pages}`;
  $('#prevPageBtn').disabled = reportPage === 1;
  $('#nextPageBtn').disabled = reportPage === pages;
  bindTableActions(tbody);
}

function renderAdminTable(filter = $('.admin-tab.active')?.dataset.adminFilter || 'open') {
  const rows = reports.filter(r => {
    if (filter === 'all') return true;
    const s = String(r.status).toLowerCase();
    if (filter === 'open') return s === 'open' || s === 'verified';
    if (filter === 'in_progress') return s === 'in_progress' || s === 'pending_inspection';
    if (filter === 'fixed') return s === 'fixed' || s === 'resolved';
    return s === filter;
  });

  const tbody = $('#adminTableBody');
  if (!tbody) return;
  tbody.innerHTML = rows.map((r, i) => reportRow(r, i, true)).join('') || '<tr><td colspan="4" style="text-align:center;padding:35px;color:#94a1b1">No reports currently in this queue.</td></tr>';
  bindTableActions(tbody);
}

function bindTableActions(root) {
  $$('[data-action]', root).forEach(button => {
    button.addEventListener('click', async () => {
      const report = reports.find(r => r.id === button.dataset.id);
      if (!report) return;
      const action = button.dataset.action;

      if (action === 'view') {
        openReport(report.id);
      } else if (action === 'status') {
        openReport(report.id, true);
      } else if (action === 'delete') {
        openDeleteConfirmation(report);
      } else if (action === 'toggle-status') {
        const nextStatus = String(report.status).toLowerCase() === 'fixed' ? 'open' : 'fixed';
        await updateStatusOnServer(report.id, nextStatus);
      } else if (action === 'in-progress') {
        await updateStatusOnServer(report.id, 'in_progress');
      }
    });
  });
}

// Updating Status on Server (PATCH /api/potholes/:uuid/status)
async function updateStatusOnServer(uuid, newStatus) {
  try {
    const res = await apiFetch(`/api/potholes/${encodeURIComponent(uuid)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error?.message || 'Status update failed');
    }
    toast('Status Updated in Database', `${uuid} is now marked '${newStatus.replace(/_/g, ' ')}'`);
    await fetchReports();
    await fetchStats();
  } catch (err) {
    toast('Update Failed', err.message, 'error');
  }
}

// Modal Details & Actions
function openReport(id, focusAction = false) {
  const report = reports.find(r => r.id === id);
  if (!report) return;
  activeReportId = id;

  $('#detailContent').innerHTML = `
    <h2 id="detailTitle">${escapeHTML(report.title)}</h2>
    <p class="modal-subtitle">${escapeHTML(report.id)} · Recorded ${escapeHTML(report.reported)}</p>
    ${validReportPhoto(report.photo) ? `<img class="report-detail-photo" src="${escapeHTML(report.photo)}" alt="Photo attached to ${escapeHTML(report.title)}" />` : '<p class="photo-empty-note">No photo attached to this report.</p>'}
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
      ${statusBadge(report.status)}
    </div>
    <div class="modal-detail-grid">
      <div class="modal-detail-cell"><small>Road / Street</small><b>${escapeHTML(report.road)}</b></div>
      <div class="modal-detail-cell"><small>City / Locality</small><b>${escapeHTML(report.area)}</b></div>
      <div class="modal-detail-cell"><small>Damage Type</small><b>${escapeHTML(report.type)}</b></div>
      <div class="modal-detail-cell"><small>GPS Coordinates</small><b>${report.lat.toFixed(4)}, ${report.lng.toFixed(4)}</b></div>
    </div>
    <div class="modal-description">${escapeHTML(report.description)}</div>
  `;

  const isFixed = String(report.status).toLowerCase() === 'fixed';
  const actionBtn = $('#modalAction');
  actionBtn.textContent = isFixed ? 'Reopen Report' : 'Mark as Fixed';
  actionBtn.className = 'button button-primary';
  actionBtn.onclick = async () => {
    closeModal();
    const next = isFixed ? 'open' : 'fixed';
    await updateStatusOnServer(id, next);
  };

  showModal(focusAction ? actionBtn : $('#modalClose'));
}

function openDeleteConfirmation(report) {
  activeReportId = report.id;
  $('#detailContent').innerHTML = `
    <h2 id="detailTitle">Delete this pothole report?</h2>
    <p class="modal-subtitle">${escapeHTML(report.id)} · ${escapeHTML(report.title)}</p>
    <div class="modal-description">This will permanently delete this pothole record from MongoDB Atlas. This action cannot be undone.</div>
  `;
  const actionBtn = $('#modalAction');
  actionBtn.textContent = 'Permanently Delete';
  actionBtn.className = 'button button-danger';
  actionBtn.onclick = async () => {
    closeModal();
    try {
      const res = await apiFetch(`/api/potholes/${encodeURIComponent(report.id)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error?.message || 'Delete failed');
      toast('Record Deleted', `Pothole ${report.id} was removed from the database.`);
      await fetchReports();
      await fetchStats();
    } catch (err) {
      toast('Delete Failed', err.message, 'error');
    }
  };
  showModal($('#modalCancel'));
}

function showModal(focusTarget) {
  modalTrigger = document.activeElement;
  $('#modalBackdrop').classList.remove('hidden');
  $('.app-shell').inert = true;
  document.body.style.overflow = 'hidden';
  focusTarget.focus();
}

function closeModal() {
  $('#modalBackdrop').classList.add('hidden');
  activeReportId = null;
  $('.app-shell').inert = false;
  document.body.style.overflow = '';
  modalTrigger?.focus();
  modalTrigger = null;
}

window.roadwatchOpenReport = openReport;

// Submitting a Report (POST /api/potholes)
async function submitReport(event) {
  event.preventDefault();
  const form = $('#reportForm');
  const damageType = $('#damageType').value;
  const roadName = $('#roadName').value.trim();
  const city = $('#city').value.trim();
  const reportedBy = $('#reportedBy').value.trim() || 'Citizen Reporter';
  const description = $('#description').value.trim();
  const latVal = parseFloat($('#latitude').value);
  const lngVal = parseFloat($('#longitude').value);

  let hasError = false;
  $$('.field-error', form).forEach(el => el.textContent = '');

  if (!roadName) {
    $('[data-error="roadName"]').textContent = 'Road or street name is required';
    hasError = true;
  }
  if (!city) {
    $('[data-error="city"]').textContent = 'City or area is required';
    hasError = true;
  }
  if (isNaN(latVal) || latVal < -90 || latVal > 90) {
    $('[data-error="latitude"]').textContent = 'Valid latitude (-90 to 90) required';
    hasError = true;
  }
  if (isNaN(lngVal) || lngVal < -180 || lngVal > 180) {
    $('[data-error="longitude"]').textContent = 'Valid longitude (-180 to 180) required';
    hasError = true;
  }

  if (hasError) return;

  const submitBtn = $('#submitReportBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving to database...';

  try {
    const photo = await reportPhotoPromise;
    const payload = {
      type: damageType || 'pothole',
      coordinate: { latitude: latVal, longitude: lngVal },
      location: {
        type: 'Point',
        coordinates: [lngVal, latVal]
      },
      data: {
        roadName,
        locality: city,
        city,
        severity: 'medium',
        status: 'open',
        reportedBy,
        ...(photo ? { photo } : {}),
        description: description || `Reported ${damageType} on ${roadName}`
      }
    };

    const res = await apiFetch('/api/potholes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error?.message || 'Failed to create pothole record');
    }

    toast('Report Created Successfully', `Pothole registered in MongoDB with UUID: ${data.data.uuid}`);
    form.reset();
    clearReportPhoto();
    $('#uploadFile').classList.add('hidden');
    $('#locationStatus').textContent = 'Location recorded';

    await fetchReports();
    await fetchStats();
    goToView('reports');
  } catch (err) {
    toast('Submission Failed', err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = 'Submit report <span>→</span>';
  }
}

// Live YOLO Computer Vision & Detection
async function checkModelStatus() {
  try {
    const res = await apiFetch('/api/detect/status');
    const data = await res.json();
    if (data.success && data.model) {
      $('#modelNameDisplay').textContent = data.model.name;
      $('#modelEngineDisplay').textContent = data.model.engine;
      $('#sidebarModelState').textContent = data.model.available ? 'Ready' : 'Unavailable';
      $('#livePill').textContent = data.model.available ? 'Model Ready' : 'Model Missing';
      $('#livePill').className = data.model.available ? 'live-pill' : 'live-pill offline';
    }
  } catch (err) {
    $('#sidebarModelState').textContent = 'Offline';
  }
}

// Instant & Auto Registration of Detections to Map and MongoDB
async function registerDetectionToMap(detection, confidence, manual = false) {
  // Capture the successful inference frame before GPS/geocoding awaits.
  const capturedPhoto = lastDetectionResult?.photo;
  try {
    const pinBtn = $('#instantPinBtn');
    if (manual && pinBtn) {
      pinBtn.disabled = true;
      pinBtn.innerHTML = '<span>⏳</span> Pinning to Map...';
    }

    toast('GPS Telemetry', 'Acquiring device GPS coordinates for detected pothole...');
    let coords;
    try {
      coords = await getPreciseGpsCoordinates(10000);
    } catch (gpsErr) {
      if (liveGpsPosition) {
        coords = liveGpsPosition;
      } else if (currentUserCoords && currentUserCoords.source === 'gps') {
        coords = currentUserCoords;
      } else {
        throw new Error('Device GPS signal required. Please allow location access in your browser settings.');
      }
    }

    // Reverse geocode with OpenStreetMap Nominatim
    let roadName = 'Detected Road Pothole';
    let city = coords.city || 'Verified Location';
    try {
      const resGeo = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${coords.lat}&lon=${coords.lng}`);
      const geoData = await resGeo.json();
      if (geoData && geoData.address) {
        roadName = geoData.address.road || geoData.address.street || geoData.address.neighbourhood || roadName;
        city = geoData.address.city || geoData.address.town || geoData.address.suburb || city;
      }
    } catch (e) {
      // Offline fallback
    }

    const confPct = Math.round(Number(confidence || 0.5) * 100);
    const photo = capturedPhoto ? await prepareReportPhoto(capturedPhoto) : null;

    const payload = {
      type: 'pothole',
      coordinate: { latitude: coords.lat, longitude: coords.lng },
      location: {
        type: 'Point',
        coordinates: [coords.lng, coords.lat]
      },
      data: {
        roadName,
        locality: city,
        city,
        severity: 'medium',
        status: 'open',
        reportedBy: manual ? 'Live Stream Operator' : 'YOLO11s Auto-Sentinel',
        ...(photo ? { photo } : {}),
        description: `Live detected road pothole (${confPct}% confidence) via YOLO11s model.`
      }
    };

    const res = await apiFetch('/api/potholes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error?.message || 'Failed to register pothole in database');
    }

    autoRegisteredCount++;
    const badge = $('#autoRegisteredCount');
    if (badge) badge.textContent = autoRegisteredCount;

    toast('📍 Pinned to Map & DB!', `${roadName} saved! (UUID: ${data.data.uuid.substring(0, 8)})`);

    // Synchronize frontend lists and maps immediately
    await fetchReports();
    await fetchStats();

    // Pan map to new registered hazard and re-render markers
    if (dashboardMap) {
      dashboardMap.setView([coords.lat, coords.lng], 15);
      renderDashboardMarkers();
    }
    if (explorerMap) {
      explorerMap.setView([coords.lat, coords.lng], 15);
      renderExplorerMarkers();
    }

    $('#cameraTag').textContent = `✓ PINNED TO MAP (${roadName.substring(0, 16)})`;
    $('#cameraTag').style.color = '#35d99a';

    return data.data;
  } catch (err) {
    toast('Registration Failed', err.message, 'error');
    return null;
  } finally {
    const pinBtn = $('#instantPinBtn');
    if (manual && pinBtn) {
      pinBtn.disabled = false;
      pinBtn.innerHTML = '<span>📍</span> Register to Map Now';
    }
  }
}

async function runInferenceOnImage(imageSource) {
  const t0 = performance.now();
  $('#cameraTag').textContent = 'INFERRING...';
  $('#cameraTag').style.color = '#38bdf8';

  try {
    const res = await apiFetch('/api/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageSource, confidence: 0.25 })
    });

    const data = await res.json();
    const duration = Math.round(performance.now() - t0);

    if (data.success) {
      lastDetectionResult = { ...data, photo: imageSource };
      detectionStats.frames++;
      detectionStats.detected += data.count;
      detectionStats.lastLatency = data.inferenceMs || duration;

      if (data.count > 0) {
        const confSum = data.detections.reduce((acc, d) => acc + d.confidence, 0);
        detectionStats.totalConf += confSum;
      }

      updateDetectionTelemetry();
      drawDetectionsOnCanvas(data.detections, data.imageWidth, data.imageHeight);

      $('#cameraTag').textContent = data.count > 0 ? `${data.count} POTHOLE${data.count > 1 ? 'S' : ''} DETECTED` : 'CLEAR ROAD';
      $('#cameraTag').style.color = data.count > 0 ? '#ef686c' : '#35d99a';

      $('#instantPinBtn').style.display = data.count > 0 ? 'inline-flex' : 'none';
      $('#createReportFromDetectBtn').style.display = data.count > 0 ? 'inline-flex' : 'none';
      if (data.count > 0) {
        $('#instantPinBtn').style.display = 'inline-flex';
        $('#createReportFromDetectBtn').style.display = 'inline-flex';

        // Auto-Register to Map if toggle is ON (8s anti-duplicate cooldown)
        if (isAutoRegisterEnabled && (Date.now() - lastAutoRegisterTime > 8000)) {
          lastAutoRegisterTime = Date.now();
          const primaryDet = data.detections[0];
          registerDetectionToMap(primaryDet, primaryDet?.confidence || 0.5, false);
        }
      }
    } else {
      toast('Detection Notice', data.error?.message || 'No detections returned', 'error');
    }
  } catch (err) {
    $('#cameraTag').textContent = 'DETECTION FAILED';
    $('#cameraTag').style.color = '#ef686c';
    toast('Detection Failed', err.message, 'error');
  }
}

// Helper to normalize IP camera URLs
function cleanIpcamUrl(raw) {
  if (!raw) return '';
  let u = raw.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    u = 'http://' + u;
  }
  try {
    const parsed = new URL(u);
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
    return u;
  }
}

// IP Webcam Frame Capture & Detection Loop
async function captureIpcamFrameAndDetect() {
  if (!isIpcamActive) return;

  const rawUrl = $('#ipcamUrlInput').value.trim();
  if (!rawUrl) {
    toast('IP Camera URL Required', 'Please enter your phone IP camera address', 'error');
    stopIpcam();
    return;
  }

  const normUrl = cleanIpcamUrl(rawUrl);
  $('#ipcamUrlInput').value = normUrl;

  const t0 = performance.now();
  $('#cameraTag').textContent = 'POLLING IP CAM...';
  $('#cameraTag').style.color = '#38bdf8';

  try {
    const res = await apiFetch('/api/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ipcamUrl: normUrl, confidence: 0.25 })
    });

    const data = await res.json();
    const duration = Math.round(performance.now() - t0);

    if (data.success) {
      lastDetectionResult = { ...data, photo: data.frame || null };
      detectionStats.frames++;
      detectionStats.detected += data.count;
      detectionStats.lastLatency = data.inferenceMs || duration;

      if (data.count > 0) {
        const confSum = data.detections.reduce((acc, d) => acc + d.confidence, 0);
        detectionStats.totalConf += confSum;
      }

      updateDetectionTelemetry();

      // Display the frame returned from IP camera
      if (data.frame) {
        const preview = $('#previewImage');
        preview.style.display = 'block';
        preview.src = data.frame;
      }

      drawDetectionsOnCanvas(data.detections, data.imageWidth, data.imageHeight);

      $('#cameraTag').textContent = data.count > 0 ? `${data.count} POTHOLE${data.count > 1 ? 'S' : ''} DETECTED` : 'CLEAR ROAD';
      $('#cameraTag').style.color = data.count > 0 ? '#ef686c' : '#35d99a';

      $('#instantPinBtn').style.display = data.count > 0 ? 'inline-flex' : 'none';
      $('#createReportFromDetectBtn').style.display = data.count > 0 ? 'inline-flex' : 'none';
      if (data.count > 0) {
        $('#instantPinBtn').style.display = 'inline-flex';
        $('#createReportFromDetectBtn').style.display = 'inline-flex';

        // Auto-Register to Map if toggle is ON (8s anti-duplicate cooldown)
        if (isAutoRegisterEnabled && (Date.now() - lastAutoRegisterTime > 8000)) {
          lastAutoRegisterTime = Date.now();
          const primaryDet = data.detections[0];
          registerDetectionToMap(primaryDet, primaryDet?.confidence || 0.5, false);
        }
      }
    } else {
      toast('IP Camera Notice', data.error?.message || 'Could not reach IP camera. Check phone WiFi and IP.', 'error');
      $('#cameraTag').textContent = 'CONNECTION FAILED';
      $('#cameraTag').style.color = '#ef686c';
      stopIpcam();
      return;
    }
  } catch (err) {
    toast('Connection Error', `Failed to reach ${normUrl}. Check phone WiFi and IP address.`, 'error');
    $('#cameraTag').textContent = 'CONNECTION FAILED';
    $('#cameraTag').style.color = '#ef686c';
    stopIpcam();
    return;
  }

  if (isIpcamActive) {
    ipcamLoopId = setTimeout(captureIpcamFrameAndDetect, 800);
  }
}

function startIpcam() {
  stopWebcam();
  isIpcamActive = true;
  $('#connectIpcamBtn').style.display = 'none';
  $('#stopIpcamBtn').style.display = 'inline-flex';
  $('#cameraPlaceholder').style.display = 'none';
  $('#webcamVideo').style.display = 'none';
  $('#previewImage').style.display = 'block';
  captureIpcamFrameAndDetect();
}

function stopIpcam() {
  isIpcamActive = false;
  if (ipcamLoopId) {
    clearTimeout(ipcamLoopId);
    ipcamLoopId = null;
  }
  $('#connectIpcamBtn').style.display = 'inline-flex';
  $('#stopIpcamBtn').style.display = 'none';
  $('#cameraTag').textContent = 'STANDBY';
  $('#cameraTag').style.color = '#9cafc2';
}

function drawDetectionsOnCanvas(detections, origW, origH) {
  const canvas = $('#overlayCanvas');
  const stage = $('#cameraStage');
  if (!canvas || !stage) return;

  const rect = stage.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!detections || detections.length === 0) return;

  detections.forEach(det => {
    let [ymin, xmin, ymax, xmax] = det.normalizedBbox;
    const x = xmin * canvas.width;
    const y = ymin * canvas.height;
    const w = (xmax - xmin) * canvas.width;
    const h = (ymax - ymin) * canvas.height;

    // Draw bounding box
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ef686c';
    ctx.fillStyle = 'rgba(239, 104, 108, 0.2)';
    ctx.strokeRect(x, y, w, h);
    ctx.fillRect(x, y, w, h);

    // Draw label
    const label = `Pothole · ${Math.round(det.confidence * 100)}%`;
    ctx.font = 'bold 11px "DM Sans", sans-serif';
    const textWidth = ctx.measureText(label).width;

    ctx.fillStyle = '#ef686c';
    ctx.fillRect(x, Math.max(0, y - 20), textWidth + 10, 20);

    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + 5, Math.max(14, y - 6));
  });
}

function updateDetectionTelemetry() {
  $('#framesProcessed').textContent = detectionStats.frames;
  $('#damageDetected').textContent = detectionStats.detected;
  $('#lastInferTime').textContent = `${detectionStats.lastLatency} ms`;
  const avg = detectionStats.frames > 0 && detectionStats.detected > 0
    ? (detectionStats.totalConf / detectionStats.detected).toFixed(2)
    : '—';
  $('#avgConfidence').textContent = avg;
}

// Webcam stream controls
async function startWebcam() {
  stopIpcam();
  const video = $('#webcamVideo');
  const preview = $('#previewImage');
  const placeholder = $('#cameraPlaceholder');

  preview.style.display = 'none';
  video.style.display = 'block';
  placeholder.style.display = 'none';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'environment' }
    });
    webcamStream = stream;
    video.srcObject = stream;
    await video.play();

    isDetecting = true;
    $('#startDetection').disabled = true;
    $('#stopDetection').disabled = false;
    $('#cameraTag').textContent = 'LIVE WEBCAM';
    $('#cameraTag').style.color = '#35d99a';

    const offscreen = document.createElement('canvas');
    offscreen.width = 640;
    offscreen.height = 480;
    const captureFrameAndDetect = async () => {
      if (!isDetecting || !video.videoWidth) return;
      const ctx = offscreen.getContext('2d');
      ctx.drawImage(video, 0, 0, 640, 480);
      const frameData = offscreen.toDataURL('image/jpeg', 0.75);
      await runInferenceOnImage(frameData);
      if (isDetecting) {
        detectionLoopId = setTimeout(captureFrameAndDetect, 1000);
      }
    };
    detectionLoopId = setTimeout(captureFrameAndDetect, 500);
  } catch (err) {
    toast('Camera Notice', 'Integrated webcam unavailable. Please use IP Webcam or Upload Photo.', 'error');
    stopWebcam();
  }
}

function stopWebcam() {
  isDetecting = false;
  if (detectionLoopId) {
    clearTimeout(detectionLoopId);
    detectionLoopId = null;
  }
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }
  const video = $('#webcamVideo');
  if (video) {
    video.pause();
    video.srcObject = null;
    video.style.display = 'none';
  }
  $('#startDetection').disabled = false;
  $('#stopDetection').disabled = true;
  $('#cameraTag').textContent = 'STANDBY';
  $('#cameraTag').style.color = '#9cafc2';

  const canvas = $('#overlayCanvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// Diagnostics check
async function runDiagnostics() {
  $('#diagApi').textContent = 'Pinging...';
  $('#diagDb').textContent = 'Pinging...';
  $('#diagModel').textContent = 'Checking...';

  const health = await fetchHealth();
  if (health) {
    $('#diagApi').textContent = `Node.js Express (Port 3000) — UP`;
    $('#diagApiPill').className = 'status-pill fixed';
    $('#diagApiPill').textContent = 'Operational';

    $('#diagDb').textContent = `MongoDB Atlas Cluster: ${health.database}`;
    $('#diagDbPill').className = health.database === 'Connected' ? 'status-pill fixed' : 'status-pill open';
    $('#diagDbPill').textContent = health.database;
  } else {
    $('#diagApi').textContent = 'Not reachable';
    $('#diagApiPill').className = 'status-pill open';
    $('#diagApiPill').textContent = 'Offline';
  }

  try {
    const res = await apiFetch('/api/detect/status');
    const data = await res.json();
    if (data.success && data.model) {
      $('#diagModel').textContent = `${data.model.name} (${(data.model.sizeBytes / (1024*1024)).toFixed(1)} MB)`;
      $('#diagModelPill').className = data.model.available ? 'status-pill fixed' : 'status-pill open';
      $('#diagModelPill').textContent = data.model.available ? 'Ready' : 'Missing';
    }
  } catch (e) {
    $('#diagModel').textContent = 'Inference service offline';
    $('#diagModelPill').className = 'status-pill open';
    $('#diagModelPill').textContent = 'Offline';
  }
}

// Master Render
function renderAllViews() {
  updateStatsUI();
  renderRecentReports();
  renderAttention();
  renderReportsTable();
  renderAdminTable();
  renderDashboardMarkers();
  renderExplorerMarkers();
}

// Proximity search via backend /api/potholes/search
async function searchNearbyPotholes(lat, lng, radius = 5000) {
  try {
    const res = await apiFetch(`/api/potholes/search?latitude=${lat}&longitude=${lng}&radius=${radius}`);
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error?.message || 'Nearby search is unavailable.');
    if (Array.isArray(data.potholes)) {
      toast('Proximity Search', `Found ${data.count} reported hazard(s) within ${radius/1000} km`);
      return data.potholes.map(item => {
        const d = item.data || {};
        const itLat = item.coordinate?.latitude ?? (item.location?.coordinates ? item.location.coordinates[1] : lat);
        const itLng = item.coordinate?.longitude ?? (item.location?.coordinates ? item.location.coordinates[0] : lng);
        return {
          id: item.uuid,
          type: item.type || 'pothole',
          title: d.roadName ? `${d.roadName} Pothole` : `Pothole ${item.uuid.substring(0, 8)}`,
          road: d.roadName || 'Unnamed Road',
          area: d.locality || d.city || 'Local Area',
          city: d.city || 'Local Area',
          severity: d.severity || 'medium',
          status: d.status || 'open',
          reported: 'Nearby',
          date: item.createdAt ? new Date(item.createdAt).toISOString().split('T')[0] : 'Today',
          lat: Number(itLat),
          lng: Number(itLng),
          description: d.description || '',
          photo: validReportPhoto(d.photo) ? d.photo : null
        };
      });
    }
    return [];
  } catch (err) {
    throw err;
  }
}

// Event Listeners Initialization
function initEvents() {
  // Navigation
  $$('[data-view]').forEach(b => b.addEventListener('click', () => goToView(b.dataset.view)));
  $$('[data-go]').forEach(b => b.addEventListener('click', () => goToView(b.dataset.go)));
  $('#menuButton')?.addEventListener('click', () => {
    const open = $('#sidebar').classList.toggle('open');
    document.body.classList.toggle('nav-is-open', open);
    $('#menuButton').setAttribute('aria-expanded', String(open));
    syncNavigationAccess();
  });
  $('#sidebarScrim')?.addEventListener('click', () => {
    $('#sidebar').classList.remove('open');
    document.body.classList.remove('nav-is-open');
    $('#menuButton').setAttribute('aria-expanded', 'false');
    syncNavigationAccess();
    $('#menuButton').focus();
  });

  // Refresh
  $('#refreshButton')?.addEventListener('click', async () => {
    toast('Refreshing...', 'Fetching latest data from MongoDB Atlas');
    await fetchReports();
    await fetchStats();
  });

  // Table filters
  const resetPage = () => { reportPage = 1; renderReportsTable(); };
  $('#reportSearch')?.addEventListener('input', e => {
    $('#globalSearch').value = e.target.value;
    resetPage();
  });
  $('#globalSearch')?.addEventListener('input', (e) => {
    if ($('#reportSearch')) $('#reportSearch').value = e.target.value;
    if (e.target.value.trim()) goToView('reports');
    resetPage();
  });
  $('#statusFilter')?.addEventListener('change', resetPage);
  $('#prevPageBtn')?.addEventListener('click', () => { reportPage--; renderReportsTable(); });
  $('#nextPageBtn')?.addEventListener('click', () => { reportPage++; renderReportsTable(); });
  $('#retryReports')?.addEventListener('click', fetchReports);
  $('#resetFilters')?.addEventListener('click', () => {
    nearbyReportIds = null;
    $('#filterNearMeReports').setAttribute('aria-pressed', 'false');
    if ($('#reportSearch')) $('#reportSearch').value = '';
    if ($('#globalSearch')) $('#globalSearch').value = '';
    if ($('#statusFilter')) $('#statusFilter').value = 'all';
    resetPage();
  });

  // Map filters & layers
  $('#mapSearch')?.addEventListener('input', renderDashboardMarkers);
  $('#explorerSearch')?.addEventListener('input', () => renderExplorerMarkers());

  $('#streetLayer')?.addEventListener('click', () => {
    $('#streetLayer').classList.add('active');
    $('#satelliteLayer').classList.remove('active');
    if (dashboardMap) {
      dashboardMap.eachLayer(l => { if (l instanceof L.TileLayer) dashboardMap.removeLayer(l); });
      L.tileLayer(STREET_TILE, { maxZoom: 19 }).addTo(dashboardMap);
    }
  });

  $('#satelliteLayer')?.addEventListener('click', () => {
    $('#satelliteLayer').classList.add('active');
    $('#streetLayer').classList.remove('active');
    if (dashboardMap) {
      dashboardMap.eachLayer(l => { if (l instanceof L.TileLayer) dashboardMap.removeLayer(l); });
      L.tileLayer(SAT_TILE, { maxZoom: 19 }).addTo(dashboardMap);
    }
  });

  // Geolocation in Map Explorer
  $('#locateButton')?.addEventListener('click', async () => {
    try {
      toast('GPS Location', 'Acquiring high-accuracy device GPS coordinates...');
      const coords = await getPreciseGpsCoordinates(12000);
      if (explorerMap) {
        explorerMap.setView([coords.lat, coords.lng], 16);
        if (userLocationMarker) explorerMap.removeLayer(userLocationMarker);
        userLocationMarker = L.marker([coords.lat, coords.lng], { icon: createUserGpsPin() })
          .addTo(explorerMap)
          .bindPopup(`<b>Your Verified Location</b><br><small>${coords.city ? coords.city + ' · ' : ''}${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}</small>`)
          .openPopup();
        $('#mapLocNote').innerHTML = `<span><i class="legend-dot" style="background:#2477e8;"></i> Centered on device GPS: ${coords.city ? coords.city + ' ' : ''}(${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})</span>`;
      }
    } catch (err) {
      toast('GPS Error', err.message, 'error');
    }
  });

  // Proximity Search on Map Explorer
  $('#filterNearMeMap')?.addEventListener('click', async () => {
    try {
      toast('Nearby Search', 'Searching potholes within 5 km of your location...');
      const coords = await getPreciseGpsCoordinates(10000);
      const nearby = await searchNearbyPotholes(coords.lat, coords.lng, 5000);
      renderExplorerMarkers(nearby);
      if (explorerMap) {
        explorerMap.setView([coords.lat, coords.lng], 14);
      }
    } catch (err) {
      toast('Geolocation Error', err.message, 'error');
    }
  });

  // Proximity Search on Reports List
  $('#filterNearMeReports')?.addEventListener('click', async () => {
    try {
      toast('Nearby Reports', 'Filtering reports within 5 km...');
      const coords = await getPreciseGpsCoordinates(10000);
      const nearby = await searchNearbyPotholes(coords.lat, coords.lng, 5000);
      nearbyReportIds = new Set(nearby.map(report => report.id));
      $('#filterNearMeReports').setAttribute('aria-pressed', 'true');
      resetPage();
      toast('Nearby Filter Active', `${nearby.length} hazard(s) within 5 km. Use Reset filters to show all reports.`);
    } catch (err) {
      toast('Geolocation Error', err.message, 'error');
    }
  });

  // Geolocation in Submit Form
  $('#getLocation')?.addEventListener('click', async () => {
    const status = $('#locationStatus');
    status.textContent = 'Acquiring high-accuracy device GPS...';
    try {
      const coords = await getPreciseGpsCoordinates(12000);
      await setSubmitLocation(coords.lat, coords.lng, 'gps', coords.accuracy);
      toast('Location Acquired', `Coordinates set to ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`);
    } catch (err) {
      status.textContent = 'Click anywhere on map to set coordinates.';
      toast('GPS Notice', err.message, 'error');
    }
  });
  ['#latitude', '#longitude'].forEach(selector => $(selector)?.addEventListener('change', () => {
    const latValue = $('#latitude').value.trim(), lngValue = $('#longitude').value.trim();
    const lat = Number(latValue), lng = Number(lngValue);
    if (latValue && lngValue && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      setSubmitLocation(lat, lng);
    }
  }));

  // Admin filter tabs
  $$('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.admin-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderAdminTable(tab.dataset.adminFilter);
    });
  });

  // Form submission
  $('#reportForm')?.addEventListener('submit', submitReport);
  $('#reportForm')?.addEventListener('reset', () => { clearReportPhoto(); resetSubmitLocation(); });
  $('#removeReportPhoto')?.addEventListener('click', clearReportPhoto);
  $('#uploadZone')?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      $('#photoInput').click();
    }
  });

  // Photo upload in Submit form
  $('#photoInput')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) attachReportPhoto(file, file.name);
  });

  // Live Detection events
  $('#startDetection')?.addEventListener('click', startWebcam);
  $('#stopDetection')?.addEventListener('click', stopWebcam);

  // IP Webcam events
  $('#connectIpcamBtn')?.addEventListener('click', startIpcam);
  $('#stopIpcamBtn')?.addEventListener('click', stopIpcam);

  $$('.preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const p = chip.dataset.preset;
      const input = $('#ipcamUrlInput');
      const currentHost = input.value ? input.value.split(':')[0] + ':' + (input.value.split(':')[1] || '//192.168.1.5') : 'http://192.168.1.5';
      if (p === 'android') input.value = 'http://192.168.1.5:8080/shot.jpg';
      else if (p === 'droidcam') input.value = 'http://192.168.1.5:4747/cam/1/frame.jpg';
      else if (p === 'esp32') input.value = 'http://192.168.1.5:81/stream';
      toast('Preset Applied', `Set format for ${chip.textContent}`);
    });
  });

  $('#uploadDetectionBtn')?.addEventListener('click', () => {
    $('#detectionFileInput').click();
  });

  $('#detectionFileInput')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      stopWebcam();
      stopIpcam();
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const preview = $('#previewImage');
        $('#webcamVideo').style.display = 'none';
        $('#cameraPlaceholder').style.display = 'none';
        preview.style.display = 'block';
        preview.src = evt.target.result;
        await runInferenceOnImage(evt.target.result);
      };
      reader.readAsDataURL(file);
    }
  });

  // 1-Click Instant Pin from Live Detection to Map & DB
  $('#instantPinBtn')?.addEventListener('click', async () => {
    if (lastDetectionResult && lastDetectionResult.detections && lastDetectionResult.detections.length > 0) {
      const topDet = lastDetectionResult.detections[0];
      await registerDetectionToMap(topDet, topDet.confidence, true);
    } else {
      toast('No Detection in Current Frame', 'Waiting for pothole detection in camera feed.', 'error');
    }
  });

  // Auto-Register switch
  $('#autoRegisterToggle')?.addEventListener('change', (e) => {
    isAutoRegisterEnabled = e.target.checked;
    if (isAutoRegisterEnabled) {
      toast('⚡ Auto-Register Enabled', 'Detected potholes will be automatically pinned to the map using GPS (8s anti-duplicate cooldown)!');
    } else {
      toast('Auto-Register Disabled', 'Manual registration active.');
    }
  });

  // Detailed Report Pre-fill with GPS and Confidence
  $('#createReportFromDetectBtn')?.addEventListener('click', async () => {
    const photo = lastDetectionResult?.photo;
    goToView('submit');
    if (photo) attachReportPhoto(photo);
    $('#damageType').value = 'pothole';
    if (lastDetectionResult && lastDetectionResult.detections && lastDetectionResult.detections[0]) {
      const conf = Math.round(lastDetectionResult.detections[0].confidence * 100);
      if ($('#description')) {
        $('#description').value = `Auto-detected road pothole with YOLO11s model (${conf}% confidence).`;
      }
    }
    try {
      toast('Pre-filling Coordinates', 'Setting exact GPS coordinates on mini-map...');
      const coords = await getPreciseGpsCoordinates();
      await setSubmitLocation(coords.lat, coords.lng, 'gps', coords.accuracy);
    } catch (e) {}
  });

  // Source tabs in detection (Webcam, IP Webcam, Upload)
  $$('.source-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.source-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeSource = tab.dataset.source;

      stopWebcam();
      stopIpcam();

      if (activeSource === 'webcam') {
        $('#ipcamPanel').style.display = 'none';
        $('#uploadPanel').style.display = 'none';
        $('#cameraDeviceSelectGroup').style.display = 'grid';
        $('#startDetection').style.display = 'inline-flex';
        $('#stopDetection').style.display = 'inline-flex';
      } else if (activeSource === 'ipcam') {
        $('#ipcamPanel').style.display = 'flex';
        $('#uploadPanel').style.display = 'none';
        $('#cameraDeviceSelectGroup').style.display = 'none';
        $('#startDetection').style.display = 'none';
        $('#stopDetection').style.display = 'none';
      } else if (activeSource === 'upload') {
        $('#ipcamPanel').style.display = 'none';
        $('#uploadPanel').style.display = 'flex';
        $('#cameraDeviceSelectGroup').style.display = 'none';
        $('#startDetection').style.display = 'none';
        $('#stopDetection').style.display = 'none';
      }
    });
  });

  // Modals & Settings
  $('#modalClose')?.addEventListener('click', closeModal);
  $('#modalCancel')?.addEventListener('click', closeModal);
  $('#modalBackdrop')?.addEventListener('click', e => { if (e.target === $('#modalBackdrop')) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal();
      $('#sidebar').classList.remove('open');
      document.body.classList.remove('nav-is-open');
      $('#menuButton').setAttribute('aria-expanded', 'false');
      syncNavigationAccess();
    }
    if (e.key === 'Tab' && !$('#modalBackdrop').classList.contains('hidden')) {
      const controls = $$('#modalBackdrop button:not([disabled])');
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      $('#globalSearch')?.focus();
    }
  });

  $('#compactToggle')?.addEventListener('change', e => {
    document.body.classList.toggle('compact-mode', e.target.checked);
    savePreferences();
  });
  $('#bannerToggle')?.addEventListener('change', e => {
    $('#statusBanner')?.classList.toggle('hidden', !e.target.checked);
    savePreferences();
  });
  $('#dismissBanner')?.addEventListener('click', () => {
    $('#statusBanner')?.classList.add('hidden');
    $('#bannerToggle').checked = false;
    savePreferences();
  });
  $('#diagCheckBtn')?.addEventListener('click', runDiagnostics);
}

// App Initialization
async function init() {
  initEvents();
  syncNavigationAccess();
  window.matchMedia('(max-width: 960px)').addEventListener('change', syncNavigationAccess);
  restorePreferences();
  await Promise.allSettled([fetchHealth(), checkModelStatus(), fetchReports(), fetchStats()]);
  initDashboardMap();
}

window.addEventListener('DOMContentLoaded', init);
