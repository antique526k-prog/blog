/**
 * ============================================
 * GET /api/my-stores?lineUserId=xxx
 * ログイン中のLINEユーザーが編集権限を持つ店舗一覧を返す
 * (フッター編集ボタンの活性/非活性判定に使う)
 * ============================================
 */

const express = require('express');
const router = express.Router();
const { getManagedStoreIds } = require('../services/sheetsService');

router.get('/', async (req, res) => {
  try {
    const { lineUserId } = req.query;
    if (!lineUserId) {
      return res.status(400).json({ success: false, error: 'lineUserIdが指定されていません' });
    }

    const storeIds = await getManagedStoreIds(lineUserId);
    res.json({ success: true, editableStoreIds: storeIds });
  } catch (err) {
    console.error('権限取得エラー: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
