require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Pothole = require('../src/models/Pothole');

async function testMongo() {
  await connectDB();

  const testUuid = 'test-uuid-quickcheck-999';
  await Pothole.deleteOne({ uuid: testUuid });

  // 1. Create pothole
  const created = await Pothole.create({
    uuid: testUuid,
    type: 'test_pothole',
    coordinate: { latitude: 12.9716, longitude: 77.5946 },
    location: { type: 'Point', coordinates: [77.5946, 12.9716] },
    data: { severity: 'high', test: true }
  });
  console.log('1. Set Pothole OK -> UUID:', created.uuid);

  // 2. Geospatial Search
  const searchResults = await Pothole.find({
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: [77.5946, 12.9716] },
        $maxDistance: 500
      }
    }
  });
  console.log('2. Search Area OK -> Count:', searchResults.length);

  // 3. Delete Pothole
  const deleted = await Pothole.findOneAndDelete({ uuid: testUuid });
  console.log('3. Delete Pothole OK -> Deleted UUID:', deleted.uuid);

  await mongoose.disconnect();
  console.log('✅ All MongoDB CRUD and Geospatial operations verified successfully!');
}

testMongo().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
