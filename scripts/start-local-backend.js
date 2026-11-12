const path = require('node:path');
const { mkdir, access, writeFile } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { MongoBinary, MongoMemoryServer } = require('mongodb-memory-server-core');

const root = path.resolve(__dirname, '..');
const localDir = path.join(root, '.roadwatch');
const dbPath = path.join(localDir, 'data');
const binary = { downloadDir: path.join(localDir, 'mongo-bin'), checkMD5: true };

async function start() {
  if (process.argv.includes('--setup')) {
    await MongoBinary.getPath(binary);
    console.log('Local MongoDB binary is ready.');
    return;
  }

  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(root, '.env') });
  dotenv.config({ path: path.join(root, 'backend', '.env') });
  if (process.env.MONGODB_URL || process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL) {
    require('../backend/src/server');
    return;
  }

  await mkdir(dbPath, { recursive: true });
  const localMongo = await MongoMemoryServer.create({
    binary,
    instance: { ip: '127.0.0.1', dbPath, storageEngine: 'wiredTiger' }
  });
  try {
    process.env.MONGODB_URL = localMongo.getUri('roadwatch');
    const seedMarker = path.join(dbPath, '.demo-seeded');
    if (!await access(seedMarker).then(() => true, () => false)) {
      await promisify(execFile)(process.execPath, [path.join(root, 'backend', 'scripts', 'seedPotholes.js')]);
      await writeFile(seedMarker, 'RoadWatch sample reports installed.\n');
      console.log('Four sample reports are ready.');
    }
    require('../backend/src/server');
  } catch (error) {
    await localMongo.stop({ doCleanup: false });
    throw error;
  }
}

start().catch(error => {
  console.error('RoadWatch database setup failed:', error.message);
  process.exitCode = 1;
});
