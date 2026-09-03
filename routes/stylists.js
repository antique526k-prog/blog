/**
 * ============================================
 * GET /api/stylists/:storeId
 * SalonBoard投稿者一覧を返す(LIFFの投稿者プルダウン用)
 *
 * 【キャッシュの仕組み】
 * stylist_cache シートに24時間以内の記録があればそれを返す(高速)。
 * 無い/古い場合は、この場でSalonBoardにログインして最新を取得し、
 * キャッシュを更新してから返す(この場合は数秒〜十数秒かかる)。
 * これにより、定期実行の仕組み(cron等)を用意せずに
 * 「使われた時に自然に最新化される」設計を実現している。
 * ============================================
 */

const express = require('express');
const router = express.Router();
const { getStoreConfig } = require('../config/stores');
const { getCachedStylists, updateStylistCache } = require('../services/sheetsService');
const { fetchStylistOptions, runSalonboardTask } = require('../services/salonboardService');

router.get('/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params;
    const store = getStoreConfig(storeId);

    const cached = await getCachedStylists(storeId);
    if (cached) {
      return res.json({ success: true, stylists: cached, source: 'cache' });
    }

    // キャッシュが無い、または期限切れの場合はその場で取得。
    // 【重要】口コミ機能等と同じ直列化キューを経由させ、Puppeteerが
    // 同時に複数起動しないようにする。
    const { stylist } = await runSalonboardTask(() => fetchStylistOptions(store));
    await updateStylistCache(storeId, stylist);

    res.json({ success: true, stylists: stylist, source: 'live' });
  } catch (err) {
    console.error('投稿者一覧取得エラー: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
