/* =====================================================================
   Admin Map — Pothole Management
   - Fetches potholes from /admin/potholes (includes status field)
   - Allows marking potholes as fixed or restoring them
   - Polls /status for detection thread state
   ===================================================================== */

const DEFAULT_CENTER = [28.6139, 77.209];
const POLL_MS = 6000;

let map;
let markersLayer;
let showFixed = false;
let allPotholes = [];
let userMarker = null;
let mapCenteredOnUser = false;

/* ── Map init ──────────────────────────────────────────────── */
function initMap() {
    map = L.map('map', {
        zoomControl: false,
        preferCanvas: true,
    }).setView(DEFAULT_CENTER, 13);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    markersLayer = L.layerGroup().addTo(map);
}

/* ── User geolocation ──────────────────────────────────────── */
function getUserLocation() {
    if (!navigator.geolocation) return;

    navigator.geolocation.watchPosition(
        function (pos) {
            var lat = pos.coords.latitude;
            var lng = pos.coords.longitude;

            if (!userMarker) {
                userMarker = L.circleMarker([lat, lng], {
                    radius: 10,
                    color: '#3b82f6',
                    weight: 3,
                    fillColor: '#60a5fa',
                    fillOpacity: 0.8,
                }).addTo(map);
                userMarker.bindPopup('📍 Your location');
            } else {
                userMarker.setLatLng([lat, lng]);
            }

            if (!mapCenteredOnUser) {
                map.setView([lat, lng], 14);
                mapCenteredOnUser = true;
            }
        },
        function (err) {
            console.warn('Location access denied or unavailable.', err);
        },
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 }
    );
}

/* ── Toast notifications ───────────────────────────────────── */
function showToast(message, type) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type || '');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(30px)';
        toast.style.transition = 'all 300ms';
        setTimeout(function () { toast.remove(); }, 300);
    }, 3500);
}

/* ── Fetch potholes ────────────────────────────────────────── */
async function fetchPotholes() {
    try {
        var resp = await fetch('/admin/potholes');
        var data = await resp.json();
        allPotholes = data;
        renderMarkers();
    } catch (e) {
        console.error('Failed to fetch potholes:', e);
    }
}

/* ── Fetch system status ───────────────────────────────────── */
async function fetchStatus() {
    try {
        var resp = await fetch('/status');
        var data = await resp.json();
        document.getElementById('detectStatus').textContent =
            data.detection_running ? 'Running' : 'Stopped';
    } catch (_) {
        document.getElementById('detectStatus').textContent = '—';
    }
}

/* ── Render markers ────────────────────────────────────────── */
function renderMarkers() {
    markersLayer.clearLayers();

    var activeCount = 0;
    var fixedCount = 0;

    allPotholes.forEach(function (p) {
        var status = p.status || 'active';
        if (status === 'active') activeCount++;
        else fixedCount++;

        if (status === 'fixed' && !showFixed) return;

        var isFixed = status === 'fixed';
        var isUser = p.location_source === 'user_upload';
        var color = isFixed ? '#10b981' : (isUser ? '#f59e0b' : '#ff2d55');
        var borderColor = isFixed ? '#059669' : (isUser ? '#d97706' : '#ff6b6b');

        var marker = L.circleMarker([p.lat, p.lng], {
            radius: isFixed ? 7 : 9,
            color: borderColor,
            weight: 2,
            fillColor: color,
            fillOpacity: isFixed ? 0.5 : 0.85,
        });

        var imageHtml = p.image_path
            ? '<img src="' + p.image_path + '" alt="Detection">'
            : '';

        var timestamp = 'Unknown';
        if (p.timestamp) {
            try {
                var d = new Date(p.timestamp.replace(' ', 'T'));
                timestamp = d.toLocaleString('en-IN', {
                    day: 'numeric', month: 'short', year: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                });
            } catch (_) { timestamp = p.timestamp; }
        }

        var statusBadge = isFixed
            ? '<span class="status-badge fixed">FIXED</span>'
            : '<span class="status-badge active">ACTIVE</span>';

        var sourceLabel = isUser ? '📱 User Report' : '📹 CCTV Detection';

        var btnHtml = isFixed
            ? '<button class="popup-btn restore" onclick="restorePothole(' + p.id + ', this)">Restore 🔄</button>'
            : '<button class="popup-btn fix" onclick="markFixed(' + p.id + ', this)">Mark as Fixed ✅</button>';

        var popupHtml =
            '<div class="popup-inner">' +
                imageHtml +
                '<strong>Pothole #' + p.id + statusBadge + '</strong>' +
                '<p>📅 ' + timestamp + '</p>' +
                '<p>📍 ' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) + '</p>' +
                '<p>🎯 ' + (p.confidence * 100).toFixed(1) + '% confidence</p>' +
                '<p>' + sourceLabel + '</p>' +
                btnHtml +
            '</div>';

        marker.bindPopup(popupHtml, { maxWidth: 280 });
        marker.addTo(markersLayer);
    });

    document.getElementById('activeCount').textContent = activeCount;
    document.getElementById('fixedCount').textContent = fixedCount;
}

/* ── Toggle fixed potholes ─────────────────────────────────── */
function toggleFixed() {
    showFixed = document.getElementById('showFixedToggle').checked;
    renderMarkers();
}

/* ── Mark pothole as fixed ─────────────────────────────────── */
async function markFixed(id, btn) {
    btn.disabled = true;
    btn.textContent = 'Processing...';
    try {
        var resp = await fetch('/remove_pothole/' + id, { method: 'POST' });
        var data = await resp.json();
        if (resp.ok) {
            showToast('✅ Pothole #' + id + ' marked as fixed. CCTV stays active.', 'success');
            map.closePopup();
            await fetchPotholes();
        } else {
            showToast('❌ ' + (data.error || 'Failed'), 'error');
            btn.disabled = false;
            btn.textContent = 'Mark as Fixed ✅';
        }
    } catch (e) {
        showToast('❌ Network error', 'error');
        btn.disabled = false;
        btn.textContent = 'Mark as Fixed ✅';
    }
}

/* ── Restore pothole ───────────────────────────────────────── */
async function restorePothole(id, btn) {
    btn.disabled = true;
    btn.textContent = 'Processing...';
    try {
        var resp = await fetch('/restore_pothole/' + id, { method: 'POST' });
        var data = await resp.json();
        if (resp.ok) {
            showToast('🔄 Pothole #' + id + ' restored to active.', 'success');
            map.closePopup();
            await fetchPotholes();
        } else {
            showToast('❌ ' + (data.error || 'Failed'), 'error');
            btn.disabled = false;
            btn.textContent = 'Restore 🔄';
        }
    } catch (e) {
        showToast('❌ Network error', 'error');
        btn.disabled = false;
        btn.textContent = 'Restore 🔄';
    }
}

/* ── Init ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function () {
    initMap();
    getUserLocation();
    fetchPotholes();
    fetchStatus();
    setInterval(fetchPotholes, POLL_MS);
    setInterval(fetchStatus, POLL_MS);
});
