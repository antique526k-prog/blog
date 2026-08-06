/**
 * ============================================
 * POST /api/publish
 * GBP・WordPress・SalonBoardへ同時投稿する
 * ============================================
 */

const express = require('express');
const router = express.Router();
const { publishToAllChannels } = require('../services/publishService');

router.post('/', async (req, res) => {
  try {
    const { storeId, mimeType, imageBase64, finalText, stylistId } = req.body;

    if (!storeId || !mimeType || !imageBase64 || !finalText) {
      return res.status(400).json({ success: false, error: '必須パラメータが不足しています' });
    }

    // 投稿処理は数十秒かかることがあるため、先にレスポンスを返し、
    // 実処理はバックグラウンドで継続する(LIFF側は「投稿を受け付けました」と即時表示できる)
    res.json({ success: true, message: '投稿を受け付けました' });

    publishToAllChannels(storeId, finalText, imageBase64, mimeType, stylistId)
      .then((result) => {
        console.log('投稿完了: ' + JSON.stringify({
          gbp: result.gbp.success,
          wp: result.wp.success,
          salonboard: result.salonboard.success,
        }));
      })
      .catch((err) => {
        console.error('バックグラウンド投稿処理でエラー: ' + err.message);
      });
  } catch (err) {
    console.error('投稿受付エラー: ' + err.message);
    // レスポンスを既に返している可能性があるため、二重送信を避ける
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

module.exports = router;
