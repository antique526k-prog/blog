/**
 * ============================================
 * GET /api/stores
 * 店舗一覧を返す(LIFFの店舗プルダウン用)
 * ============================================
 */

const express = require('express');
const router = express.Router();
const { listStores } = require('../config/stores');

router.get('/', (req, res) => {
  res.json({ success: true, stores: listStores() });
});

module.exports = router;
