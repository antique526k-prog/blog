/**
 * ============================================
 * サーバーのエントリーポイント
 *
 * 元々GAS + LIFFで動いていた「スタイル分析・ブログ生成・
 * GBP/WordPress/SalonBoard同時投稿システム」を
 * Node.js(Express)に統合したもの。
 *
 * 【役割分担】
 * - /public/index.html … LIFFのフロントエンド(旧Index.html)
 * - /api/generate       … 画像からスタイル分析・ブログ文案を生成(旧GeminiService.gs)
 * - /api/publish        … GBP・WordPress・SalonBoardへ同時投稿(旧PublishService.gs)
 * ============================================
 */

// 日本語フォント認識のため、HOME環境変数をプロジェクト内に向ける
// (SalonBoard自動化でPuppeteerがスクリーンショットを撮る際に必要)
process.env.HOME = __dirname;

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ミドルウェア =====
app.use(cors());
app.use(express.json({ limit: '20mb' })); // 画像のbase64を受け取るため上限を広めに
app.use(express.static(path.join(__dirname, 'public')));

// スクリーンショットの一時公開(SalonBoard自動化のデバッグ用。既存の仕組みを踏襲)
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

// ===== ルーティング =====
// 各ルーターファイルは routes/ 配下で個別に実装していく(次のステップ)
// const generateRouter = require('./routes/generate');
// const publishRouter = require('./routes/publish');
// app.use('/api/generate', generateRouter);
// app.use('/api/publish', publishRouter);

// ヘルスチェック用(Renderが生存確認に使う。念のため用意)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`サーバー起動: ポート ${PORT}`);
  console.log('準備が完了しました。');
});
