/**
 * ============================================
 * GET  /api/reviews/:storeId?staff=XXX
 *   指定店舗・担当者の未返信口コミ+AIドラフトを返す(LIFF一覧表示用)
 * POST /api/reviews/:storeId/:reviewId/regenerate-draft
 *   AIドラフトを1件だけ作り直す
 * POST /api/reviews/:storeId/:reviewId/post
 *   スタッフが確認・編集した内容で実際にSalonBoardへ返信を投稿する
 *
 * 【本部アカウントについて】
 * config/stores.js の店舗別ログイン(store.salonboard)とは別に、
 * 本部アカウント1つで全店舗の口コミにアクセスする方針のため、
 * 環境変数 SALONBOARD_HQ_ID / SALONBOARD_HQ_PASSWORD_1 / _2 を
 * Renderに設定しておくこと。
 * ============================================
 */

const express = require('express');
const router = express.Router();
const { getStoreConfig, listStores } = require('../config/stores');
const {
  getCachedUnrepliedReviews,
  getCachedUnrepliedReviewsAnyAge,
  updateReviewCache,
  updateReviewDraft,
  removeReviewFromCache,
  logReviewReply,
  getStaffProfileByLineUserId,
} = require('../services/sheetsService');
const {
  loginHQAndGetPage,
  switchToStore,
  fetchUnrepliedReviewSummaries,
  fetchReviewDetail,
  postReviewReply,
} = require('../services/salonboardService');
const { generateReviewReplyDraft } = require('../services/geminiService');

const HQ_SALONBOARD_CONFIG = {
  loginId: process.env.SALONBOARD_HQ_ID,
  passwords: [
    process.env.SALONBOARD_HQ_PASSWORD_1,
    process.env.SALONBOARD_HQ_PASSWORD_2,
  ].filter(Boolean),
};

// config/stores.js の hotpepperSalonId は "sln" + 店舗ID(例: slnH000056993) の形式。
// 口コミチェックで使う店舗IDは "sln" を除いた部分(サロン一覧のリンクid属性と同じ)。
function groupSalonId(store) {
  return (store.hotpepperSalonId || '').replace(/^sln/, '');
}

/**
 * 店舗の未返信口コミ+AIドラフトを返す(LIFF一覧表示用)。
 * @param {object} store config/stores.js の1店舗分の設定
 * @param {string} storeId
 * @returns {Promise<Array<object>>}
 */
async function refreshStoreReviews(store, storeId) {
  const { browser, page } = await loginHQAndGetPage(HQ_SALONBOARD_CONFIG);
  try {
    await switchToStore(page, groupSalonId(store));
    const { reviews: summaries } = await fetchUnrepliedReviewSummaries(page);

    const detailed = [];
    for (const s of summaries) {
      if (!s.reviewId) continue;

      const detail = await fetchReviewDetail(page, s.reviewId);
      const reviewForDraft = { nickname: detail.nickname, body: detail.body, scores: detail.scores };

      let aiDraft = '';
      try {
        aiDraft = await generateReviewReplyDraft(reviewForDraft, store.name, s.staff);
      } catch (draftErr) {
        // ドラフト生成に失敗しても口コミ自体は表示したいので、空文字のまま続行する
        console.error(`ドラフト生成失敗(reviewId=${s.reviewId}): ` + draftErr.message);
      }

      detailed.push({
        reviewId: s.reviewId,
        staff: s.staff,
        nickname: detail.nickname,
        body: detail.body,
        scores: detail.scores,
        aiDraft,
      });
    }

    await updateReviewCache(storeId, detailed);
    return detailed;
  } finally {
    await browser.close();
  }
}

/**
 * GET /api/reviews/me?lineUserId=xxx
 * LINEアカウントに対応する担当者名・店舗を返す(LIFF起動時にまず呼ぶ)。
 * 「スタッフ」タブ(LINE userId | 氏名 | 店舗 | 登録日時 | 種別 | role)を参照。
 *
 * ルート定義順の注意: Expressは上から順にマッチするため、
 * 可変パラメータの ':storeId' より前にこの固定パス 'me' を置くこと。
 * (逆にすると 'me' が :storeId として誤って解釈されてしまう)
 */
router.get('/me', async (req, res) => {
  try {
    const { lineUserId } = req.query;
    if (!lineUserId) {
      return res.status(400).json({ success: false, error: 'lineUserId クエリパラメータが必要です' });
    }

    const profile = await getStaffProfileByLineUserId(lineUserId);
    if (!profile) {
      return res
        .status(404)
        .json({ success: false, error: 'このLINEアカウントに紐づく担当者情報が見つかりません' });
    }

    res.json({ success: true, ...profile });
  } catch (err) {
    console.error('担当者情報取得エラー: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

  /**
     * GET /api/reviews/all?lineUserId=xxx
        * オーナー権限(「スタッフ」タブのrole列がowner)のユーザーのみ、
           * 8店舗全部・全担当者分の未返信口コミをまとめて返す。
              *
                 * ルート定義順の注意: 'me' と同じく、可変パラメータの ':storeId' より
                    * 前にこの固定パス 'all' を置くこと。
                       */
  router.get('/all', async (req, res) => {
        try {
                const { lineUserId } = req.query;
                if (!lineUserId) {
                          return res.status(400).json({ success: false, error: 'lineUserId クエリパラメータが必要です' });
                }

                const profile = await getStaffProfileByLineUserId(lineUserId);
                if (!profile || profile.role !== 'owner') {
                          return res.status(403).json({ success: false, error: 'この画面を見る権限がありません' });
                }

                const allStores = listStores();
                const results = [];

                for (const { id: storeId } of allStores) {
                          const store = getStoreConfig(storeId);
                          const cached = await getCachedUnrepliedReviewsAnyAge(storeId);

                          let reviews;
                          if (cached === null) {
                                              // オーナー全件表示では絶対に待たせない。キャッシュが無い店舗は
                                              // 空扱いで返し、裏で更新をキックするだけにする(でないと複数店舗分の
                                              // 同期スクレイピングでリクエストが長時間化し、503タイムアウトになる)
                                              refreshStoreReviews(store, storeId).catch((err) => {
                                                                    console.error(`初回バックグラウンド更新エラー(store=${storeId}): ` + err.message);
                                              });
                                              reviews = [];
                          } else {
                                      reviews = cached.reviews;
                                      if (cached.isStale) {
                                                    refreshStoreReviews(store, storeId).catch((err) => {
                                                                    console.error(`バックグラウンド更新エラー(store=${storeId}): ` + err.message);
                                                    });
                                      }
                          }

                          reviews.forEach((r) => results.push({ ...r, storeId, storeName: store.name }));
                }

                res.json({ success: true, reviews: results });
        } catch (err) {
                console.error('全件取得エラー: ' + err.message);
                res.status(500).json({ success: false, error: err.message });
        }
  });

router.get('/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { staff } = req.query;
    if (!staff) {
      return res.status(400).json({ success: false, error: 'staff クエリパラメータが必要です' });
    }

    const store = getStoreConfig(storeId);

    // キャッシュを鮮度に関わらず取得(stale-while-revalidate方式)。
    // 完全に初回(キャッシュが1件も無い)の時だけ、その場で同期的に取得する。
    const cached = await getCachedUnrepliedReviewsAnyAge(storeId);

    if (cached === null) {
      const refreshed = await refreshStoreReviews(store, storeId);
      const forStaff = refreshed.filter((r) => r.staff === staff);
      return res.json({ success: true, reviews: forStaff, source: 'live-initial' });
    }

    // キャッシュがあれば古くても即座に返す(体感速度優先)
    const forStaff = cached.reviews.filter((r) => r.staff === staff);
    res.json({
      success: true,
      reviews: forStaff,
      source: cached.isStale ? 'cache-stale' : 'cache-fresh',
    });

    // 古い場合はレスポンスを返した後、裏でこっそり更新しておく(次回アクセス時のため)
    if (cached.isStale) {
      refreshStoreReviews(store, storeId).catch((err) => {
        console.error(`バックグラウンド更新エラー(store=${storeId}): ` + err.message);
      });
    }
  } catch (err) {
    console.error('口コミ一覧取得エラー: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:storeId/:reviewId/regenerate-draft', async (req, res) => {
  try {
    const { storeId, reviewId } = req.params;
    const store = getStoreConfig(storeId);

    const cached = await getCachedUnrepliedReviews(storeId);
    const target = cached ? cached.find((r) => r.reviewId === reviewId) : null;
    if (!target) {
      return res
        .status(404)
        .json({ success: false, error: '対象の口コミがキャッシュに見つかりません(一覧を再読み込みしてください)' });
    }

    const newDraft = await generateReviewReplyDraft(
      { nickname: target.nickname, body: target.body, scores: target.scores },
      store.name,
      target.staff
    );
    await updateReviewDraft(storeId, reviewId, newDraft);
    res.json({ success: true, draft: newDraft });
  } catch (err) {
    console.error('ドラフト再生成エラー: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:storeId/:reviewId/post', async (req, res) => {
  const { storeId, reviewId } = req.params;
  const { staff, nickname, replyContent, replyFrom } = req.body;

  if (!replyContent || !replyContent.trim()) {
    return res.status(400).json({ success: false, error: '返信内容が空です' });
  }
  if (replyContent.length > 500) {
    return res
      .status(400)
      .json({ success: false, error: `返信内容が500字を超えています(${replyContent.length}字)` });
  }

  // Puppeteer処理(ログイン〜投稿)は数十秒かかることがあるため、
  // publish.js と同じく即座に受付レスポンスを返し、実処理はバックグラウンドで継続する。
  res.json({ success: true, message: '投稿を受け付けました' });

  (async () => {
    let result = 'error';
    try {
      const store = getStoreConfig(storeId);
      const { browser, page } = await loginHQAndGetPage(HQ_SALONBOARD_CONFIG);
      try {
        await switchToStore(page, groupSalonId(store));
        await postReviewReply(page, reviewId, { replyContent, replyFrom });
        result = 'success';
      } finally {
        await browser.close();
      }
      await removeReviewFromCache(storeId, reviewId);
      console.log(`口コミ投稿完了: store=${storeId}, reviewId=${reviewId}, staff=${staff}`);
    } catch (err) {
      console.error(`口コミ投稿エラー(store=${storeId}, reviewId=${reviewId}): ` + err.message);
    } finally {
      await logReviewReply({ storeId, reviewId, staff, nickname, replyContent, result }).catch((e) =>
        console.error('ログ記録エラー: ' + e.message)
      );
    }
  })();
});

module.exports = router;
