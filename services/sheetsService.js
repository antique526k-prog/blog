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
  let sheet = doc.sheetsByTitle[sheetName];
  if (!sheet) {
    sheet = await doc.addSheet({ title: sheetName, headerValues });
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

module.exports = {
  getFooterText,
  logPublishResult,
  getCachedStylists,
  updateStylistCache,
};
