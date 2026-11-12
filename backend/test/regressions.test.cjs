const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Pothole = require('../src/models/Pothole');
const controller = require('../src/controllers/potholeController');

function frontend() {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', textContent: '', innerHTML: '', disabled: false,
      style: {}, reset() {}, removeAttribute() {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      focus() {}, setAttribute() {}, querySelectorAll() { return []; }
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [], activeElement: { focus() {} }, body: { style: {} } },
    window: { addEventListener() {}, setTimeout() {} }, console, URLSearchParams,
    AbortSignal, setTimeout, clearTimeout
  });
  const source = fs.readFileSync(require.resolve('../../frontend/app.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  return { run: code => vm.runInContext(code, context), element, context };
}

test('modal status action keeps the selected UUID after closing', async () => {
  const ui = frontend();
  ui.run(`reports = [{ id: 'report-123', title: 'Test', lat: 0, lng: 0 }];
    updateStatusOnServer = async (id, status) => { window.updated = { id, status }; };
    openReport('report-123');`);
  await ui.element('#modalAction').onclick();
  assert.equal(ui.context.window.updated.id, 'report-123');
  assert.equal(ui.context.window.updated.status, 'fixed');
});

test('actual report photo appears in thumbnails and details; absent photos have a neutral placeholder', () => {
  const ui = frontend();
  const photo = 'data:image/jpeg;base64,' + fs.readFileSync(require.resolve('../../frontend/public/samples/pothole_1.jpg')).toString('base64');
  ui.context.samplePhoto = photo;
  ui.run(`reports = [{ id: 'photo-report', title: 'Photo report', lat: 1, lng: 1, photo: samplePhoto }]; openReport('photo-report');`);
  assert.ok(ui.element('#detailContent').innerHTML.includes(photo));
  assert.ok(ui.run('reportThumb(reports[0])').includes(photo));
  assert.match(ui.run('reportThumb({})'), /No photo/);
  assert.ok(!ui.run(`reportThumb({ photo: 'https://untrusted.example/track.jpg' })`).includes('untrusted.example'));
});

test('photo survives report save and invalid/oversized attachments are rejected', async () => {
  const original = Pothole.findOneAndUpdate;
  let stored;
  Pothole.findOneAndUpdate = async (_, doc) => { stored = doc; return doc; };
  const invoke = async photo => {
    let code, response;
    await controller.setPothole({ body: { type: 'pothole', latitude: 1, longitude: 1, data: { photo } } }, {
      status(value) { code = value; return this; }, json(value) { response = value; }
    }, error => { throw error; });
    return { code, response };
  };
  try {
    const photo = 'data:image/jpeg;base64,' + fs.readFileSync(require.resolve('../../frontend/public/samples/pothole_1.jpg')).toString('base64');
    assert.equal((await invoke(photo)).code, 201);
    assert.equal(stored.data.photo, photo);
    for (const invalid of ['https://example.com/image.jpg', 'data:image/svg+xml;base64,PHN2Zz4=', {}, 'data:image/jpeg;base64,YWJj', 'data:image/jpeg;base64,' + 'A'.repeat(1500000)]) {
      assert.equal((await invoke(invalid)).code, 400);
    }
  } finally { Pothole.findOneAndUpdate = original; }
});

test('delete confirmation sends selected UUID, never null', async () => {
  const ui = frontend();
  ui.context.fetch = async url => {
    ui.context.deletedUrl = url;
    return { ok: true, json: async () => ({ success: true }) };
  };
  ui.run(`toast = () => {}; fetchReports = async () => {}; fetchStats = async () => {};
    openDeleteConfirmation({ id: 'report-456', title: 'Test' });`);
  await ui.element('#modalAction').onclick();
  assert.equal(ui.context.deletedUrl, '/api/potholes/report-456');
});

test('manual submission includes prepared photo and clears the attachment after save', async () => {
  const ui = frontend();
  for (const [key, value] of Object.entries({ damageType: 'pothole', roadName: 'Test road', city: 'Test city', latitude: '1', longitude: '2' })) ui.element('#' + key).value = value;
  let payload;
  ui.context.fetch = async (_, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ success: true, data: { uuid: 'test' } }) };
  };
  ui.run(`toast = () => {}; fetchReports = async () => {}; fetchStats = async () => {}; goToView = () => {};
    reportPhotoPromise = Promise.resolve('prepared-photo');`);
  await ui.run('submitReport({ preventDefault() {} })');
  assert.equal(payload.data.photo, 'prepared-photo');
  assert.equal(await ui.run('reportPhotoPromise'), null);
});

test('live registration retains detected frame while newer frames arrive during GPS lookup', async () => {
  const ui = frontend();
  let payload;
  ui.context.fetch = async (url, options) => {
    if (String(url).startsWith('https:')) return { json: async () => ({}) };
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ success: true, data: { uuid: 'test-frame' } }) };
  };
  ui.run(`toast = () => {}; fetchReports = async () => {}; fetchStats = async () => {};
    prepareReportPhoto = async source => source;
    lastDetectionResult = { photo: 'detected-frame' };
    getPreciseGpsCoordinates = async () => {
      lastDetectionResult = { photo: 'newer-frame' };
      return { lat: 1, lng: 2, source: 'gps' };
    };`);
  await ui.run('registerDetectionToMap({}, 0.8)');
  assert.equal(payload.data.photo, 'detected-frame');
});

test('report directory renders at most one page and exposes next page', () => {
  const ui = frontend();
  ui.element('#statusFilter').value = 'all';
  ui.run(`reports = Array.from({ length: 45 }, (_, i) => ({ id: 'r' + i, status: 'open' }));
    reportRow = r => '<tr>' + r.id + '</tr>'; renderReportsTable();`);
  assert.equal((ui.element('#reportTableBody').innerHTML.match(/<tr>/g) || []).length, 20);
  assert.equal(ui.element('#nextPageBtn').disabled, false);
  ui.run('reportPage = 3; renderReportsTable();');
  assert.equal((ui.element('#reportTableBody').innerHTML.match(/<tr>/g) || []).length, 5);
});

test('zero coordinates are valid and blanks are rejected before database access', async () => {
  const original = Pothole.findOneAndUpdate;
  let stored;
  Pothole.findOneAndUpdate = async (_, doc) => { stored = doc; return doc; };
  const invoke = async body => {
    const result = { code: 200 };
    const res = { status(code) { result.code = code; return this; }, json(data) { result.data = data; } };
    await controller.setPothole({ body }, res, error => { throw error; });
    return result;
  };
  try {
    assert.equal((await invoke({ type: 'pothole', latitude: 0, longitude: 0 })).code, 201);
    assert.deepEqual(stored.location.coordinates, [0, 0]);
    for (const value of ['', ' ', null, false, [], {}]) {
      assert.equal((await invoke({ type: 'pothole', coordinate: { latitude: value, longitude: 1 } })).code, 400);
    }
  } finally { Pothole.findOneAndUpdate = original; }
});

test('reports load every API page and coalesce overlapping refreshes', async () => {
  const ui = frontend();
  let calls = 0;
  ui.context.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ success: true, totalPages: 2, data: [{ uuid: `page-${calls}` }] }) };
  };
  ui.run('renderAllViews = () => {};');
  await ui.run('Promise.all([fetchReports(), fetchReports()])');
  assert.equal(calls, 2);
  assert.equal(ui.run('reports.length'), 2);
});

test('failed refresh retains last successful reports and exposes recovery', async () => {
  const ui = frontend();
  ui.context.fetch = async () => ({ ok: false });
  ui.run(`reports = [{ id: 'saved', status: 'open' }]; reportRow = () => '<tr></tr>';`);
  await ui.run('fetchReports()');
  assert.equal(ui.run('reports[0].id'), 'saved');
  assert.match(ui.element('#reportsLoadMessage').textContent, /Showing previously loaded reports/);
  assert.equal(ui.run('reportsLoading'), false);
});

test('nearby search reads the API potholes field and keeps the full directory', async () => {
  const ui = frontend();
  ui.context.fetch = async () => ({ ok: true, json: async () => ({ success: true, count: 1, potholes: [{ uuid: 'nearby-1' }] }) });
  ui.run(`toast = () => {}; reports = [{ id: 'nearby-1' }, { id: 'faraway-2' }];`);
  const result = await ui.run('searchNearbyPotholes(0, 0)');
  assert.equal(result[0].id, 'nearby-1');
  ui.element('#statusFilter').value = 'all';
  ui.run(`nearbyReportIds = new Set(['nearby-1']);`);
  assert.equal(ui.run('filteredReports().length'), 1);
  ui.run('nearbyReportIds = null;');
  assert.equal(ui.run('filteredReports().length'), 2);
});

test('invalid pagination fails before querying MongoDB', async () => {
  for (const value of ['Infinity', '1.5', '-1', '0', 'oops']) {
    let code;
    await controller.getAllPotholes({ query: { page: value } }, {
      status(value) { code = value; return this; }, json() {}
    }, error => { throw error; });
    assert.equal(code, 400);
  }
});

test('submit map does not request GPS or auto-select its initial viewport as damage location', async () => {
  const ui = frontend();
  const handlers = {};
  const map = { setView() { return this; }, on(name, handler) { handlers[name] = handler; } };
  ui.context.L = { map: () => map, tileLayer: () => ({ addTo() {} }) };
  ui.run(`getUserCoordinates = async () => { throw new Error('Unexpected location request'); };
    setSubmitLocation = async () => { window.selected = true; };`);
  await ui.run('initSubmitMiniMap()');
  assert.equal(ui.element('#latitude').value, '');
  assert.match(ui.element('#locationStatus').textContent, /No location selected/);
  assert.equal(ui.context.window.selected, undefined);
  await handlers.click({ latlng: { lat: 1, lng: 2 } });
  assert.equal(ui.context.window.selected, true);
});

test('GPS pin labels show reported accuracy and reset clears selected coordinates', async () => {
  const ui = frontend();
  ui.context.fetch = async () => ({ json: async () => ({}) });
  await ui.run(`setSubmitLocation(12.5, 77.5, 'gps', 1450)`);
  assert.match(ui.element('#locationStatus').textContent, /accuracy ±1450 m/);
  assert.equal(ui.element('#latitude').value, '12.500000');
  ui.run('resetSubmitLocation()');
  assert.equal(ui.element('#latitude').value, '');
  assert.match(ui.element('#locationStatus').textContent, /No location selected/);
});

test('detection confidence averages detections rather than empty frames', () => {
  const ui = frontend();
  ui.run('detectionStats = { frames: 10, detected: 2, totalConf: 1.6, lastLatency: 100 }; updateDetectionTelemetry();');
  assert.equal(ui.element('#avgConfidence').textContent, '0.80');
});

test('statistics uses a single projected query and preserves status totals', async () => {
  const mongoose = require('mongoose');
  const originalFind = Pothole.find;
  const originalCount = Pothole.countDocuments;
  const state = mongoose.connection.readyState;
  let queries = 0, payload;
  mongoose.connection.readyState = 1;
  Pothole.countDocuments = () => { throw new Error('Redundant count query'); };
  Pothole.find = () => {
    queries++;
    return { lean: async () => [ { data: { status: 'open', severity: 'high' } }, { data: { status: 'in_progress' } }, { data: { status: 'resolved' } } ] };
  };
  try {
    await controller.getStats({}, { status() { return this; }, json(data) { payload = data; } }, error => { throw error; });
    assert.equal(queries, 1);
    assert.deepEqual(payload.stats, { total: 3, open: 1, inProgress: 1, fixed: 1, highSeverity: 1 });
  } finally {
    mongoose.connection.readyState = state;
    Pothole.find = originalFind;
    Pothole.countDocuments = originalCount;
  }
});

test('HTTP API rejects malformed JSON, invalid inference and unavailable database', async () => {
  const app = require('../src/app');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const malformed = await fetch(`${base}/api/detect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    const invalid = await fetch(`${base}/api/detect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: {}, confidence: 2 }) });
    assert.equal(invalid.status, 400);
    const unavailable = await fetch(`${base}/api/potholes`);
    assert.equal(unavailable.status, 503);
    assert.match((await unavailable.json()).error.message, /Database unavailable/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
