/**
 * ============================================
 * Google Sheets 連携サービス
 *
 * GAS版で SpreadsheetApp / PropertiesService を直接使っていた部分を、
 * Node.js から google-spreadsheet ライブラリ経由でアクセスする形に置き換えたもの。
 *
 * 管理するシート:
 * - footer_master   : 店舗ごとのブログ本文フッター(PublishServiceで使用)
 * - publish_log     : GBP/WordPress投稿結果のログ
 * - stylist_cache    : SalonBoard投稿者一覧のキャッシュ(24時間有効)
 *
 * 【認証について】
 * サービスアカウントのJSONキーを使う。
 * Renderの環境変数 GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY に
 * サービスアカウントの情報を設定し、対象のスプレッドシートを
 * そのサービスアカウントのメールアドレスと共有しておく必要がある。
 * ============================================
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const STYLIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24時間

let cachedDoc = null;

/**
 * スプレッドシートへの接続を取得する(初回のみ認証、以降は使い回す)
 * @returns {Promise<GoogleSpreadsheet>}
 */
async function getSpreadsheetDoc() {
  if (cachedDoc) return cachedDoc;

  const sheetId = process.env.FOOTER_SHEET_ID;
  if (!sheetId) throw new Error('環境変数 FOOTER_SHEET_ID が設定されていません');

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !privateKey) {
    throw new Error(
      '環境変数 GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY が設定されていません'
    );
  }

  const auth = new JWT({
    email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(sheetId, auth);
  await doc.loadInfo();
  cachedDoc = doc;
  return doc;
}

/**
 * シートを取得する。存在しなければ指定したヘッダーで新規作成する。
 * @param {GoogleSpreadsheet} doc
 * @param {string} sheetName
 * @param {string[]} headerValues
 */
async function getOrCreateSheet(doc, sheetName, headerValues) {
  // doc.sheetsByTitle はキャッシュされたスナップショットのため、
  // 他のリクエストで新規作成されたシートを見落とすことがある。
  // 毎回 loadInfo() で最新のシート一覧を取得し直してから判定する。
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle[sheetName];

  if (!sheet) {
    try {
      sheet = await doc.addSheet({ title: sheetName, headerValues });
      await sheet.loadHeaderRow();
      return sheet;
    } catch (createError) {
      // 別のリクエストが同時に同名シートを作成していた場合(競合)は、
      // 再度一覧を取得して既存シートを使う
      await doc.loadInfo();
      sheet = doc.sheetsByTitle[sheetName];
      if (!sheet) throw createError;
    }
  }

  // 既存シートの場合も、ヘッダー行が空(壊れている)なら自己修復する。
  try {
    await sheet.loadHeaderRow();
  } catch (e) {
    console.error(`[${sheetName}] ヘッダー読み込みエラーの詳細: ` + e.message);
    if (String(e.message).includes('No values in the header row')) {
      await sheet.setHeaderRow(headerValues);
      await sheet.loadHeaderRow();
    } else {
      throw e;
    }
  }
  return sheet;
}

// ============================================
// footer_master
// ============================================

/**
 * 店舗IDに対応するフッターテキストを取得する(is_active=trueのものをpriority順に結合)
 * @param {string} storeId
 * @returns {Promise<string>}
 */
async function getFooterText(storeId) {
  const doc = await getSpreadsheetDoc();
  const sheet = await getOrCreateSheet(doc, 'footer_master', ['store_id', 'footer_text', 'is_active', 'priority']);
  const rows = await sheet.getRows();

  const matched = rows
    .filter((row) => {
      const rowStoreId = row.get('store_id');
      const isActive = String(row.get('is_active')).toLowerCase() === 'true';
      return (rowStoreId === storeId || rowStoreId === 'common') && isActive;
    })
    .sort((a, b) => Number(a.get('priority') || 0) - Number(b.get('priority') || 0));

  return matched.map((row) => row.get('footer_text')).join('\n\n');
}

// ============================================
// publish_log
// ============================================

/**
 * 投稿結果をログに記録する
 * @param {string} storeId
 * @param {{success: boolean, error?: string}} gbpResult
 * @param {{success: boolean, error?: string}} wpResult
 * @param {{success: boolean, error?: string}} salonboardResult
 */
async function logPublishResult(storeId, gbpResult, wpResult, salonboardResult) {
  const doc = await getSpreadsheetDoc();
  const sheet = await getOrCreateSheet(doc, 'publish_log', [
    'datetime',
    'store_id',
    'gbp_result',
    'wp_result',
    'salonboard_result',
  ]);

  await sheet.addRow({
    datetime: new Date().toISOString(),
    store_id: storeId,
    gbp_result: gbpResult.success ? '成功' : '失敗: ' + gbpResult.error,
    wp_result: wpResult.success ? '成功' : '失敗: ' + wpResult.error,
    salonboard_result: salonboardResult
      ? salonboardResult.success
        ? '成功'
        : '失敗: ' + salonboardResult.error
      : '未実行',
  });
}

// ============================================
// stylist_cache
// ============================================

/**
 * 店舗の投稿者キャッシュを取得する。
 * 有効期限内(24時間以内)ならキャッシュを返し、古い/存在しない場合は null を返す。
 * @param {string} storeId
 * @returns {Promise<Array<{value: string, text: string}>|null>}
 */
async function getCachedStylists(storeId) {
  const doc = await getSpreadsheetDoc();
  const sheet = await getOrCreateSheet(doc, 'stylist_cache', [
    'store_id',
    'stylist_id',
    'stylist_name',
    'updated_at',
  ]);
  const rows = await sheet.getRows();

  const storeRows = rows.filter((row) => row.get('store_id') === storeId);
  if (storeRows.length === 0) return null;

  const latestUpdatedAt = storeRows
    .map((row) => new Date(row.get('updated_at')).getTime())
    .reduce((max, t) => Math.max(max, t), 0);

  const age = Date.now() - latestUpdatedAt;
  if (age > STYLIST_CACHE_TTL_MS) return null; // 期限切れ

  return storeRows.map((row) => ({
    value: row.get('stylist_id'),
    text: row.get('stylist_name'),
  }));
}

/**
 * 店舗の投稿者キャッシュを更新する(既存の行は削除してから書き直す)
 * @param {string} storeId
 * @param {Array<{value: string, text: string}>} stylists
 */
async function updateStylistCache(storeId, stylists) {
  const doc = await getSpreadsheetDoc();
  const sheet = await getOrCreateSheet(doc, 'stylist_cache', [
    'store_id',
    'stylist_id',
    'stylist_name',
    'updated_at',
  ]);
  const rows = await sheet.getRows();

  // 既存の該当店舗の行を削除(google-spreadsheetは行削除がやや特殊なため、逆順に削除する)
  const storeRows = rows.filter((row) => row.get('store_id') === storeId);
  for (let i = storeRows.length - 1; i >= 0; i--) {
    await storeRows[i].delete();
  }

  const now = new Date().toISOString();
  const newRows = stylists.map((s) => ({
    store_id: storeId,
    stylist_id: s.value,
    stylist_name: s.text,
    updated_at: now,
  }));

  if (newRows.length > 0) {
    await sheet.addRows(newRows);
  }
}

// ============================================
// スタッフ (店長・スタッフのアクセス権限)
// ============================================

/**
 * LINEユーザーIDから、そのユーザーが管理している店舗IDの一覧を取得する
 * @param {string} lineUserId
 * @returns {Promise<string[]>} 管理している店舗IDの配列(該当なしなら空配列)
 */
/**
 * LINEユーザーIDから、そのユーザーが編集権限を持つ店舗IDの一覧を取得する。
 * 既存の「スタッフ」シート(利用者登録シート)を流用しており、
 * 新規のシートは作らない。
 * 列: "LINE userId" / "氏名" / "店舗" / "登録日時" / "種別" / "role"
 * "店舗"列の値は config/stores.js の store_id (style, ritta, merry等)と一致している前提。
 *
 * 権限ルール:
 * - role が "owner" の場合、会社全体の代表者とみなし、
 *   シートの登録店舗に関わらず「全店舗」を編集可能とする。
 * - role が "manager" の場合、そのユーザーIDに紐づく担当店舗のみ編集可能とする。
 * - role が "staff" の場合は編集権限なし(空配列)。
 * @param {string} lineUserId
 * @returns {Promise<string[]>} 編集権限のある店舗IDの配列(該当なしなら空配列)
 */
async function getManagedStoreIds(lineUserId) {
  if (!lineUserId) return [];

  const doc = await getSpreadsheetDoc();
  const sheet = doc.sheetsByTitle['スタッフ'];
  if (!sheet) return [];

  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();

  const myRows = rows.filter((row) => row.get('LINE userId') === lineUserId);
  if (myRows.length === 0) return [];

  const isOwner = myRows.some((row) => row.get('role') === 'owner');
  if (isOwner) {
    // config/stores.js から全店舗IDを取得して返す
    const { STORE_CONFIG } = require('../config/stores');
    return Object.keys(STORE_CONFIG);
  }

  return myRows
    .filter((row) => row.get('role') === 'manager')
    .map((row) => row.get('店舗'))
    .filter(Boolean);
}

// ============================================
// footer_master (編集用: 生のテキストの取得・更新)
// ============================================

/**
 * 指定店舗の、編集画面表示用のフッター生テキストを1件取得する。
 * (getFooterText()は複数行を結合して返す「表示用」だが、
 *  こちらは編集フォームに出す「その店舗の1行だけ」を返す)
 * @param {string} storeId
 * @returns {Promise<string>} 見つからなければ空文字
 */
async function getFooterTextForEdit(storeId) {
  const doc = await getSpreadsheetDoc();
  const sheet = await getOrCreateSheet(doc, 'footer_master', ['store_id', 'footer_text', 'is_active', 'priority']);
  const rows = await sheet.getRows();

  const row = rows.find((r) => r.get('store_id') === storeId);
  return row ? row.get('footer_text') || '' : '';
}

/**
 * 指定店舗のフッターテキストを更新する。該当行がなければ新規作成する。
 * @param {string} storeId
 * @param {string} newText
 */
async function updateFooterText(storeId, newText) {
  const doc = await getSpreadsheetDoc();
  const sheet = await getOrCreateSheet(doc, 'footer_master', ['store_id', 'footer_text', 'is_active', 'priority']);
  const rows = await sheet.getRows();

  const row = rows.find((r) => r.get('store_id') === storeId);
  if (row) {
    row.set('footer_text', newText);
    await row.save();
  } else {
    await sheet.addRow({
      store_id: storeId,
      footer_text: newText,
      is_active: 'TRUE',
      priority: 1,
    });
  }
}
/**
 * ============================================
 * 【追加分】口コミ関連のキャッシュ・ログ
 * sheetsService.js の既存コード(getSpreadsheetDoc, getOrCreateSheet)を
 * そのまま再利用する前提。この内容を sheetsService.js の
 * module.exports の手前に貼り付けてください。
 *
 * 管理するシート(新規):
 * - review_cache     : 未返信口コミ+AIドラフトのキャッシュ(店舗ごと、TTL付き)
 * - review_reply_log : 実際に投稿した返信の記録(監査ログ)
 * ============================================
 */

const REVIEW_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4時間。
// 【変更履歴】以前は30分だったが、本部アカウントへのログイン頻度が高くなりすぎて
// SalonBoard側の認証エラー(セッション競合)を誘発しやすかったため、
// ログイン頻度を下げる目的で4時間に延長した。

const REVIEW_CACHE_HEADERS = [
  'store_id',
  'review_id',
  'staff',
  'nickname',
  'visit_date',
  'score_atmosphere',
  'score_service',
  'score_skill',
  'score_price',
  'score_overall',
  'body',
  'ai_draft',
  'updated_at',
];

const REVIEW_REPLY_LOG_HEADERS = [
  'timestamp',
  'store_id',
  'review_id',
  'staff',
  'nickname',
  'reply_content',
  'result',
];

/**
 * 店舗の未返信口コミキャッシュを取得する。
 * 有効期限内(30分以内)ならキャッシュを返し、古い/存在しない場合は null を返す。
 * @param {string} storeId
 * @returns {Promise<Array<object>|null>}
 */
async function getCachedUnrepliedReviews(storeId) {
  const doc = await getSpreadsheetDoc();
  const sheet = await getOrCreateSheet(doc, 'review_cache', REVIEW_CACHE_HEADERS);
  const rows = await sheet.getRows();

  const storeRows = rows.filter((row) => row.get('store_id') === storeId);
  if (storeRows.length === 0) return null;

  const latestUpdatedAt = storeRows
    .map((row) => new Date(row.get('updated_at')).getTime())
    .reduce((max, t) => Math.max(max, t), 0);

  const age = Date.now() - latestUpdatedAt;
  if (age > REVIEW_CACHE_TTL_MS) return null; // 期限切れ

  return storeRows.map(rowToReviewObject);
}

/**
 * 特定担当者の未返信口コミだけを取得する(LIFF表示用)。
 * キャッシュが無い/古い場合は null を返すので、呼び出し側で
 * fetchUnrepliedReviewSummaries 等を使って再取得すること。
 * @param {string} storeId
 * @param {string} staffName
 * @returns {Promise<Array<object>|null>}
 */
async function getCachedUnrepliedReviewsForStaff(storeId, staffName) {
  const all = await getCachedUnrepliedReviews(storeId);
  if (all === null) return null;
  return all.filter((r) => r.staff === staffName);
}

/**
 * 店舗の未返信口コミキャッシュを丸ごと更新する(スナップショット方式)。
 * 既存の当該店舗の行を削除してから、新しい内容で書き直す。
 * @param {string} storeId
 * @param {Array<object>} reviews [{reviewId, staff, nickname, visitDate, scores, body, aiDraft}]
 */
async function updateReviewCache(storeId, reviews) {
  const doc = await getSpreadsheetDoc();
  const sheet = await getOrCreateSheet(doc, 'review_cache', REVIEW_CACHE_HEADERS);
  const rows = await sheet.getRows();

  // 対象店舗の既存行を削除(後ろから削除しないとインデックスがずれる)
  const storeRows = rows.filter((row) => row.get('store_id') === storeId);
  for (let i = storeRows.length - 1; i >= 0; i--) {
    await storeRows[i].delete();
  }

  const now = new Date().toISOString();
  const newRows = reviews.map((r) => ({
    store_id: storeId,
    review_id: r.reviewId,
    staff: r.staff || '',
    nickname: r.nickname || '',
    visit_date: r.visitDate || '',
    score_atmosphere: r.scores?.['雰囲気'] ?? '',
    score_service: r.scores?.['接客サービス'] ?? '',
    score_skill: r.scores?.['技術・仕上がり'] ?? '',
    score_price: r.scores?.['メニュー・料金'] ?? '',
    score_overall: r.scores?.['総合満足度'] ?? '',
    body: r.body || '',
    ai_draft: r.aiDraft || '',
    updated_at: now,
  }));

  if (newRows.length > 0) {
    await sheet.addRows(newRows);
  }
}

/**
 * 個別の口コミ1件だけドラフトを更新する(「作り直す」ボタン用)。
 * 対象行を探して ai_draft と updated_at だけ書き換える。
 * @param {string} storeId
 * @param {string} reviewId
 * @param {string} newDraft
 */
async function updateReviewDraft(storeId, reviewId, newDraft) {
  const doc = await getSpreadsheetDoc();
  const sheet = await getOrCreateSheet(doc, 'review_cache', REVIEW_CACHE_HEADERS);
  const rows = await sheet.getRows();

  const target = rows.find(
    (row) => row.get('store_id') === storeId && row.get('review_id') === reviewId
  );
  if (!target) {
    throw new Error(`review_cache に該当行が見つかりません: store=${storeId}, reviewId=${reviewId}`);
  }
  target.set('ai_draft', newDraft);
  target.set('updated_at', new Date().toISOString());
  await target.save();
}

/**
 * 投稿完了した口コミをキャッシュから取り除く(次回一覧に出さないため)。
 * @param {string} storeId
 * @param {string} reviewId
 */
async function removeReviewFromCache(storeId, reviewId) {
  const doc = await getSpreadsheetDoc();
  const sheet = await getOrCreateSheet(doc, 'review_cache', REVIEW_CACHE_HEADERS);
  const rows = await sheet.getRows();

  const target = rows.find(
    (row) => row.get('store_id') === storeId && row.get('review_id') === reviewId
  );
  if (target) await target.delete();
}

/**
 * 投稿結果を監査ログに記録する。
 * @param {{storeId: string, reviewId: string, staff: string, nickname: string, replyContent: string, result: 'success'|'error'}} entry
 */
async function logReviewReply(entry) {
  const doc = await getSpreadsheetDoc();
  const sheet = await getOrCreateSheet(doc, 'review_reply_log', REVIEW_REPLY_LOG_HEADERS);
  await sheet.addRow({
    timestamp: new Date().toISOString(),
    store_id: entry.storeId,
    review_id: entry.reviewId,
    staff: entry.staff || '',
    nickname: entry.nickname || '',
    reply_content: entry.replyContent || '',
    result: entry.result || '',
  });
}

function rowToReviewObject(row) {
  return {
    reviewId: row.get('review_id'),
    staff: row.get('staff'),
    nickname: row.get('nickname'),
    visitDate: row.get('visit_date'),
    scores: {
      雰囲気: numOrUndefined(row.get('score_atmosphere')),
      接客サービス: numOrUndefined(row.get('score_service')),
      '技術・仕上がり': numOrUndefined(row.get('score_skill')),
      'メニュー・料金': numOrUndefined(row.get('score_price')),
      総合満足度: numOrUndefined(row.get('score_overall')),
    },
    body: row.get('body'),
    aiDraft: row.get('ai_draft'),
    updatedAt: row.get('updated_at'),
  };
}

function numOrUndefined(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * 【追加分】sheetsService.js に追加。module.exports の手前に貼り付け、
 * exportsに getStaffProfileByLineUserId を追加すること。
 *
 * 既存の「スタッフ」タブ(LINE userId | 氏名 | 店舗 | 登録日時 | 種別 | role)
 * から、LINE userIdに対応する氏名・店舗を引く。
 */

/**
 * LINE userIdに対応する担当者情報を取得する。
 * @param {string} lineUserId
 * @returns {Promise<{staffName: string, storeId: string, role: string}|null>}
 */
async function getStaffProfileByLineUserId(lineUserId) {
  const doc = await getSpreadsheetDoc();
  const sheet = await getOrCreateSheet(doc, 'スタッフ', [
    'LINE userId',
    '氏名',
    '店舗',
    '登録日時',
    '種別',
    'role',
  ]);
  const rows = await sheet.getRows();

  const row = rows.find((r) => r.get('LINE userId') === lineUserId);
  if (!row) return null;

  return {
    staffName: row.get('氏名'),
    storeId: row.get('店舗'),
    role: row.get('role'),
  };
}

/**
 * 【追加分】sheetsService.js に追加。module.exports の手前に貼り付け、
 * exportsに getCachedUnrepliedReviewsAnyAge を追加すること。
 *
 * 既存の getCachedUnrepliedReviews は「30分以内でなければnullを返す」ため、
 * 呼び出し側はキャッシュが古いと必ずSalonBoardへの同期取得を待つことになり、
 * LIFF表示が遅くなる原因になっていた。
 *
 * この関数は鮮度に関わらずキャッシュをそのまま返し、isStaleフラグで
 * 「古いかどうか」だけを伝える。呼び出し側(routes/reviews.js)で
 * 「古くても一旦表示 → 裏で更新」のstale-while-revalidate方式に使う。
 */

/**
 * 店舗の未返信口コミキャッシュを、鮮度に関わらず取得する。
 * @param {string} storeId
 * @returns {Promise<{reviews: Array<object>, isStale: boolean}|null>} キャッシュが1件も無ければnull
 */
async function getCachedUnrepliedReviewsAnyAge(storeId) {
  const doc = await getSpreadsheetDoc();
  const sheet = await getOrCreateSheet(doc, 'review_cache', REVIEW_CACHE_HEADERS);
  const rows = await sheet.getRows();

  const storeRows = rows.filter((row) => row.get('store_id') === storeId);
  if (storeRows.length === 0) return null;

  const latestUpdatedAt = storeRows
    .map((row) => new Date(row.get('updated_at')).getTime())
    .reduce((max, t) => Math.max(max, t), 0);

  const isStale = Date.now() - latestUpdatedAt > REVIEW_CACHE_TTL_MS;

  return {
    reviews: storeRows.map(rowToReviewObject),
    isStale,
  };
}

// module.exports に追加すること: getCachedUnrepliedReviewsAnyAge,
// module.exports に追加すること: getStaffProfileByLineUserId,
module.exports = {
  getFooterText,
  logPublishResult,
  getCachedStylists,
  updateStylistCache,
  getManagedStoreIds,
  getFooterTextForEdit,
  updateFooterText,
  getCachedUnrepliedReviews,
    getCachedUnrepliedReviewsAnyAge,
  getCachedUnrepliedReviewsForStaff,
  updateReviewCache,
  updateReviewDraft,
  removeReviewFromCache,
  logReviewReply,
  getStaffProfileByLineUserId,
};
