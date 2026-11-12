/**
 * RoadWatch development server launcher
 * Starts both backend and frontend dev servers concurrently.
 * Usage: node scripts/dev.js
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const children = [];

function startProcess(name, command, args, cwd) {
  console.log(`\n🚀 Starting ${name}...`);
  const safeArgs = isWin ? args.map(a => a.includes(' ') ? `"${a}"` : a) : args;
  const child = spawn(command, safeArgs, {
    cwd,
    stdio: 'pipe',
    shell: isWin,
    windowsVerbatimArguments: isWin,
    env: { ...process.env }
  });

  child.stdout.on('data', (data) => {
    String(data).split('\n').forEach(line => {
      if (line.trim()) console.log(`[${name}] ${line}`);
    });
  });

  child.stderr.on('data', (data) => {
    String(data).split('\n').forEach(line => {
      if (line.trim()) console.error(`[${name}] ${line}`);
    });
  });

  child.on('error', (err) => {
    console.error(`[${name}] Failed to start: ${err.message}`);
  });

  child.on('exit', (code) => {
    console.log(`[${name}] Exited with code ${code}`);
  });

  children.push(child);
  return child;
}

function shutdown() {
  console.log('\n🛑 Shutting down all services...');
  children.forEach(child => {
    try {
      if (isWin) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch (e) { /* ignore */ }
  });
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', shutdown);

// Start warm YOLO inference server
const inferServerScript = path.join(ROOT, 'scripts', 'infer_server.py');
const fs = require('fs');
if (fs.existsSync(inferServerScript) && fs.existsSync(path.join(ROOT, 'model', 'best.pt'))) {
  startProcess(
    'yolo-ml',
    'python',
    [inferServerScript, '5001'],
    ROOT
  );
}

// Start backend
startProcess(
  'backend',
  'node',
  ['src/server.js'],
  path.join(ROOT, 'backend')
);

// Give backend a moment to start, then start frontend
setTimeout(() => {
  startProcess(
    'frontend',
    'npx',
    ['vite', '--host', '--port', '5173'],
    path.join(ROOT, 'frontend')
  );
}, 1500);

console.log('\n📋 RoadWatch Dev Server');
console.log('   Backend:    http://localhost:3000');
console.log('   Frontend:   http://localhost:5173');
console.log('   Inference:  http://127.0.0.1:5001');
console.log('   Press Ctrl+C to stop all services.\n');

