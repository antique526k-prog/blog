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

const path = require('path');

// 日本語フォント(.fonts)を認識させるため、HOME環境変数をプロジェクト内に向ける。
// install-fonts.js で /project/.fonts に配置したフォントを、
// Chromeが起動時に見つけられるようにするための設定。
process.env.HOME = __dirname;

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const puppeteer = puppeteerExtra;
const express = require('express');
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

// ===== テスト投稿用の内容(あくまでテスト。実際の運用では動的に生成する) =====
const TEST_BLOG_TITLE = 'テスト投稿';
const TEST_BLOG_BODY = 'これは自動投稿システムのテストです。\n実際には送信せず、確認画面の一歩手前で止めています。';
// テスト用画像。実運用時はHotPepperブログの画像URLに差し替える想定。
const TEST_IMAGE_URL = 'https://picsum.photos/600/600';

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
// ===== ページが安定するまで待つ共通関数 =====
// SalonBoardは遷移時に複数回リダイレクトやフレーム切り替えを挟むことがあるため、
// 「evaluateが失敗しなくなるまで」を安定の基準としてリトライする。
// これにより「Detached Frame」エラーを回避する。
async function waitForPageStable(page, maxRetries = 15, intervalMs = 1000) {
  let stableCount = 0;
  let lastUrl = '';

  for (let i = 0; i < maxRetries; i++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    try {
      const currentUrl = page.url();
      const readyState = await page.evaluate(() => document.readyState);
      const hasBody = await page.evaluate(() => !!document.body);
      console.log(`[安定待ち${i + 1}回目] URL: ${currentUrl} / 状態: ${readyState} / body存在: ${hasBody}`);

      if (currentUrl === lastUrl && readyState === 'complete' && hasBody) {
        stableCount++;
        if (stableCount >= 2) {
          console.log('ページが安定したと判断しました。');
          return true;
        }
      } else {
        stableCount = 0;
      }
      lastUrl = currentUrl;
    } catch (e) {
      // Detached Frame等のエラーはここでキャッチして、リトライを続ける
      console.log(`[安定待ち${i + 1}回目] チェック中にエラー(遷移中のため無視): ${e.message}`);
      stableCount = 0;
    }
  }
  console.log('ページの安定を確認できないままタイムアウトしました。処理を続行します。');
  return false;
}

// ===== SalonBoard(スマホ版)特有のタッチイベント専用ボタンをクリックする共通関数 =====
// SalonBoardのスマホ版ボタンは通常のクリックイベント(mousedown/mouseup/click)には反応せず、
// touchstart/touchmove/touchend のタッチイベントにのみ反応するものが多い。
// data-touch-target属性が付与された要素に対して、この関数でタッチをシミュレートする。
// ===== 画像URLをローカルファイルとしてダウンロードする共通関数 =====
// 画像アップロード(Puppeteerのuploadfile)にはローカルファイルパスが必要なため、
// HotPepper等の画像URLをまず一時ファイルとして保存してから使う。
function downloadFile(url, destPath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('リダイレクトが多すぎます'));
      return;
    }
    const https = require('https');
    const fs = require('fs');
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlink(destPath, () => {});
        downloadFile(response.headers.location, destPath, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`画像ダウンロード失敗: HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function tapElement(page, selector, label = '') {
  const rect = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);

  if (!rect) {
    console.log(`[${label}] タップ対象の座標が取得できませんでした。`);
    return false;
  }

  console.log(`[${label}] タッチイベントをシミュレートします: (${rect.x}, ${rect.y})`);
  try {
    await page.touchscreen.tap(rect.x, rect.y);
    console.log(`[${label}] page.touchscreen.tap() を実行しました。`);
    return true;
  } catch (touchError) {
    console.log(`[${label}] page.touchscreen.tap() に失敗: ` + touchError.message);
    try {
      const client = await page.target().createCDPSession();
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: rect.x, y: rect.y }]
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: []
      });
      console.log(`[${label}] CDP経由でのタッチイベント発火に成功しました。`);
      return true;
    } catch (cdpError) {
      console.log(`[${label}] CDP経由でのタッチイベント発火にも失敗: ` + cdpError.message);
      return false;
    }
  }
}

async function loginToSalonBoard() {
  const fs = require('fs');
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',      // /dev/shm の容量不足によるクラッシュを防ぐ(Render等のコンテナ環境で重要)
      '--disable-gpu',                 // GPU関連の機能を無効化してメモリ節約
      '--disable-background-networking',
      '--no-first-run',
      '--mute-audio'
    ]
  });

  // 定期的にメモリ使用量をログに出す(クラッシュする直前の状況を把握するため)
  const memoryLogInterval = setInterval(() => {
    const used = process.memoryUsage();
    console.log(`[メモリ監視] RSS: ${Math.round(used.rss / 1024 / 1024)}MB / Heap: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
  }, 2000);

  try {
    const page = await browser.newPage();

    // 実在のスマホブラウザに近づけるための各種設定
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
    );
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

    // 実ブラウザが送る一般的なHTTPヘッダーを追加
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ja-JP,ja;q=0.9',
    });

    // タイムゾーンと言語設定も日本に合わせる
    await page.emulateTimezone('Asia/Tokyo');

    console.log('ログインページにアクセス中...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });

    // 人間らしい待機時間を挟む(即座に入力を開始すると機械的な挙動として検知されやすい)
    await new Promise(resolve => setTimeout(resolve, 1500));

    await page.waitForSelector('input[name="userId"]');
    await page.click('input[name="userId"]'); // まずクリックしてフォーカスを当てる(人間の操作に近づける)
    await page.type('input[name="userId"]', SALON_ID, { delay: 80 + Math.random() * 60 });

    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));

    await page.waitForSelector('input[name="password"]');
    await page.click('input[name="password"]');
    await page.type('input[name="password"]', SALON_PASSWORD, { delay: 80 + Math.random() * 60 });

    // 入力完了後、クリックまで少し間を置く(人間らしい挙動)
    await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 700));

    console.log('ログインボタンをクリック...');
    console.log('クリック前のURL: ' + page.url());

    // クリック前に、ボタンが本当に存在し、クリック可能かを確認する
    const buttonFound = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const loginLink = links.find(a => a.textContent.trim() === 'ログイン');
      return {
        found: !!loginLink,
        onclick: loginLink ? loginLink.getAttribute('onclick') : null,
        visible: loginLink ? (loginLink.offsetWidth > 0 && loginLink.offsetHeight > 0) : false
      };
    });
    console.log('ログインボタンの検出結果: ' + JSON.stringify(buttonFound));

    if (!buttonFound.found) {
      throw new Error('ログインボタンがページ内に見つかりませんでした');
    }

    // Puppeteer標準のクリック方式を使う(座標クリックなので実際のユーザー操作に近い)
    // $x()は新しいPuppeteerバージョンで廃止されているため、
    // evaluateでXPath相当の処理をしてから、要素のCSSセレクタ的な位置を特定する方式にする。
    // ここでは、ボタンにevaluate内で一時的な目印(data属性)を付けてから
    // page.click()で本物のマウスクリックイベントを発生させる。
    const marked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const loginLink = links.find(a => a.textContent.trim() === 'ログイン');
      if (loginLink) {
        loginLink.setAttribute('data-auto-login-target', 'true');
        return true;
      }
      return false;
    });

    if (marked) {
      await page.click('a[data-auto-login-target="true"]');
      console.log('Puppeteer標準クリックでボタンを押しました。');
    } else {
      console.log('目印付けに失敗。JS click()にフォールバックします。');
      await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const loginLink = links.find(a => a.textContent.trim() === 'ログイン');
        if (loginLink) loginLink.click();
      });
    }

    // クリック直後、少し待ってからURLを確認(即座に変化するとは限らないため)
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('クリック2秒後のURL: ' + page.url());

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {
      console.log('画面遷移の検知がタイムアウトしました。安定するまで確認を繰り返します。');
    });

    // ページが本当に安定するまで、最大10回(約10秒)チェックを繰り返す
    // SalonBoardはログイン後に複数回リダイレクトを挟む可能性があるため、
    // 固定時間待つだけでは不十分な場合がある
    let stableCheckCount = 0;
    let lastUrl = '';
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const currentUrl = page.url();
        const readyState = await page.evaluate(() => document.readyState).catch(() => 'unknown');
        console.log(`[待機${i + 1}回目] URL: ${currentUrl} / 状態: ${readyState}`);

        // URLが変わらず、かつreadyStateがcompleteなら安定したとみなす
        if (currentUrl === lastUrl && readyState === 'complete') {
          stableCheckCount++;
          if (stableCheckCount >= 2) {
            console.log('ページが安定したと判断しました。');
            break;
          }
        } else {
          stableCheckCount = 0;
        }
        lastUrl = currentUrl;
      } catch (e) {
        console.log(`[待機${i + 1}回目] チェック中にエラー(遷移中の可能性): ${e.message}`);
      }
    }

    // bodyの存在を確認してから安全にテキストを取得する
    const bodyText = await page.evaluate(() => {
      return document.body ? document.body.innerText.slice(0, 300) : '(bodyが存在しません)';
    }).catch(() => '(本文の取得に失敗しました)');
    console.log('ページ本文の冒頭300文字: ' + bodyText);

    // スクリーンショットをファイル名にタイムスタンプを付けて保存(ログイン後の画面)
    const fileName = `after_login_${Date.now()}.png`;
    const filePath = path.join(SCREENSHOT_DIR, fileName);
    await page.screenshot({ path: filePath, fullPage: true });
    console.log('スクリーンショットを保存: ' + filePath);

    console.log('現在のURL: ' + page.url());

    // 公開URLを組み立ててLINEに送信
    const imageUrl = `${RENDER_BASE_URL}/screenshots/${fileName}`;
    console.log('画像の公開URL: ' + imageUrl);
    await sendImageToLine(imageUrl);

    // ===== ここからブログボタンへの遷移を試みる =====
    console.log('ブログボタンを探しています...');

    // 「ブログ」というテキストを含むリンク/ボタンを探す
    const blogButtonInfo = await page.evaluate(() => {
      // aタグ、buttonタグ、その他クリック可能そうな要素すべてから探す
      const candidates = Array.from(document.querySelectorAll('a, button, div[onclick], span[onclick]'));
      const blogEl = candidates.find(el => el.textContent.trim() === 'ブログ');
      if (blogEl) {
        return {
          found: true,
          tag: blogEl.tagName,
          href: blogEl.getAttribute('href'),
          onclick: blogEl.getAttribute('onclick'),
          id: blogEl.id,
          className: blogEl.className
        };
      }
      return { found: false };
    });
    console.log('ブログボタンの検出結果: ' + JSON.stringify(blogButtonInfo));

    if (blogButtonInfo.found) {
      // 目印を付けてクリック(ログインボタンと同じ確実な方式)
      await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('a, button, div[onclick], span[onclick]'));
        const blogEl = candidates.find(el => el.textContent.trim() === 'ブログ');
        if (blogEl) blogEl.setAttribute('data-auto-blog-target', 'true');
      });

      await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));

      await page.click('[data-auto-blog-target="true"]');
      console.log('ブログボタンをクリックしました。');

      // 遷移を待つ
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {
        console.log('ブログページへの遷移検知(waitForNavigation)がタイムアウトしました。安定待ちに切り替えます。');
      });

      await waitForPageStable(page);

      console.log('ブログページのURL: ' + page.url());

      const blogBodyText = await page.evaluate(() => {
        return document.body ? document.body.innerText.slice(0, 500) : '(bodyが存在しません)';
      }).catch(() => '(本文の取得に失敗しました)');
      console.log('ブログページ本文の冒頭500文字: ' + blogBodyText);

      // ブログページのスクリーンショットも保存してLINEに送信
      const blogFileName = `blog_page_${Date.now()}.png`;
      const blogFilePath = path.join(SCREENSHOT_DIR, blogFileName);
      await page.screenshot({ path: blogFilePath, fullPage: true });
      console.log('ブログページのスクリーンショットを保存: ' + blogFilePath);

      const blogImageUrl = `${RENDER_BASE_URL}/screenshots/${blogFileName}`;
      await sendImageToLine(blogImageUrl);
      console.log('ブログページの画像をLINEに送信しました。');

      // ===== ここから「新規投稿」ボタンへの遷移を試みる =====
      console.log('新規投稿ボタンを探しています...');

      const newPostButtonInfo = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('a, button, div[onclick], span[onclick]'));
        const btn = candidates.find(el => el.textContent.trim() === '新規投稿');
        if (btn) {
          return {
            found: true,
            tag: btn.tagName,
            href: btn.getAttribute('href'),
            onclick: btn.getAttribute('onclick')
          };
        }
        return { found: false };
      });
      console.log('新規投稿ボタンの検出結果: ' + JSON.stringify(newPostButtonInfo));

      if (newPostButtonInfo.found) {
        await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('a, button, div[onclick], span[onclick]'));
          const btn = candidates.find(el => el.textContent.trim() === '新規投稿');
          if (btn) btn.setAttribute('data-auto-newpost-target', 'true');
        });

        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));

        await page.click('[data-auto-newpost-target="true"]');
        console.log('新規投稿ボタンをクリックしました。');

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {
          console.log('新規投稿ページへの遷移検知(waitForNavigation)がタイムアウトしました。安定待ちに切り替えます。');
        });

        await waitForPageStable(page);

        console.log('新規投稿ページのURL: ' + page.url());

        // 投稿フォームのinput/textarea/select要素を洗い出す
        // (これで、タイトル欄・本文欄・画像アップロード欄のname属性を特定する)
        const formFields = await page.evaluate(() => {
          const fields = Array.from(document.querySelectorAll('input, textarea, select'));
          return fields.map(f => ({
            tag: f.tagName,
            type: f.type || null,
            name: f.name || null,
            id: f.id || null,
            placeholder: f.placeholder || null
          }));
        }).catch((e) => {
          console.log('フォームフィールド取得に失敗: ' + e.message);
          return [];
        });
        console.log('投稿フォームのフィールド一覧: ' + JSON.stringify(formFields, null, 2));

        const newPostFileName = `new_post_form_${Date.now()}.png`;
        const newPostFilePath = path.join(SCREENSHOT_DIR, newPostFileName);
        await page.screenshot({ path: newPostFilePath, fullPage: true });

        const newPostImageUrl = `${RENDER_BASE_URL}/screenshots/${newPostFileName}`;
        await sendImageToLine(newPostImageUrl);
        console.log('新規投稿フォームの画像をLINEに送信しました。');

        // ===== 投稿者・カテゴリのプルダウンの選択肢を取得 =====
        const dropdownOptions = await page.evaluate(() => {
          function getOptions(selector) {
            const select = document.querySelector(selector);
            if (!select) return null;
            return Array.from(select.options).map(opt => ({
              value: opt.value,
              text: opt.textContent.trim()
            }));
          }
          return {
            stylist: getOptions('select[name="stylistId"]'),
            category: getOptions('select[name="blogCategoryCd"]')
          };
        }).catch((e) => {
          console.log('プルダウン取得に失敗: ' + e.message);
          return { stylist: null, category: null };
        });
        console.log('投稿者の選択肢: ' + JSON.stringify(dropdownOptions.stylist, null, 2));
        console.log('カテゴリの選択肢: ' + JSON.stringify(dropdownOptions.category, null, 2));

        // ===== タイトル・本文を自動入力する(テスト用の内容) =====
        console.log('タイトル・本文を入力します...');

        // 診断: #blogTitle 要素の実際の状態を詳しく調べる
        const titleElState = await page.evaluate(() => {
          const el = document.querySelector('#blogTitle');
          if (!el) return { exists: false };
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return {
            exists: true,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            disabled: el.disabled,
            readOnly: el.readOnly,
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            pointerEvents: style.pointerEvents,
            // その座標に実際に何の要素があるか(重なりの確認)
            elementAtPoint: (() => {
              const topEl = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return topEl ? { tag: topEl.tagName, id: topEl.id, className: topEl.className } : null;
            })()
          };
        }).catch(e => ({ error: e.message }));
        console.log('#blogTitle の状態: ' + JSON.stringify(titleElState));

        // クリック前に要素を画面内にスクロールしてから操作する
        await page.evaluate(() => {
          const el = document.querySelector('#blogTitle');
          if (el) el.scrollIntoView({ block: 'center' });
        });
        await new Promise(resolve => setTimeout(resolve, 800));

        // まずPuppeteer標準クリックを試し、失敗したらJS直接入力にフォールバック
        let titleClickSucceeded = true;
        try {
          await page.click('#blogTitle');
          console.log('#blogTitle: 標準クリックに成功しました。');
        } catch (clickError) {
          titleClickSucceeded = false;
          console.log('#blogTitle: 標準クリックに失敗(' + clickError.message + ')。JS直接入力方式にフォールバックします。');
        }

        if (titleClickSucceeded) {
          await page.type('#blogTitle', TEST_BLOG_TITLE, { delay: 60 + Math.random() * 40 });
        } else {
          await page.evaluate((text) => {
            const el = document.querySelector('#blogTitle');
            if (el) {
              el.focus();
              el.value = text;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            }
          }, TEST_BLOG_TITLE);
          console.log('#blogTitle: JS直接入力で値をセットしました。');
        }

        await new Promise(resolve => setTimeout(resolve, 400 + Math.random() * 400));

        // 診断: ページ内の全textarea要素の状態を洗い出す(本当に入力すべき欄を特定するため)
        const allTextareas = await page.evaluate(() => {
          const areas = Array.from(document.querySelectorAll('textarea'));
          return areas.map(a => {
            const rect = a.getBoundingClientRect();
            const style = window.getComputedStyle(a);
            return {
              id: a.id,
              name: a.name,
              className: a.className,
              visible: rect.width > 0 && rect.height > 0 && style.display !== 'none',
              rect: { width: rect.width, height: rect.height },
              value: a.value ? a.value.slice(0, 30) : ''
            };
          });
        }).catch(e => [{ error: e.message }]);
        console.log('全textarea要素の一覧: ' + JSON.stringify(allTextareas, null, 2));

        // 診断: contenteditable(リッチテキストエディタ)な要素も探す
        const editableElements = await page.evaluate(() => {
          const editables = Array.from(document.querySelectorAll('[contenteditable="true"], iframe'));
          return editables.map(el => {
            const rect = el.getBoundingClientRect();
            return {
              tag: el.tagName,
              id: el.id,
              className: el.className,
              rect: { width: rect.width, height: rect.height }
            };
          });
        }).catch(e => [{ error: e.message }]);
        console.log('contenteditable/iframe要素の一覧: ' + JSON.stringify(editableElements, null, 2));

        // 診断: #blogContents 要素の実際の状態を詳しく調べる
        const contentsElState = await page.evaluate(() => {
          const el = document.querySelector('#blogContents');
          if (!el) return { exists: false };
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return {
            exists: true,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            disabled: el.disabled,
            readOnly: el.readOnly,
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            pointerEvents: style.pointerEvents,
            elementAtPoint: (() => {
              const topEl = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return topEl ? { tag: topEl.tagName, id: topEl.id, className: topEl.className } : null;
            })()
          };
        }).catch(e => ({ error: e.message }));
        console.log('#blogContents の状態: ' + JSON.stringify(contentsElState));

        // #blogContents はリッチテキストエディタ(nicEdit)の裏側の隠しtextareaであり、
        // 実際にユーザーが操作するのは class="nicEdit-main" を持つ contenteditable な div。
        // ここに直接クリック・入力することで、nicEditが自動的に裏側のtextareaへ同期してくれる。
        await page.evaluate(() => {
          const el = document.querySelector('.nicEdit-main');
          if (el) el.scrollIntoView({ block: 'center' });
        });
        await new Promise(resolve => setTimeout(resolve, 800));

        let nicEditClickSucceeded = true;
        try {
          await page.click('.nicEdit-main');
          console.log('.nicEdit-main: 標準クリックに成功しました。');
        } catch (clickError) {
          nicEditClickSucceeded = false;
          console.log('.nicEdit-main: 標準クリックに失敗(' + clickError.message + ')。');
        }

        if (nicEditClickSucceeded) {
          // contenteditableなdivはpage.typeで直接タイピングできる
          await page.type('.nicEdit-main', TEST_BLOG_BODY, { delay: 40 + Math.random() * 30 });
          console.log('.nicEdit-main: 標準タイピングで本文を入力しました。');
        } else {
          // クリックできない場合は、JSで直接innerHTMLをセットし、
          // nicEdit側の同期処理が拾えるようイベントを発火させる
          await page.evaluate((text) => {
            const el = document.querySelector('.nicEdit-main');
            if (el) {
              el.focus();
              // 改行はnicEdit内部では<br>として扱われることが多いため変換する
              el.innerHTML = text.replace(/\n/g, '<br>');
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('keyup', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
            }
          }, TEST_BLOG_BODY);
          console.log('.nicEdit-main: JS直接入力で値をセットしました。');
        }

        // 入力後、nicEditが裏側のtextareaに同期する時間を少し置く
        await new Promise(resolve => setTimeout(resolve, 500));

        // 同期できているか確認のため、裏側のtextareaの値もログに出す
        const syncedValue = await page.evaluate(() => {
          const el = document.querySelector('#blogContents');
          return el ? el.value : null;
        }).catch(() => null);
        console.log('#blogContents(裏側)に同期された値: ' + syncedValue);

        console.log('タイトル・本文の入力が完了しました。');

        // 投稿者・カテゴリは、1つ目以外の実在する選択肢があれば適当に選んでおく
        // (プルダウンの構造を確認するためのテストなので、実際の値は後で調整する)
        if (dropdownOptions.stylist && dropdownOptions.stylist.length > 1) {
          const stylistValue = dropdownOptions.stylist[1].value;
          await page.select('select[name="stylistId"]', stylistValue);
          console.log('投稿者を選択しました: ' + dropdownOptions.stylist[1].text);
        }
        if (dropdownOptions.category && dropdownOptions.category.length > 1) {
          const categoryValue = dropdownOptions.category[1].value;
          await page.select('select[name="blogCategoryCd"]', categoryValue);
          console.log('カテゴリを選択しました: ' + dropdownOptions.category[1].text);
        }

        // ===== 調査: クーポン選択ボタンの構造を確認する =====
        const couponButtonInfo = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('a, button, input[type="button"], div[onclick], span[onclick]'));
          const btn = candidates.find(el => (el.textContent || '').trim() === 'クーポン選択');
          if (btn) {
            const rect = btn.getBoundingClientRect();
            let jqueryEvents = null;
            try {
              if (window.jQuery && window.jQuery._data) {
                jqueryEvents = Object.keys(window.jQuery._data(btn, 'events') || {});
              }
            } catch (e) {}
            return {
              found: true,
              tag: btn.tagName,
              onclick: btn.getAttribute('onclick'),
              href: btn.getAttribute('href'),
              className: btn.className,
              jqueryEvents: jqueryEvents,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            };
          }
          return { found: false };
        });
        console.log('クーポン選択ボタンの調査結果: ' + JSON.stringify(couponButtonInfo));

        // ===== 調査: 画像アップロードボタン・input[type=file]の構造を確認する =====
        const imageUploadInfo = await page.evaluate(() => {
          const uploadBtn = Array.from(document.querySelectorAll('a, button, div[onclick], span[onclick]'))
            .find(el => (el.textContent || '').trim() === '画像アップロード');
          const fileInput = document.querySelector('input[type="file"]');
          return {
            uploadButton: uploadBtn ? {
              tag: uploadBtn.tagName,
              onclick: uploadBtn.getAttribute('onclick'),
              className: uploadBtn.className
            } : null,
            fileInput: fileInput ? {
              id: fileInput.id,
              name: fileInput.name,
              accept: fileInput.accept,
              multiple: fileInput.multiple,
              visible: fileInput.getBoundingClientRect().width > 0
            } : null
          };
        });
        console.log('画像アップロード関連の調査結果: ' + JSON.stringify(imageUploadInfo));

        // ===== 画像アップロードのテスト =====
        // input[type="file"]が既に画面上に存在し操作可能なため、
        // Puppeteerの uploadFile() で直接ファイルパスを渡す。
        // (見た目上の「画像アップロード」ボタンをクリックする必要はない)
        if (imageUploadInfo.fileInput && imageUploadInfo.fileInput.visible) {
          try {
            console.log('テスト画像をダウンロード中...');
            const testImagePath = path.join(__dirname, 'test-upload-image.jpg');
            await downloadFile(TEST_IMAGE_URL, testImagePath);
            console.log('テスト画像のダウンロードが完了しました: ' + testImagePath);

            const fileInputHandle = await page.$('#IMG_PATH');
            if (fileInputHandle) {
              await fileInputHandle.uploadFile(testImagePath);
              console.log('画像アップロード欄にファイルをセットしました。');

              // アップロード処理(SalonBoard側での非同期アップロード)が完了するまで待つ
              await new Promise(resolve => setTimeout(resolve, 3000));

              // アップロード後の画像プレビューが表示されているか確認
              const uploadResult = await page.evaluate(() => {
                const imgs = Array.from(document.querySelectorAll('img'))
                  .filter(img => img.src && img.src.includes('blog'));
                return imgs.map(img => ({ src: img.src, visible: img.getBoundingClientRect().width > 0 }));
              }).catch(() => []);
              console.log('アップロード後の画像プレビュー調査: ' + JSON.stringify(uploadResult));
            } else {
              console.log('画像アップロード欄(#IMG_PATH)が見つかりませんでした。');
            }
          } catch (uploadError) {
            console.log('画像アップロード処理中にエラー: ' + uploadError.message);
          }
        } else {
          console.log('画像アップロード欄が操作可能な状態ではありませんでした。');
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        // ===== クーポン選択モーダルの調査 =====
        // jscModalOpen クラスから、クリックでモーダルが開くタイプと判明済み。
        // 通常のクリックイベントに反応するため、タッチイベントは不要。
        console.log('クーポン選択ボタンをクリックしてモーダルの中身を調査します...');
        try {
          await page.click('.couponchoiceBtn');
          await new Promise(resolve => setTimeout(resolve, 1000));

          const couponModalContent = await page.evaluate(() => {
            // モーダルは通常、直前まで存在しなかった新しい要素として追加される
            // クラス名に "modal" が含まれる要素を広く探す
            const modals = Array.from(document.querySelectorAll('[class*="modal" i], [class*="Modal"]'));
            return modals
              .filter(el => el.getBoundingClientRect().width > 0)
              .map(el => ({
                tag: el.tagName,
                className: el.className,
                textPreview: (el.innerText || '').slice(0, 300)
              }));
          }).catch(e => [{ error: e.message }]);
          console.log('クーポンモーダルの中身調査: ' + JSON.stringify(couponModalContent, null, 2));

          // モーダルのスクリーンショットを撮ってLINEに送信(目視確認用)
          const couponModalFileName = `coupon_modal_${Date.now()}.png`;
          const couponModalFilePath = path.join(SCREENSHOT_DIR, couponModalFileName);
          await page.screenshot({ path: couponModalFilePath, fullPage: true });
          const couponModalImageUrl = `${RENDER_BASE_URL}/screenshots/${couponModalFileName}`;
          await sendImageToLine(couponModalImageUrl);
          console.log('クーポンモーダルの画像をLINEに送信しました。');

          // 今回はまだクーポンを選択せず、モーダルを閉じておく(調査のみのため)
          // 一般的な閉じ方(×ボタンや背景クリック)を試す
          const closeBtn = await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll('[class*="close" i], [class*="Close"]'));
            const btn = candidates.find(el => el.getBoundingClientRect().width > 0);
            if (btn) {
              btn.setAttribute('data-auto-modal-close', 'true');
              return true;
            }
            return false;
          });
          if (closeBtn) {
            await page.click('[data-auto-modal-close="true"]').catch(() => {});
            console.log('モーダルを閉じるボタンをクリックしました。');
          } else {
            console.log('モーダルの閉じるボタンが見つかりませんでした(調査を続行します)。');
          }
        } catch (couponError) {
          console.log('クーポンモーダルの調査中にエラー: ' + couponError.message);
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        // 入力後の状態をスクリーンショットで確認(まだ「確認する」は押さない)
        const filledFormFileName = `filled_form_${Date.now()}.png`;
        const filledFormFilePath = path.join(SCREENSHOT_DIR, filledFormFileName);
        await page.screenshot({ path: filledFormFilePath, fullPage: true });

        const filledFormImageUrl = `${RENDER_BASE_URL}/screenshots/${filledFormFileName}`;
        await sendImageToLine(filledFormImageUrl);
        console.log('入力済みフォームの画像をLINEに送信しました。まだ送信(確認するボタン)は押していません。');

        // ===== 「確認する」ボタンをクリック =====
        // 注意: これは確認画面への遷移のみ。実際の投稿(「投稿する」ボタン)はまだ押さない。
        console.log('「確認する」ボタンを探しています...');

        const confirmButtonInfo = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"], div[onclick], span[onclick]'));
          const matches = candidates.filter(el => (el.textContent || el.value || '').trim() === '確認する');
          const btn = matches[0];
          if (btn) {
            const rect = btn.getBoundingClientRect();
            // jQueryでイベントが登録されている場合、jQueryのdataにハンドラが記録されていることがある
            let jqueryEvents = null;
            try {
              if (window.jQuery && window.jQuery._data) {
                jqueryEvents = Object.keys(window.jQuery._data(btn, 'events') || {});
              }
            } catch (e) {}
            return {
              found: true,
              matchCount: matches.length,
              tag: btn.tagName,
              type: btn.type || null,
              onclick: btn.getAttribute('onclick'),
              className: btn.className,
              href: btn.getAttribute('href'),
              parentFormId: btn.closest('form') ? btn.closest('form').id : null,
              jqueryEvents: jqueryEvents,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            };
          }
          return { found: false, matchCount: 0 };
        });
        console.log('「確認する」ボタンの検出結果: ' + JSON.stringify(confirmButtonInfo));

        if (confirmButtonInfo.found) {
          await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"], div[onclick], span[onclick]'));
            const btn = candidates.find(el => (el.textContent || el.value || '').trim() === '確認する');
            if (btn) btn.setAttribute('data-auto-confirm-target', 'true');
          });

          // クリック前に要素を画面内にスクロールする(not clickableエラー対策)
          await page.evaluate(() => {
            const el = document.querySelector('[data-auto-confirm-target="true"]');
            if (el) el.scrollIntoView({ block: 'center' });
          });
          await new Promise(resolve => setTimeout(resolve, 800));

          let confirmClickSucceeded = true;
          try {
            await page.click('[data-auto-confirm-target="true"]');
            console.log('「確認する」ボタンをクリックしました。');
          } catch (clickError) {
            confirmClickSucceeded = false;
            console.log('「確認する」ボタンの標準クリックに失敗: ' + clickError.message);
          }

          // このボタンは touchstart/touchmove/touchend イベントにのみ反応する
          // (スマホ版サイト特有の実装)ため、マウスクリックではなく
          // タッチイベントを明示的にシミュレートする必要がある。
          const btnRect = await page.evaluate(() => {
            const el = document.querySelector('[data-auto-confirm-target="true"]');
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          });

          if (btnRect) {
            console.log(`タッチイベントをシミュレートします: (${btnRect.x}, ${btnRect.y})`);
            try {
              await page.touchscreen.tap(btnRect.x, btnRect.y);
              console.log('page.touchscreen.tap() を実行しました。');
            } catch (touchError) {
              console.log('page.touchscreen.tap() に失敗: ' + touchError.message);

              // フォールバック: CDP(Chrome DevTools Protocol)を直接使ってタッチイベントを発火
              try {
                const client = await page.target().createCDPSession();
                await client.send('Input.dispatchTouchEvent', {
                  type: 'touchStart',
                  touchPoints: [{ x: btnRect.x, y: btnRect.y }]
                });
                await new Promise(resolve => setTimeout(resolve, 100));
                await client.send('Input.dispatchTouchEvent', {
                  type: 'touchEnd',
                  touchPoints: []
                });
                console.log('CDP経由でのタッチイベント発火に成功しました。');
              } catch (cdpError) {
                console.log('CDP経由でのタッチイベント発火にも失敗: ' + cdpError.message);
              }
            }
          } else {
            console.log('ボタンの座標が取得できませんでした。');
          }

          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {
            console.log('確認画面への遷移検知(waitForNavigation)がタイムアウトしました。安定待ちに切り替えます。');
          });

          await waitForPageStable(page);

          console.log('確認画面のURL: ' + page.url());

          // 確認画面の本文を取得(バリデーションエラーが出ていないかもここで分かる)
          const confirmBodyText = await page.evaluate(() => {
            return document.body ? document.body.innerText.slice(0, 800) : '(bodyが存在しません)';
          }).catch(() => '(本文の取得に失敗しました)');
          console.log('確認画面の本文: ' + confirmBodyText);

          // 確認画面にある「登録・未反映にする」ボタンを探してクリックする
          // (「登録・反映する」は即座に一般公開されるため、安全のためこちらは使わない)
          const draftButtonInfo = await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"], div[onclick], span[onclick]'));
            const btn = candidates.find(el => (el.textContent || el.value || '').trim() === '登録・未反映にする');
            if (btn) {
              return {
                found: true,
                tag: btn.tagName,
                type: btn.type || null,
                name: btn.name || null,
                onclick: btn.getAttribute('onclick')
              };
            }
            return { found: false };
          });
          console.log('「登録・未反映にする」ボタンの検出結果: ' + JSON.stringify(draftButtonInfo));

          // 確認画面のスクリーンショットをLINEに送信(ボタンを押す前の状態)
          const confirmFileName = `confirm_page_${Date.now()}.png`;
          const confirmFilePath = path.join(SCREENSHOT_DIR, confirmFileName);
          await page.screenshot({ path: confirmFilePath, fullPage: true });

          const confirmImageUrl = `${RENDER_BASE_URL}/screenshots/${confirmFileName}`;
          await sendImageToLine(confirmImageUrl);
          console.log('確認画面の画像をLINEに送信しました。');

          // ===== ここで初めて「登録・未反映にする」をクリックする =====
          // 「登録・反映する」ボタンは絶対にクリックしない(即座に一般公開されてしまうため)
          if (draftButtonInfo.found) {
            console.log('「登録・未反映にする」ボタンをクリックします...');

            await page.evaluate(() => {
              const candidates = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"], div[onclick], span[onclick]'));
              const btn = candidates.find(el => (el.textContent || el.value || '').trim() === '登録・未反映にする');
              if (btn) btn.setAttribute('data-auto-draft-target', 'true');
            });

            await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));

            // このボタンもタッチイベント専用の可能性が高いため、
            // 通常クリックとタッチイベントの両方を試す
            try {
              await page.click('[data-auto-draft-target="true"]');
              console.log('「登録・未反映にする」ボタンを標準クリックしました。');
            } catch (e) {
              console.log('「登録・未反映にする」ボタンの標準クリックに失敗: ' + e.message);
            }

            await tapElement(page, '[data-auto-draft-target="true"]', '登録・未反映にする');

            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {
              console.log('登録後ページへの遷移検知(waitForNavigation)がタイムアウトしました。安定待ちに切り替えます。');
            });

            await waitForPageStable(page);

            console.log('登録後のURL: ' + page.url());

            const afterSubmitBodyText = await page.evaluate(() => {
              return document.body ? document.body.innerText.slice(0, 500) : '(bodyが存在しません)';
            }).catch(() => '(本文の取得に失敗しました)');
            console.log('登録後のページ本文: ' + afterSubmitBodyText);

            const afterSubmitFileName = `after_draft_submit_${Date.now()}.png`;
            const afterSubmitFilePath = path.join(SCREENSHOT_DIR, afterSubmitFileName);
            await page.screenshot({ path: afterSubmitFilePath, fullPage: true });

            const afterSubmitImageUrl = `${RENDER_BASE_URL}/screenshots/${afterSubmitFileName}`;
            await sendImageToLine(afterSubmitImageUrl);
            console.log('登録完了後の画面をLINEに送信しました。(未反映状態での保存が完了しているはずです)');
          } else {
            console.log('「登録・未反映にする」ボタンが見つかりませんでした。');
          }
        } else {
          console.log('「確認する」ボタンが見つかりませんでした。');
        }
      } else {
        console.log('新規投稿ボタンが見つかりませんでした。');
      }
    } else {
      console.log('ブログボタンが見つかりませんでした。ページ構造を再確認する必要があります。');
    }

  } catch (error) {
    console.error('エラーが発生しました: ' + error.message);
  } finally {
    clearInterval(memoryLogInterval);
    await browser.close().catch(() => {
      console.log('ブラウザは既に閉じられていました。');
    });
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
