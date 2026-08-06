/**
 * ============================================
 * 店舗ごとの設定を一元管理する
 *
 * 元々 GAS 側で STORE_CONFIG という名前で
 * 定義されていたものと同じ役割。
 * WordPress・GBP・SalonBoardの設定をすべて
 * この1ファイルにまとめることで、店舗追加時の
 * 変更箇所を減らす。
 *
 * 【店舗を追加する手順】
 * 1. この配列に1店舗分のオブジェクトを追加
 * 2. SalonBoardのID・パスワードは環境変数として
 *    Renderに登録し、ここでは process.env から参照する
 * ============================================
 */

const STORE_CONFIG = {
  merry: {
    id: 'merry',
    name: 'HAIR POCKET merry',
    // WordPress
    wpCategoryId: 8, // 「ブログ」カテゴリ(NEWSカテゴリと間違えないよう明示)
    // GBP (Googleビジネスプロフィール)
    gbpLocationId: '', // 例: accounts/xxxx/locations/xxxx (後で埋める)
    // SalonBoard
    salonboard: {
      loginId: process.env.SALONBOARD_MERRY_ID || '',
      password: process.env.SALONBOARD_MERRY_PASSWORD || '',
      // 投稿者選択のデフォルト値。SalonBoard側の「投稿者」プルダウンの value と一致させる。
      // 実際の一覧は salonboardService.getStylistOptions() で動的取得も可能。
      defaultStylistId: '',
      defaultCategoryCd: 'BL03', // サロンのNEWS
    },
  },

  // 他店舗はここに追加していく(例)
  // style: {
  //   id: 'style',
  //   name: 'HAIR POCKET style',
  //   wpCategoryId: 8,
  //   gbpLocationId: '',
  //   salonboard: {
  //     loginId: process.env.SALONBOARD_STYLE_ID || '',
  //     password: process.env.SALONBOARD_STYLE_PASSWORD || '',
  //     defaultStylistId: '',
  //     defaultCategoryCd: 'BL03',
  //   },
  // },
};

/**
 * 店舗IDから設定を取得する。存在しない場合はエラーを投げる。
 * @param {string} storeId
 * @returns {object}
 */
function getStoreConfig(storeId) {
  const store = STORE_CONFIG[storeId];
  if (!store) {
    throw new Error('未登録の店舗IDです: ' + storeId);
  }
  return store;
}

/**
 * UI(プルダウン)表示用に、店舗の一覧を [{id, name}, ...] 形式で返す
 * @returns {Array<{id: string, name: string}>}
 */
function listStores() {
  return Object.values(STORE_CONFIG).map((s) => ({ id: s.id, name: s.name }));
}

module.exports = { STORE_CONFIG, getStoreConfig, listStores };
