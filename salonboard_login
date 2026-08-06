/**
 * SalonBoard(スマホ版) 自動ログイン → ブログ投稿 スクリプト
 * 
 * 【現在の進捗】
 * ステップ1: ログインのみ実装済み(この段階では投稿処理はまだ)
 * ステップ2以降: ログイン後の画面遷移・ブログ投稿フォームの構造を
 *                確認してから追加していく
 * 
 * 【実行環境】
 * Render(Cron Job または Web Service)を想定
 * 
 * 【確認方法】
 * ログイン後のスクリーンショットを、Renderサーバー上に一時保存し、
 * そのURLをLINE Messaging APIで自分のLINEに送信して目視確認する
 * (Google Drive等の追加認証を使わず、既存のLINE bot連携を流用)
 * 
 * 【事前準備】
 * Renderの環境変数に以下を設定しておくこと:
 *   SALON_ID          … SalonBoardのログインID
 *   SALON_PASSWORD    … SalonBoardのログインパスワード
 *   LINE_CHANNEL_TOKEN … LINE Messaging APIのチャネルアクセストークン
 *   LINE_USER_ID       … 送信先(自分)のLINEユーザーID
 * 
 * 【重要な注意】
 * salonboard.com は robots.txt で自動アクセスを明示的に禁止しています。
 * これは自社アカウント・自社利用に限定した個人的な運用であることを
 * 前提に進めています。商用サービス化や他社への提供は行わないでください。
 */

const puppeteer = require('puppeteer');
const express = require('express');
const path = require('path');
const fetch = require('node-fetch'); // Node 18以降ならglobal fetchでも可

const app = express();
const PORT = process.env.PORT || 3000;

// スクリーンショットを一時的にサーバー上で公開するための静的配信設定
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
app.use('/screenshots', express.static(SCREENSHOT_DIR));

// ===== 設定(すべて環境変数から読み込む。コードに直書きしない) =====
const SALON_ID = process.env.SALON_ID;
const SALON_PASSWORD = process.env.SALON_PASSWORD;
const LINE_CHANNEL_TOKEN = process.env.LINE_CHANNEL_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;
// RenderのWeb ServiceのURL(例: https://your-app.onrender.com)
// スクリーンショットの公開URLを組み立てるのに使う
const RENDER_BASE_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT;

const LOGIN_URL = 'https://salonboard.com/login_sp/';

// ===== LINEへ画像を送る処理 =====
async function sendImageToLine(imageUrl) {
  if (!LINE_CHANNEL_TOKEN || !LINE_USER_ID) {
    console.log('LINE設定が無いため、画像送信をスキップしました。');
    return;
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_TOKEN}`
    },
    body: JSON.stringify({
      to: LINE_USER_ID,
      messages: [
        {
          type: 'image',
          originalContentUrl: imageUrl,
          previewImageUrl: imageUrl
        }
      ]
    })
  });
  if (!res.ok) {
    console.error('LINE送信失敗: ' + (await res.text()));
  } else {
    console.log('LINEへスクリーンショットを送信しました。');
  }
}

// ===== メイン処理 =====
async function loginToSalonBoard() {
  const fs = require('fs');
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    );
    await page.setViewport({ width: 390, height: 844, isMobile: true });

    console.log('ログインページにアクセス中...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });

    await page.waitForSelector('input[name="userId"]');
    await page.type('input[name="userId"]', SALON_ID, { delay: 50 });

    await page.waitForSelector('input[name="password"]');
    await page.type('input[name="password"]', SALON_PASSWORD, { delay: 50 });

    console.log('ログインボタンをクリック...');
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const loginLink = links.find(a => a.textContent.trim() === 'ログイン');
      if (loginLink) {
        loginLink.click();
      } else {
        throw new Error('ログインボタンが見つかりませんでした');
      }
    });

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {
      console.log('画面遷移の検知がタイムアウトしました。手動確認が必要かもしれません。');
    });

    // スクリーンショットをファイル名にタイムスタンプを付けて保存
    const fileName = `after_login_${Date.now()}.png`;
    const filePath = path.join(SCREENSHOT_DIR, fileName);
    await page.screenshot({ path: filePath, fullPage: true });
    console.log('スクリーンショットを保存: ' + filePath);

    console.log('現在のURL: ' + page.url());

    // 公開URLを組み立ててLINEに送信
    const imageUrl = `${RENDER_BASE_URL}/screenshots/${fileName}`;
    console.log('画像の公開URL: ' + imageUrl);
    await sendImageToLine(imageUrl);

  } catch (error) {
    console.error('エラーが発生しました: ' + error.message);
  } finally {
    await browser.close();
  }
}

// RenderのWeb Serviceとして常時起動しておき、
// 特定のURLにアクセスが来たら処理を実行する形にしておくと、
// ブラウザから手動でテストしやすい
app.get('/run-login-test', async (req, res) => {
  res.send('ログインテストを開始しました。数十秒後にLINEを確認してください。');
  await loginToSalonBoard(); // レスポンスを先に返してから裏で実行
});

app.listen(PORT, () => {
  console.log(`サーバー起動: ポート ${PORT}`);
  console.log(`テスト実行するには /run-login-test にアクセスしてください`);
});
