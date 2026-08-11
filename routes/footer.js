/**
 * ============================================
 * GET  /api/footer/:storeId?lineUserId=xxx  → 現在のフッター取得
 * POST /api/footer/:storeId                 → フッター更新(権限チェックあり)
 * ============================================
 */

const express = require('express');
const router = express.Router();
const {
  getFooterTextForEdit,
  updateFooterText,
  getManagedStoreIds,
} = require('../services/sheetsService');
const { getStoreConfig } = require('../config/stores');

// 現在のフッターテキストを取得(編集画面を開いたときに使う)
router.get('/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params;
    getStoreConfig(storeId); // 存在しない店舗IDならここで例外

    const text = await getFooterTextForEdit(storeId);
    res.json({ success: true, footerText: text });
  } catch (err) {
    console.error('フッター取得エラー: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// フッターを更新する(保存ボタンを押したときに使う)
router.post('/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { lineUserId, footerText } = req.body;

    if (!lineUserId) {
      return res.status(400).json({ success: false, error: 'lineUserIdが指定されていません' });
    }
    if (typeof footerText !== 'string') {
      return res.status(400).json({ success: false, error: 'footerTextが不正です' });
    }

    getStoreConfig(storeId); // 存在しない店舗IDならここで例外

    // サーバー側でも権限を再確認する(フロント側のボタン制御だけに頼らない)
    const editableStoreIds = await getManagedStoreIds(lineUserId);
    if (!editableStoreIds.includes(storeId)) {
      return res.status(403).json({ success: false, error: 'この店舗のフッターを編集する権限がありません' });
    }

    await updateFooterText(storeId, footerText);
    res.json({ success: true, message: 'フッターを更新しました' });
  } catch (err) {
    console.error('フッター更新エラー: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
