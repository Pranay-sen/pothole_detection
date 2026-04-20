/* =================================================================
   Pothole Tracker — Public Site JavaScript
   - Full-screen Leaflet map with pothole markers
   - User geolocation tracking
   - Photo upload → YOLO model → DB
   - Auto-refresh every 10 seconds
   ================================================================= */

var map;
var potholeLayer;
var userLocation = null;
var userMarker = null;
var selectedFile = null;
var mapCenteredOnUser = false;

/* ── Map initialisation ────────────────────────────────────── */
function initMap() {
    map = L.map('map', {
        zoomControl: false,
        preferCanvas: true,
    }).setView([28.6139, 77.209], 13);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    potholeLayer = L.layerGroup().addTo(map);
}

/* ── User geolocation ──────────────────────────────────────── */
function getUserLocation() {
    var locationEl = document.getElementById('locationStatus');

    if (!navigator.geolocation) {
        locationEl.innerHTML =
            '<span class="pulse error"></span> Geolocation not supported by this browser';
        return;
    }

    var successCb = function (pos) {
        userLocation = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
        };

        locationEl.innerHTML =
            '<span class="pulse active"></span> Location: ' +
            userLocation.lat.toFixed(5) + ', ' + userLocation.lng.toFixed(5) +
            ' (±' + Math.round(userLocation.accuracy) + ' m)';

        /* Show user marker on map */
        if (!userMarker) {
            userMarker = L.circleMarker([userLocation.lat, userLocation.lng], {
                radius: 10,
                color: '#3b82f6',
                weight: 3,
                fillColor: '#60a5fa',
                fillOpacity: 0.8,
            }).addTo(map);
            userMarker.bindPopup('📍 Your location');
        } else {
            userMarker.setLatLng([userLocation.lat, userLocation.lng]);
        }

        /* Centre map on user location the first time */
        if (!mapCenteredOnUser) {
            map.setView([userLocation.lat, userLocation.lng], 14);
            mapCenteredOnUser = true;
        }

        /* Enable submit button if a photo is selected */
        updateSubmitState();
    };

    var errorCb = function (err) {
        if (err.code === err.PERMISSION_DENIED) {
            locationEl.innerHTML =
                '<span class="pulse error"></span> Location access denied. Please enable location.';
        } else if (err.code === err.TIMEOUT || err.code === err.POSITION_UNAVAILABLE) {
            navigator.geolocation.watchPosition(successCb, function(fallbackErr) {
                locationEl.innerHTML =
                    '<span class="pulse error"></span> Location unavailable.';
            }, { enableHighAccuracy: false, maximumAge: 15000, timeout: 10000 });
        } else {
            locationEl.innerHTML =
                '<span class="pulse error"></span> Location error.';
        }
    };

    navigator.geolocation.watchPosition(successCb, errorCb, { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 });
}

/* ── Fetch and render potholes ─────────────────────────────── */
async function fetchPotholes() {
    try {
        var resp = await fetch('/api/potholes');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var data = await resp.json();
        renderPotholes(data);
    } catch (e) {
        console.error('Failed to fetch potholes:', e);
    }
}

function daysSince(dateStr) {
    if (!dateStr) return -1;
    try {
        var date = new Date(dateStr.replace(' ', 'T'));
        if (isNaN(date.getTime())) return -1;
        var now = new Date();
        return Math.floor((now - date) / (1000 * 60 * 60 * 24));
    } catch (_) {
        return -1;
    }
}

function renderPotholes(potholes) {
    potholeLayer.clearLayers();

    var totalCount = potholes.length;
    var userCount = 0;

    potholes.forEach(function (p) {
        var isUser = p.location_source === 'user_upload';
        if (isUser) userCount++;

        var days = daysSince(p.timestamp);
        var color = isUser ? '#f59e0b' : '#ef4444';
        var border = isUser ? '#d97706' : '#ff6b6b';

        var marker = L.circleMarker([p.lat, p.lng], {
            radius: 9,
            color: border,
            weight: 2,
            fillColor: color,
            fillOpacity: 0.85,
        });

        /* Image */
        var imageHtml = p.image_path
            ? '<img src="' + p.image_path + '" alt="Pothole detection">'
            : '';

        /* Timestamp */
        var timestamp = 'Unknown';
        if (p.timestamp) {
            try {
                var d = new Date(p.timestamp.replace(' ', 'T'));
                timestamp = d.toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                });
            } catch (_) {
                timestamp = p.timestamp;
            }
        }

        /* Days badge */
        var daysLabel, badgeClass;
        if (days < 0) {
            daysLabel = 'Date unknown';
            badgeClass = 'ok';
        } else if (days === 0) {
            daysLabel = 'Reported today';
            badgeClass = 'ok';
        } else if (days === 1) {
            daysLabel = '1 day unfixed';
            badgeClass = days >= 7 ? 'warn' : 'ok';
        } else {
            daysLabel = days + ' days unfixed';
            badgeClass = days >= 7 ? 'warn' : 'ok';
        }

        var sourceLabel = isUser ? '📱 User Report' : '📹 CCTV Detection';

        var popupHtml =
            '<div class="popup-card">' +
                imageHtml +
                '<strong>Pothole #' + p.id +
                    ' <span class="unfixed-badge ' + badgeClass + '">' +
                        (days >= 7 ? '⚠ ' : '') + daysLabel +
                    '</span>' +
                '</strong>' +
                '<p>📅 ' + timestamp + '</p>' +
                '<p>📍 ' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) + '</p>' +
                '<p>🎯 ' + (p.confidence * 100).toFixed(1) + '% confidence</p>' +
                '<p>' + sourceLabel + '</p>' +
            '</div>';

        marker.bindPopup(popupHtml, { maxWidth: 280 });
        marker.addTo(potholeLayer);
    });

    document.getElementById('totalCount').textContent = totalCount;
    document.getElementById('userCount').textContent = userCount;
}

/* ── Upload modal ──────────────────────────────────────────── */
function openUploadModal() {
    document.getElementById('uploadModal').style.display = 'flex';
    document.getElementById('photoPreview').style.display = 'none';
    document.getElementById('uploadPlaceholder').style.display = 'flex';
    document.getElementById('resultMessage').style.display = 'none';
    document.getElementById('submitBtn').disabled = true;
    document.getElementById('photoInput').value = '';
    document.getElementById('submitText').style.display = 'inline';
    document.getElementById('submitSpinner').style.display = 'none';
    selectedFile = null;
}

function closeUploadModal() {
    document.getElementById('uploadModal').style.display = 'none';
}

function previewPhoto(input) {
    if (input.files && input.files[0]) {
        selectedFile = input.files[0];
        var reader = new FileReader();
        reader.onload = function (e) {
            var preview = document.getElementById('photoPreview');
            preview.src = e.target.result;
            preview.style.display = 'block';
            document.getElementById('uploadPlaceholder').style.display = 'none';
            updateSubmitState();
        };
        reader.readAsDataURL(input.files[0]);
    }
}

function updateSubmitState() {
    document.getElementById('submitBtn').disabled = !(selectedFile && userLocation);
}

/* ── Submit report ─────────────────────────────────────────── */
async function submitReport() {
    if (!selectedFile || !userLocation) return;

    var btn = document.getElementById('submitBtn');
    var text = document.getElementById('submitText');
    var spinner = document.getElementById('submitSpinner');
    var result = document.getElementById('resultMessage');

    btn.disabled = true;
    text.style.display = 'none';
    spinner.style.display = 'inline-block';
    result.style.display = 'none';

    var formData = new FormData();
    formData.append('photo', selectedFile);
    formData.append('lat', userLocation.lat);
    formData.append('lng', userLocation.lng);
    if (userLocation.accuracy) {
        formData.append('accuracy', userLocation.accuracy);
    }

    try {
        var resp = await fetch('/api/upload', {
            method: 'POST',
            body: formData,
        });
        var data = await resp.json();

        result.style.display = 'block';
        if (data.detected) {
            result.className = 'result-success';
            result.innerHTML = '✅ ' + data.message;
            /* Refresh the map after a short delay, then close modal */
            setTimeout(function () {
                fetchPotholes();
                closeUploadModal();
            }, 2500);
        } else if (data.error) {
            result.className = 'result-error';
            result.innerHTML = '❌ ' + data.error;
        } else {
            result.className = 'result-info';
            result.innerHTML = 'ℹ️ ' + data.message;
        }
    } catch (e) {
        result.style.display = 'block';
        result.className = 'result-error';
        result.innerHTML = '❌ Upload failed. Please check your connection and try again.';
    } finally {
        text.style.display = 'inline';
        spinner.style.display = 'none';
        btn.disabled = false;
    }
}

/* ── Close modal on backdrop click ─────────────────────────── */
document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'uploadModal') {
        closeUploadModal();
    }
});

/* ── Init ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function () {
    initMap();
    getUserLocation();
    fetchPotholes();

    /* Auto-refresh every 10 seconds */
    setInterval(fetchPotholes, 10000);
});
