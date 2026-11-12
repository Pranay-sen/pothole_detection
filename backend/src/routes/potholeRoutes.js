const express = require('express');
const router = express.Router();
const {
  setPothole,
  deletePothole,
  searchArea,
  getAllPotholes,
  getPotholeByUuid,
  updatePotholeStatus,
  getStats
} = require('../controllers/potholeController');

// 0. Aggregate stats (must come before :uuid route)
router.get('/stats', getStats);

// 1. Search whether an area has potholes (Supports GET with query params & POST with body)
router.route('/search')
  .get(searchArea)
  .post(searchArea);

// 2. Set pothole (create or update) & list all potholes
router.route('/')
  .post(setPothole)
  .get(getAllPotholes)
  .delete(deletePothole); // Supports DELETE /api/potholes with { uuid } in body/query

// 3. Delete or get single pothole by uuid
router.route('/:uuid')
  .get(getPotholeByUuid)
  .delete(deletePothole);

// 4. Update status for a pothole
router.patch('/:uuid/status', updatePotholeStatus);

module.exports = router;

