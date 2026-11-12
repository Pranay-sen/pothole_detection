const mongoose = require('mongoose');

const PotholeSchema = new mongoose.Schema(
  {
    uuid: {
      type: String,
      required: [true, 'UUID is required'],
      unique: true,
      trim: true,
      index: true
    },
    type: {
      type: String,
      required: [true, 'Pothole type is required'],
      trim: true
    },
    coordinate: {
      latitude: {
        type: Number,
        required: [true, 'Latitude is required'],
        min: [-90, 'Latitude must be between -90 and 90'],
        max: [90, 'Latitude must be between -90 and 90']
      },
      longitude: {
        type: Number,
        required: [true, 'Longitude is required'],
        min: [-180, 'Longitude must be between -180 and 180'],
        max: [180, 'Longitude must be between -180 and 180']
      }
    },
    // GeoJSON Point format for MongoDB geospatial queries
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude] as per GeoJSON specification
        required: true
      }
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        delete ret.__v;
        return ret;
      }
    }
  }
);

// 2dsphere index on GeoJSON location for spatial search ($near, $geoWithin, etc.)
PotholeSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Pothole', PotholeSchema);
