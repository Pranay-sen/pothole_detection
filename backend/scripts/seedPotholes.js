require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Pothole = require('../src/models/Pothole');

const samplePotholes = [
  {
    uuid: 'pothole-blr-001',
    type: 'deep_crater',
    coordinate: {
      latitude: 12.9752,
      longitude: 77.6094
    },
    location: {
      type: 'Point',
      coordinates: [77.6094, 12.9752] // GeoJSON [lng, lat]
    },
    data: {
      roadName: 'MG Road',
      locality: 'Central Business District',
      city: 'Bengaluru',
      severity: 'critical',
      depthCm: 18,
      widthCm: 65,
      surfaceCondition: 'wet_asphalt',
      reportedBy: 'sensor_car_42',
      priority: 'high',
      status: 'verified'
    }
  },
  {
    uuid: 'pothole-blr-002',
    type: 'surface_pothole',
    coordinate: {
      latitude: 12.9719,
      longitude: 77.6412
    },
    location: {
      type: 'Point',
      coordinates: [77.6412, 12.9719] // GeoJSON [lng, lat]
    },
    data: {
      roadName: '100ft Road',
      locality: 'Indiranagar',
      city: 'Bengaluru',
      severity: 'medium',
      depthCm: 8,
      widthCm: 35,
      surfaceCondition: 'dry_asphalt',
      reportedBy: 'citizen_mobile_app_88',
      priority: 'medium',
      status: 'pending_inspection'
    }
  },
  {
    uuid: 'pothole-blr-003',
    type: 'edge_break',
    coordinate: {
      latitude: 12.9352,
      longitude: 77.6245
    },
    location: {
      type: 'Point',
      coordinates: [77.6245, 12.9352] // GeoJSON [lng, lat]
    },
    data: {
      roadName: '80ft Road',
      locality: 'Koramangala 4th Block',
      city: 'Bengaluru',
      severity: 'low',
      depthCm: 5,
      widthCm: 25,
      surfaceCondition: 'broken_curb_edge',
      reportedBy: 'inspection_drone_07',
      priority: 'low',
      status: 'scheduled'
    }
  },
  {
    uuid: 'pothole-blr-004',
    type: 'manhole_subsidence',
    coordinate: {
      latitude: 12.9279,
      longitude: 77.6805
    },
    location: {
      type: 'Point',
      coordinates: [77.6805, 12.9279] // GeoJSON [lng, lat]
    },
    data: {
      roadName: 'Outer Ring Road (near Bellandur EcoSpace)',
      locality: 'Bellandur',
      city: 'Bengaluru',
      severity: 'high',
      depthCm: 14,
      widthCm: 55,
      surfaceCondition: 'collapsed_manhole_surround',
      reportedBy: 'traffic_patrol_15',
      priority: 'immediate_repair',
      status: 'in_progress'
    }
  }
];

async function seed() {
  try {
    await connectDB();

    console.log('Inserting / Upserting 4 sample potholes into MongoDB Atlas...');

    for (const item of samplePotholes) {
      const saved = await Pothole.findOneAndUpdate(
        { uuid: item.uuid },
        item,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      console.log(`Saved: [${saved.uuid}] ${saved.type} at (${saved.coordinate.latitude}, ${saved.coordinate.longitude})`);
    }

    const totalCount = await Pothole.countDocuments();
    console.log(`Total potholes in database: ${totalCount}`);

    await mongoose.disconnect();
    console.log('Seeding completed successfully!');
  } catch (err) {
    console.error('Seeding failed:', err);
    process.exit(1);
  }
}

seed();
