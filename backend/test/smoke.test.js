const assert = require('assert');
const app = require('../src/app');

// Quick smoke test to ensure routes and middleware are correctly mounted
console.log('Testing App Route configuration...');

const routes = [];
app._router.stack.forEach((middleware) => {
  if (middleware.route) {
    routes.push(Object.keys(middleware.route.methods).join(',').toUpperCase() + ' ' + middleware.route.path);
  } else if (middleware.name === 'router') {
    const prefix = middleware.regexp.source.includes('detect') ? '/api/detect' : '/api/potholes';
    middleware.handle.stack.forEach((handler) => {
      if (handler.route) {
        routes.push(Object.keys(handler.route.methods).join(',').toUpperCase() + ' ' + prefix + handler.route.path);
      }
    });
  }
});

console.log('Registered Routes:\n', routes.join('\n'));

// Assert essential routes exist
assert(routes.some(r => r.includes('/api/potholes/search')), 'Search route should be registered');
assert(routes.some(r => r.includes('POST') && r.includes('/api/potholes/')), 'POST route should be registered');
assert(routes.some(r => r.includes('DELETE') && r.includes('/api/potholes/:uuid')), 'DELETE route should be registered');
assert(routes.includes('POST /api/detect/'), 'Detection route should be registered');
assert(routes.includes('GET /api/detect/status'), 'Model status route should be registered');

console.log('\nAll route smoke tests passed successfully!');
