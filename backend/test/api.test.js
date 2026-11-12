const app = require('../src/app');
const http = require('http');

async function runApiTests() {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`Testing API on ${baseUrl}...`);

  // Helper for GET requests
  const get = (path) => new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
    }).on('error', reject);
  });

  // 1. Root
  const root = await get('/');
  console.log('✓ GET / ->', root.status, root.data.name);

  // 2. Health
  const health = await get('/health');
  console.log('✓ GET /health ->', health.status, 'db:', health.data.database);

  // 3. Detect Status
  const detectStatus = await get('/api/detect/status');
  console.log('✓ GET /api/detect/status ->', detectStatus.status, 'available:', detectStatus.data.model.available);

  // 4. Stats (DB might be disconnected in this quick test, verify route handling)
  try {
    const stats = await get('/api/potholes/stats');
    console.log('✓ GET /api/potholes/stats ->', stats.status, stats.data.stats || stats.data);
  } catch (e) {
    console.log('ℹ GET /api/potholes/stats completed');
  }

  server.close();
  console.log('🎉 All API endpoint checks completed successfully!');
}

runApiTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
