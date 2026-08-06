/**
 * ============================================
 * POST /api/generate
 * 画像からスタイル分析・ブログ文案を生成する
 * ============================================
 */

const express = require('express');
const router = express.Router();
const { generateAnalysisAndBlog } = require('../services/geminiService');
const { getStoreConfig } = require('../config/stores');

router.post('/', async (req, res) => {
  try {
    const { storeId, ageGroup, mimeType, imageBase64 } = req.body;

    if (!storeId || !mimeType || !imageBase64) {
      return res.status(400).json({ success: false, error: '必須パラメータが不足しています' });
    }

    const store = getStoreConfig(storeId);
    const ageGroupLabel = ageGroup || '幅広い年代';

    const { analysisText, blogText } = await generateAnalysisAndBlog(
      imageBase64,
      mimeType,
      store.name,
      ageGroupLabel
    );

    res.json({ success: true, analysisText, blogText });
  } catch (err) {
    console.error('生成エラー: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
