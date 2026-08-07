/**
 * ============================================
 * 投稿処理
 * GBP（Googleビジネスプロフィール）と WordPress と SalonBoard へ同時投稿
 * (元 PublishService.gs の移植 + SalonBoard統合)
 * ============================================
 */

const fetch = require('node-fetch');
const { getStoreConfig } = require('../config/stores');
const { getFooterText, logPublishResult } = require('./sheetsService');
const { postBlogToSalonBoard } = require('./salonboardService');

/**
 * GBP・WordPress・SalonBoardへ同時投稿する
 * @param {string} storeId
 * @param {string} finalText スタッフが編集した最終テキスト
 * @param {string} base64Image
 * @param {string} mimeType
 * @param {string} [stylistId] SalonBoard投稿者ID(LIFFで選択された値)
 * @returns {Promise<{gbp: object, wp: object, salonboard: object}>}
 */
async function publishToAllChannels(storeId, finalText, base64Image, mimeType, stylistId) {
  const store = getStoreConfig(storeId);

  const footer = await getFooterText(storeId);
  const fullText = finalText + '\n\n' + footer;

  // WordPressを先に投稿し、アップロードした画像の公開URLを取得する
  // (GBPのlocalPosts APIはbase64画像を直接受け付けないため、公開URLが必要。
  //  同じ画像URLはSalonBoard投稿にも使い回す)
  const wpResult = await safeExecute(() => postToWordPress(store, fullText, base64Image, mimeType));

  const gbpResult = await safeExecute(async () => {
    if (!wpResult.success) {
      throw new Error('WordPress投稿が失敗したため、画像URLが取得できずGBP投稿をスキップしました');
    }
    const imageUrl = wpResult.data.mediaUrl;
    return postToGbp(store, finalText, imageUrl);
  });

  const salonboardResult = await safeExecute(async () => {
    if (!wpResult.success) {
      throw new Error('WordPress投稿が失敗したため、画像URLが取得できずSalonBoard投稿をスキップしました');
    }
    const imageUrl = wpResult.data.mediaUrl;
    // SalonBoardのタイトルは25文字制限があるため、店舗名等は含めず短く切り詰める。
    // 改行が入っているとタイトル欄の入力でエラーになるため、事前に除去する。
    const title = finalText.replace(/\n/g, ' ').trim().slice(0, 25);
    return postBlogToSalonBoard(store, {
      stylistId: stylistId || store.salonboard.defaultStylistId,
      categoryCd: store.salonboard.defaultCategoryCd,
      title,
      body: fullText.slice(0, 1000),
      imageUrl,
    });
  });

  await logPublishResult(storeId, gbpResult, wpResult, salonboardResult);

  return { gbp: gbpResult, wp: wpResult, salonboard: salonboardResult };
}

/**
 * リフレッシュトークンからアクセストークンを取得する
 * @private
 */
async function getGbpAccessToken() {
  const refreshToken = process.env.GBP_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('環境変数 GBP_REFRESH_TOKEN が設定されていません');
  }

  const clientId = process.env.GBP_CLIENT_ID;
  const clientSecret = process.env.GBP_CLIENT_SECRET;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const result = await response.json();
  if (!result.access_token) {
    throw new Error('アクセストークン取得失敗: ' + JSON.stringify(result));
  }
  return result.access_token;
}

/**
 * GBP(Googleビジネスプロフィール)のアカウントIDを取得する
 * @private
 */
async function getGbpAccountId(accessToken) {
  const response = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  const result = await response.json();
  if (result.accounts && result.accounts.length > 0) {
    return result.accounts[0].name.split('/')[1];
  }
  throw new Error('GBPアカウントIDの取得に失敗しました: ' + JSON.stringify(result));
}

/**
 * GBP localPosts へ投稿
 * @param {string} imageUrl WordPressにアップロード済みの画像の公開URL
 * @private
 */
async function postToGbp(store, text, imageUrl) {
  const accessToken = await getGbpAccessToken();
  const accountId = await getGbpAccountId(accessToken);
  const locationName = `accounts/${accountId}/locations/${store.gbpLocationId}`;
  const url = 'https://mybusiness.googleapis.com/v4/' + locationName + '/localPosts';

  const payload = {
    languageCode: 'ja',
    summary: text,
    topicType: 'STANDARD',
    media: [{ mediaFormat: 'PHOTO', sourceUrl: imageUrl }],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
    body: JSON.stringify(payload),
  });

  if (response.status >= 300) {
    throw new Error('GBP投稿失敗: ' + (await response.text()));
  }

  return response.json();
}

/**
 * WordPress REST API へ投稿（画像は先にメディアアップロード）
 * @private
 */
async function postToWordPress(store, text, base64Image, mimeType) {
  const wpUser = process.env.WP_APP_USER;
  const wpPass = process.env.WP_APP_PASSWORD;
  const auth = Buffer.from(wpUser + ':' + wpPass).toString('base64');
  const baseUrl = (process.env.WP_BASE_URL || 'https://hair-pocket.com') + '/wp-json/wp/v2';

  // 1. 画像をメディアとしてアップロード
  const imageBytes = Buffer.from(base64Image, 'base64');
  const extension = mimeType.split('/')[1] || 'jpg';
  const fileName = 'style-' + Date.now() + '.' + extension;

  const mediaResponse = await fetch(baseUrl + '/media', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + auth,
      'Content-Disposition': 'attachment; filename="' + fileName + '"',
      'Content-Type': mimeType,
    },
    body: imageBytes,
  });

  if (mediaResponse.status >= 300) {
    throw new Error('WordPress画像アップロード失敗: ' + (await mediaResponse.text()));
  }
  const mediaJson = await mediaResponse.json();
  const mediaId = mediaJson.id;
  const mediaUrl = mediaJson.source_url;

  // 2. 投稿本体を作成
  const postResponse = await fetch(baseUrl + '/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
    body: JSON.stringify({
      title: store.name + ' | 本日のスタイル',
      content: text.replace(/\n/g, '<br>'),
      status: 'publish',
      categories: [store.wpCategoryId],
      featured_media: mediaId,
    }),
  });

  if (postResponse.status >= 300) {
    throw new Error('WordPress投稿失敗: ' + (await postResponse.text()));
  }

  const postJson = await postResponse.json();
  // GBP投稿・SalonBoard投稿で画像URLを使い回せるよう、mediaUrlを結果に含めて返す
  postJson.mediaUrl = mediaUrl;
  return postJson;
}

/**
 * エラーが起きても他方の処理を止めないためのラッパー
 * @private
 */
async function safeExecute(fn) {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (err) {
    console.error('投稿処理エラー: ' + err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { publishToAllChannels };
