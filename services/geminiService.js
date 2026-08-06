/**
 * ============================================
 * Gemini API 呼び出し
 * 分析用・ブログ用の2リクエストを並列実行する
 * (元 GeminiService.gs の移植。ロジックは変更なし、
 *  UrlFetchApp.fetchAll → Promise.all に置き換え)
 * ============================================
 */

const fetch = require('node-fetch');
const { buildAnalysisPrompt, buildBlogPrompt, getSeasonContext } = require('./promptBuilder');

const GEMINI_MODEL = 'gemini-2.5-flash';

/**
 * 画像1枚から「スタイル分析」「ブログ文案」を同時生成する
 * @param {string} base64Image 画像のbase64文字列（data:image/... のヘッダー無し）
 * @param {string} mimeType 例: "image/jpeg"
 * @param {string} storeName
 * @param {string} ageGroupLabel
 * @returns {Promise<{analysisText: string, blogText: string}>}
 */
async function generateAnalysisAndBlog(base64Image, mimeType, storeName, ageGroupLabel) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('環境変数 GEMINI_API_KEY が設定されていません');

  const endpoint =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    GEMINI_MODEL +
    ':generateContent?key=' +
    apiKey;

  const seasonContext = getSeasonContext();
  const analysisPrompt = buildAnalysisPrompt();
  const blogPrompt = buildBlogPrompt(storeName, ageGroupLabel, seasonContext);

  const buildPayload = (promptText) => ({
    contents: [
      {
        parts: [
          { text: promptText },
          { inline_data: { mime_type: mimeType, data: base64Image } },
        ],
      },
    ],
  });

  // 2リクエストを並列実行(元のUrlFetchApp.fetchAllと同じ意図)
  const [analysisRes, blogRes] = await Promise.all([
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(analysisPrompt)),
    }),
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(blogPrompt)),
    }),
  ]);

  const analysisText = await extractGeminiText(analysisRes);
  const blogText = await extractGeminiText(blogRes);

  return { analysisText, blogText };
}

/**
 * Gemini APIレスポンスからテキスト部分を取り出す
 * @private
 */
async function extractGeminiText(response) {
  const code = response.status;
  const body = await response.text();

  if (code !== 200) {
    console.error('Gemini API error: ' + code + ' ' + body);
    throw new Error('Gemini APIの呼び出しに失敗しました (code: ' + code + ')');
  }

  const json = JSON.parse(body);
  const candidate = json.candidates && json.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;

  if (!parts || !parts[0] || !parts[0].text) {
    throw new Error('Gemini APIの応答形式が想定と異なります');
  }

  return parts[0].text.trim();
}

module.exports = { generateAnalysisAndBlog };
