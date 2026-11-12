const mongoose = require('mongoose');
const Pothole = require('../models/Pothole');
const { v4: uuidv4 } = require('uuid');

/**
 * Helper to normalize and validate coordinates from various input structures:
 * - { latitude, longitude } or { lat, lng }
 * - Array: [latitude, longitude] or [longitude, latitude]
 * - Separate latitude / longitude arguments
 */
const parseCoordinates = (coordinate, lat, lng) => {
  let latitude, longitude;

  if (coordinate) {
    if (typeof coordinate === 'object' && !Array.isArray(coordinate)) {
      latitude = coordinate.latitude !== undefined ? coordinate.latitude : coordinate.lat;
      longitude =
        coordinate.longitude !== undefined
          ? coordinate.longitude
          : coordinate.lng !== undefined
          ? coordinate.lng
          : coordinate.lon;
    } else if (Array.isArray(coordinate) && coordinate.length >= 2) {
      // If array coordinates are given
      // In latitude [-90, 90] and longitude [-180, 180]:
      // If first element exceeds 90 or < -90, it must be longitude [lng, lat]
      if (Math.abs(coordinate[0]) > 90 && Math.abs(coordinate[1]) <= 90) {
        longitude = coordinate[0];
        latitude = coordinate[1];
      } else {
        latitude = coordinate[0];
        longitude = coordinate[1];
      }
    }
  }

  if (latitude === undefined && lat !== undefined) latitude = lat;
  if (longitude === undefined && lng !== undefined) longitude = lng;

  const isNumeric = value => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value));
  if (!isNumeric(latitude) || !isNumeric(longitude)) {
    return null;
  }

  const numLat = Number(latitude);
  const numLng = Number(longitude);

  if (isNaN(numLat) || isNaN(numLng)) {
    return null;
  }

  if (numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) {
    return null;
  }

  return {
    latitude: numLat,
    longitude: numLng
  };
};

/**
 * @desc    Set (Create or Update) a pothole
 * @route   POST /api/potholes
 * @body    { uuid, type, coordinate: { latitude, longitude }, data }
 */
const setPothole = async (req, res, next) => {
  try {
    let { uuid, type, coordinate, data, latitude, longitude, lat, lng } = req.body;
    if (data?.photo !== undefined && data.photo !== null) {
      const photo = data.photo;
      if (typeof photo !== 'string' || photo.length > 1400000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(photo)) {
        return res.status(400).json({ success: false, error: { message: 'Photo must be a JPEG data URL no larger than 1 MB.' } });
      }
      const encoded = photo.slice('data:image/jpeg;base64,'.length);
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length > 1024 * 1024 || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9 || bytes.toString('base64') !== encoded) {
        return res.status(400).json({ success: false, error: { message: 'Photo contains invalid or oversized JPEG data.' } });
      }
    }

    // Validate type
    if (!type || typeof type !== 'string' || !type.trim()) {
      return res.status(400).json({
        success: false,
        error: { message: "Field 'type' is required and must be a non-empty string" }
      });
    }

    // Auto-generate UUID if not provided
    if (!uuid || typeof uuid !== 'string' || !uuid.trim()) {
      uuid = uuidv4();
    } else {
      uuid = uuid.trim();
    }

    // Parse and validate coordinate
    const parsedCoords = parseCoordinates(coordinate, latitude ?? lat, longitude ?? lng);
    if (!parsedCoords) {
      return res.status(400).json({
        success: false,
        error: {
          message:
            "Valid 'coordinate' is required. Provide { latitude: -90..90, longitude: -180..180 } or array [lat, lng]"
        }
      });
    }

    // Upsert pothole (create if doesn't exist, update if uuid already exists)
    const potholeData = {
      uuid,
      type: type.trim(),
      coordinate: {
        latitude: parsedCoords.latitude,
        longitude: parsedCoords.longitude
      },
      location: {
        type: 'Point',
        coordinates: [parsedCoords.longitude, parsedCoords.latitude] // GeoJSON: [longitude, latitude]
      },
      data: data !== undefined ? data : {}
    };

    const pothole = await Pothole.findOneAndUpdate(
      { uuid },
      potholeData,
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    res.status(201).json({
      success: true,
      message: 'Pothole set successfully',
      data: pothole
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete a pothole by UUID
 * @route   DELETE /api/potholes/:uuid or DELETE /api/potholes
 * @param   uuid (in route param, query, or body)
 */
const deletePothole = async (req, res, next) => {
  try {
    const uuid = req.params.uuid || req.query.uuid || (req.body && req.body.uuid);

    if (!uuid || typeof uuid !== 'string' || !uuid.trim()) {
      return res.status(400).json({
        success: false,
        error: { message: "A valid 'uuid' parameter is required to delete a pothole" }
      });
    }

    const deletedPothole = await Pothole.findOneAndDelete({ uuid: uuid.trim() });

    if (!deletedPothole) {
      return res.status(404).json({
        success: false,
        error: { message: `Pothole with uuid '${uuid.trim()}' was not found` }
      });
    }

    res.status(200).json({
      success: true,
      message: `Pothole with uuid '${uuid.trim()}' deleted successfully`,
      data: deletedPothole
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Search whether an area has potholes based on coordinates
 * @route   GET /api/potholes/search or POST /api/potholes/search
 * @query/body { latitude, longitude, radius (in meters, default: 100), limit }
 */
const searchArea = async (req, res, next) => {
  try {
    // Read from query params (GET) or body (POST)
    const source = req.method === 'POST' ? req.body : req.query;
    const { coordinate, latitude, longitude, lat, lng, radius, limit } = source;

    const parsedCoords = parseCoordinates(coordinate, latitude ?? lat, longitude ?? lng);

    if (!parsedCoords) {
      return res.status(400).json({
        success: false,
        error: {
          message:
            "Coordinates are required for area search. Provide 'latitude' (-90..90) and 'longitude' (-180..180) or 'coordinate' object."
        }
      });
    }

    // Default search radius: 100 meters, maximum: 50,000 meters (50km)
    const radiusMeters = Math.min(Math.max(Number(radius) || 100, 1), 50000);
    const resultLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);

    // MongoDB 2dsphere $near query (returns sorted from closest to farthest)
    const potholes = await Pothole.find({
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [parsedCoords.longitude, parsedCoords.latitude]
          },
          $maxDistance: radiusMeters
        }
      }
    }).limit(resultLimit);

    const hasPothole = potholes.length > 0;

    res.status(200).json({
      success: true,
      hasPothole,
      count: potholes.length,
      searchArea: {
        center: {
          latitude: parsedCoords.latitude,
          longitude: parsedCoords.longitude
        },
        radiusMeters
      },
      message: hasPothole
        ? `Found ${potholes.length} pothole(s) in this area within ${radiusMeters}m.`
        : `No potholes found in this area within ${radiusMeters}m.`,
      potholes
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get all potholes (with optional pagination)
 * @route   GET /api/potholes
 */
const getAllPotholes = async (req, res, next) => {
  try {
    for (const key of ['page', 'limit']) {
      if (req.query[key] !== undefined && (!Number.isSafeInteger(Number(req.query[key])) || Number(req.query[key]) < 1)) {
        return res.status(400).json({ success: false, error: { message: `'${key}' must be a positive integer` } });
      }
    }
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const skip = (page - 1) * limit;

    const [potholes, total] = await Promise.all([
      Pothole.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      Pothole.countDocuments()
    ]);

    res.status(200).json({
      success: true,
      count: potholes.length,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      data: potholes
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get single pothole by UUID
 * @route   GET /api/potholes/:uuid
 */
const getPotholeByUuid = async (req, res, next) => {
  try {
    const { uuid } = req.params;
    const pothole = await Pothole.findOne({ uuid });

    if (!pothole) {
      return res.status(404).json({
        success: false,
        error: { message: `Pothole with uuid '${uuid}' not found` }
      });
    }

    res.status(200).json({
      success: true,
      data: pothole
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update a pothole's status (within data field) without overwriting other metadata
 * @route   PATCH /api/potholes/:uuid/status
 * @body    { status: "verified" | "in_progress" | "fixed" | "open" | ... }
 */
const updatePotholeStatus = async (req, res, next) => {
  try {
    const { uuid } = req.params;
    const { status } = req.body;

    if (!status || typeof status !== 'string' || !status.trim()) {
      return res.status(400).json({
        success: false,
        error: { message: "Field 'status' is required and must be a non-empty string" }
      });
    }

    const pothole = await Pothole.findOne({ uuid });
    if (!pothole) {
      return res.status(404).json({
        success: false,
        error: { message: `Pothole with uuid '${uuid}' not found` }
      });
    }

    // Merge status into the existing data object without overwriting other fields
    const existingData = pothole.data && typeof pothole.data === 'object' ? { ...pothole.data } : {};
    existingData.status = status.trim().toLowerCase();

    pothole.data = existingData;
    pothole.markModified('data');
    await pothole.save();

    res.status(200).json({
      success: true,
      message: `Status updated to '${status.trim().toLowerCase()}' for pothole '${uuid}'`,
      data: pothole
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get aggregate statistics from actual database records
 * @route   GET /api/potholes/stats
 */
const getStats = async (req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(200).json({
        success: true,
        dbConnected: false,
        stats: { total: 0, open: 0, inProgress: 0, fixed: 0, highSeverity: 0 }
      });
    }

    const allPotholes = await Pothole.find({}, { data: 1 }).lean();
    const total = allPotholes.length;

    let open = 0;
    let inProgress = 0;
    let fixed = 0;
    let highSeverity = 0;

    allPotholes.forEach(p => {
      const d = p.data || {};
      const status = String(d.status || '').toLowerCase().replace(/[\s_-]+/g, '_');
      const severity = String(d.severity || '').toLowerCase();

      if (status === 'fixed' || status === 'resolved') {
        fixed++;
      } else if (status === 'in_progress' || status === 'pending_inspection') {
        inProgress++;
      } else {
        open++;
      }

      if (severity === 'high' || severity === 'critical') {
        highSeverity++;
      }
    });

    res.status(200).json({
      success: true,
      stats: {
        total,
        open,
        inProgress,
        fixed,
        highSeverity
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  setPothole,
  deletePothole,
  searchArea,
  getAllPotholes,
  getPotholeByUuid,
  updatePotholeStatus,
  getStats
};
