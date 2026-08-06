/**
 * ============================================
 * 店舗ごとの設定を一元管理する
 *
 * 元々 GAS 側で STORE_CONFIG という名前で
 * 定義されていたものと同じ役割。
 * WordPress・GBP・SalonBoard・HotPepperブログの設定を
 * すべてこの1ファイルにまとめることで、店舗追加時の
 * 変更箇所を減らす。
 *
 * 【gbpLocationId について】
 * "accounts/{アカウントID}/locations/{ロケーションID}" という形式が必要だが、
 * アカウントIDは実行時にAPI(mybusinessaccountmanagement)から動的取得する設計にしている。
 * そのため、ここではロケーションID(数字部分)のみを保持する。
 * 実際にGBP投稿する際は、services/publishService.js 側で
 * `accounts/${accountId}/locations/${store.gbpLocationId}` の形に組み立てて使う。
 *
 * 【SalonBoardのパスワードについて】
 * 定期的なパスワード変更ポリシーに対応するため、各店舗
 * 「現在のパスワード」「予備のパスワード」の2つを保持できる設計にしている。
 * salonboardService.js側でログインを試みる際、配列の先頭から順に試し、
 * 最初に成功したものを使う。お店側が2つのパスワードを交互に切り替えて
 * 運用していても、自動化側はどちらでもログインできる。
 *
 * 【店舗を追加する手順】
 * 1. この配列に1店舗分のオブジェクトを追加
 * 2. SalonBoardのID・パスワードは環境変数として
 *    Renderに登録し、ここでは process.env から参照する
 * ============================================
 */

const STORE_CONFIG = {
  style: {
    id: 'style',
    name: 'HAIR POCKET style',
    wpCategoryId: 8,
    gbpLocationId: '10168452701057741249',
    hotpepperSalonId: 'slnH000039194',
    salonboard: {
      loginId: process.env.SALONBOARD_STYLE_ID || '',
      passwords: [
        process.env.SALONBOARD_STYLE_PASSWORD_1,
        process.env.SALONBOARD_STYLE_PASSWORD_2,
      ].filter(Boolean), // 現在パスワード・予備パスワードの順で試す
      defaultStylistId: '',
      defaultCategoryCd: 'BL03', // サロンのNEWS
    },
  },

  ritta: {
    id: 'ritta',
    name: 'HAIR POCKET ritta',
    wpCategoryId: 8,
    gbpLocationId: '10169900304756044799',
    hotpepperSalonId: 'slnH000226786',
    salonboard: {
      loginId: process.env.SALONBOARD_RITTA_ID || '',
      passwords: [
        process.env.SALONBOARD_RITTA_PASSWORD_1,
        process.env.SALONBOARD_RITTA_PASSWORD_2,
      ].filter(Boolean), // 現在パスワード・予備パスワードの順で試す
      defaultStylistId: '',
      defaultCategoryCd: 'BL03',
    },
  },

  merry: {
    id: 'merry',
    name: 'HAIR POCKET merry',
    wpCategoryId: 8,
    gbpLocationId: '1969635891933253483',
    hotpepperSalonId: 'slnH000086179',
    salonboard: {
      loginId: process.env.SALONBOARD_MERRY_ID || '',
      passwords: [
        process.env.SALONBOARD_MERRY_PASSWORD_1,
        process.env.SALONBOARD_MERRY_PASSWORD_2,
      ].filter(Boolean), // 現在パスワード・予備パスワードの順で試す
      // 実際にテスト成功した投稿者(鳥越 翔)のIDをデフォルトにしている。
      // 運用開始後、店舗側の希望に応じて変更する。
      defaultStylistId: 'T001068275',
      defaultCategoryCd: 'BL03',
    },
  },

  rudii: {
    id: 'rudii',
    name: 'rudii by HAIR POCKET',
    wpCategoryId: 8,
    gbpLocationId: '7171100354130159181',
    hotpepperSalonId: 'slnH000086195',
    salonboard: {
      loginId: process.env.SALONBOARD_RUDII_ID || '',
      passwords: [
        process.env.SALONBOARD_RUDII_PASSWORD_1,
        process.env.SALONBOARD_RUDII_PASSWORD_2,
      ].filter(Boolean), // 現在パスワード・予備パスワードの順で試す
      defaultStylistId: '',
      defaultCategoryCd: 'BL03',
    },
  },

  aimer: {
    id: 'aimer',
    name: 'aimer by hair pocket',
    wpCategoryId: 8,
    gbpLocationId: '6978082651348501496',
    hotpepperSalonId: 'slnH000056993',
    salonboard: {
      loginId: process.env.SALONBOARD_AIMER_ID || '',
      passwords: [
        process.env.SALONBOARD_AIMER_PASSWORD_1,
        process.env.SALONBOARD_AIMER_PASSWORD_2,
      ].filter(Boolean), // 現在パスワード・予備パスワードの順で試す
      defaultStylistId: '',
      defaultCategoryCd: 'BL03',
    },
  },

  day: {
    id: 'day',
    name: 'Day. by hair pocket',
    wpCategoryId: 8,
    gbpLocationId: '15962610642684059163',
    hotpepperSalonId: 'slnH000514272',
    salonboard: {
      loginId: process.env.SALONBOARD_DAY_ID || '',
      passwords: [
        process.env.SALONBOARD_DAY_PASSWORD_1,
        process.env.SALONBOARD_DAY_PASSWORD_2,
      ].filter(Boolean), // 現在パスワード・予備パスワードの順で試す
      defaultStylistId: '',
      defaultCategoryCd: 'BL03',
    },
  },

  luke: {
    id: 'luke',
    name: 'Luke by hair pocket',
    wpCategoryId: 8,
    gbpLocationId: '9052256013390637506',
    hotpepperSalonId: 'slnH000695311',
    salonboard: {
      loginId: process.env.SALONBOARD_LUKE_ID || '',
      passwords: [
        process.env.SALONBOARD_LUKE_PASSWORD_1,
        process.env.SALONBOARD_LUKE_PASSWORD_2,
      ].filter(Boolean), // 現在パスワード・予備パスワードの順で試す
      defaultStylistId: '',
      defaultCategoryCd: 'BL03',
    },
  },

  fika: {
    id: 'fika',
    name: 'fika',
    wpCategoryId: 8,
    gbpLocationId: '13096396231380063248',
    hotpepperSalonId: 'slnH000724174',
    salonboard: {
      loginId: process.env.SALONBOARD_FIKA_ID || '',
      passwords: [
        process.env.SALONBOARD_FIKA_PASSWORD_1,
        process.env.SALONBOARD_FIKA_PASSWORD_2,
      ].filter(Boolean), // 現在パスワード・予備パスワードの順で試す
      defaultStylistId: '',
      defaultCategoryCd: 'BL03',
    },
  },
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
