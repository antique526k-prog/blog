/**
 * ============================================
 * SalonBoard 自動化サービス
 *
 * 元々 salonboard-login.js としてテストスクリプト形式で
 * 開発していたロジックを、再利用可能な関数群に整理したもの。
 *
 * 【重要な注意】
 * salonboard.com は robots.txt で自動アクセスを明示的に禁止しています。
 * これは自社アカウント・自社利用に限定した運用であることを
 * 前提に進めています。商用サービス化や他社への提供は行わないでください。
 *
 * 【この中で得られた重要な知見】
 * - SalonBoardのスマホ版は、ボタンによっては通常のクリックイベントに
 *   反応せず、touchstart/touchmove/touchend のタッチイベントにのみ
 *   反応するものがある(「確認する」「登録・未反映にする」ボタンなど)。
 *   → tapElement() でタッチイベントをシミュレートして対応する。
 * - 本文入力欄は見た目上 nicEdit というリッチテキストエディタの
 *   contenteditable な div (.nicEdit-main) であり、裏側に隠れた
 *   textarea (#blogContents) とは別物。.nicEdit-main に直接入力する必要がある。
 * - ページ遷移は複数回のリダイレクトを挟むことがあるため、
 *   waitForNavigation だけでなく waitForPageStable() で
 *   URLと読み込み状態が安定するまで確認する必要がある。
 * ============================================
 */

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const puppeteer = puppeteerExtra;
const path = require('path');
const fs = require('fs');
const https = require('https');

const LOGIN_URL = 'https://salonboard.com/login_sp/';

// ===== ページが安定するまで待つ共通関数 =====
async function waitForPageStable(page, maxRetries = 15, intervalMs = 1000) {
  let stableCount = 0;
  let lastUrl = '';

  for (let i = 0; i < maxRetries; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      const currentUrl = page.url();
      const readyState = await page.evaluate(() => document.readyState);
      const hasBody = await page.evaluate(() => !!document.body);

      if (currentUrl === lastUrl && readyState === 'complete' && hasBody) {
        stableCount++;
        if (stableCount >= 2) return true;
      } else {
        stableCount = 0;
      }
      lastUrl = currentUrl;
    } catch (e) {
      stableCount = 0;
    }
  }
  return false;
}

// ===== SalonBoard特有のタッチイベント専用ボタンをタップする共通関数 =====
async function tapElement(page, selector) {
  const rect = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);

  if (!rect) return false;

  try {
    await page.touchscreen.tap(rect.x, rect.y);
    return true;
  } catch (touchError) {
    try {
      const client = await page.target().createCDPSession();
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: rect.x, y: rect.y }],
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      return true;
    } catch (cdpError) {
      return false;
    }
  }
}

// ===== 画像URLをローカルファイルとしてダウンロードする共通関数 =====
function downloadFile(url, destPath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('リダイレクトが多すぎます'));
      return;
    }
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close();
          fs.unlink(destPath, () => {});
          downloadFile(response.headers.location, destPath, redirectCount + 1)
            .then(resolve)
            .catch(reject);
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
      })
      .on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}

// ===== ブラウザを起動する共通処理 =====
async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--no-first-run',
      '--mute-audio',
      '--js-flags=--max-old-space-size=256', // V8のヒープサイズを制限してメモリ使用量を抑える
    ],
  });
}

// ===== ログイン処理(2パスワードを順に試す) =====
// @param {import('puppeteer').Page} page
// @param {{loginId: string, passwords: string[]}} salonboardConfig
// @returns {Promise<boolean>} ログイン成功したかどうか
async function loginToSalonBoard(page, salonboardConfig) {
  const { loginId, passwords } = salonboardConfig;
  if (!loginId || !passwords || passwords.length === 0) {
    throw new Error('SalonBoardのログイン情報が設定されていません');
  }

  for (const password of passwords) {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await page.waitForSelector('input[name="userId"]');
    await page.click('input[name="userId"]');
    await page.type('input[name="userId"]', loginId, { delay: 80 + Math.random() * 60 });

    await new Promise((resolve) => setTimeout(resolve, 400));

    await page.waitForSelector('input[name="password"]');
    await page.click('input[name="password"]');
    await page.type('input[name="password"]', password, { delay: 80 + Math.random() * 60 });

    await new Promise((resolve) => setTimeout(resolve, 800));

    // ログインボタン(<a onclick="dologin(event)">)をクリック
    const marked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const loginLink = links.find((a) => a.textContent.trim() === 'ログイン');
      if (loginLink) {
        loginLink.setAttribute('data-auto-login-target', 'true');
        return true;
      }
      return false;
    });
    if (!marked) continue;

    await page.click('a[data-auto-login-target="true"]').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await waitForPageStable(page);

    // ログイン成功の判定: URLがログインページから変わっているか
    const currentUrl = page.url();
    const isStillLoginPage = currentUrl.includes('/login_sp/');
    if (!isStillLoginPage) {
      return true; // このパスワードでログイン成功
    }
    // 失敗した場合は次のパスワードで再試行する
  }

  return false; // 全パスワードで失敗
}

// ===== 新規投稿ページまで遷移する =====
async function navigateToNewPostForm(page) {
  // ブログ一覧へ
  const blogLinkMarked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('a, button, div[onclick], span[onclick]'));
    const btn = candidates.find((el) => el.textContent.trim() === 'ブログ');
    if (btn) {
      btn.setAttribute('data-auto-blog-target', 'true');
      return true;
    }
    return false;
  });
  if (!blogLinkMarked) throw new Error('「ブログ」メニューが見つかりませんでした');

  await page.click('[data-auto-blog-target="true"]').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitForPageStable(page);

  // 新規投稿ボタン
  const newPostMarked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('a, button, div[onclick], span[onclick]'));
    const btn = candidates.find((el) => el.textContent.trim() === '新規投稿');
    if (btn) {
      btn.setAttribute('data-auto-newpost-target', 'true');
      return true;
    }
    return false;
  });
  if (!newPostMarked) throw new Error('「新規投稿」ボタンが見つかりませんでした');

  await page.click('[data-auto-newpost-target="true"]').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitForPageStable(page);
}

// ===== 投稿者・カテゴリのプルダウン選択肢を取得する =====
// @returns {Promise<{stylist: Array<{value:string,text:string}>, category: Array<{value:string,text:string}>}>}
async function getDropdownOptions(page) {
  return page.evaluate(() => {
    function getOptions(selector) {
      const select = document.querySelector(selector);
      if (!select) return [];
      return Array.from(select.options)
        .map((opt) => ({ value: opt.value, text: opt.textContent.trim() }))
        .filter((opt) => opt.value); // 「選択してください」を除外
    }
    return {
      stylist: getOptions('select[name="stylistId"]'),
      category: getOptions('select[name="blogCategoryCd"]'),
    };
  });
}

/**
 * 店舗の投稿者・カテゴリ一覧を取得する(SalonBoardに実際にログインして取得)
 * キャッシュ機構は sheetsService.js 側で管理し、この関数は「常に最新を取りに行く」処理のみを担う。
 * @param {object} store config/stores.js の1店舗分の設定オブジェクト
 * @returns {Promise<{stylist: Array, category: Array}>}
 */
async function fetchStylistOptions(store) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await setupPage(page);

    const loggedIn = await loginToSalonBoard(page, store.salonboard);
    if (!loggedIn) {
      throw new Error(`[${store.name}] SalonBoardへのログインに失敗しました(全パスワードで失敗)`);
    }

    await navigateToNewPostForm(page);
    const options = await getDropdownOptions(page);
    return options;
  } finally {
    await browser.close();
  }
}

// ===== ページの基本設定(User-Agent, viewport等) =====
async function setupPage(page) {
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  );
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9' });
  await page.emulateTimezone('Asia/Tokyo');
}

// ===== タイトル・本文をフォームに入力する =====
async function fillTitleAndBody(page, title, body) {
  // タイトル
  await page.evaluate(() => {
    const el = document.querySelector('#blogTitle');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    await page.click('#blogTitle');
    await page.type('#blogTitle', title, { delay: 60 + Math.random() * 40 });
  } catch (e) {
    await page.evaluate((text) => {
      const el = document.querySelector('#blogTitle');
      if (el) {
        el.focus();
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, title);
  }

  await new Promise((resolve) => setTimeout(resolve, 400));

  // 本文(nicEditのcontenteditable divに入力する。#blogContentsは裏側の隠しtextareaなので使わない)
  await page.evaluate(() => {
    const el = document.querySelector('.nicEdit-main');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    await page.click('.nicEdit-main');
    await page.type('.nicEdit-main', body, { delay: 40 + Math.random() * 30 });
  } catch (e) {
    await page.evaluate((text) => {
      const el = document.querySelector('.nicEdit-main');
      if (el) {
        el.focus();
        el.innerHTML = text.replace(/\n/g, '<br>');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('keyup', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }
    }, body);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

// ===== 画像をアップロードする =====
async function uploadImage(page, imageUrl) {
  const tempImagePath = path.join(__dirname, '..', `temp-image-${Date.now()}.jpg`);
  try {
    await downloadFile(imageUrl, tempImagePath);
    const fileInputHandle = await page.$('#IMG_PATH');
    if (!fileInputHandle) throw new Error('画像アップロード欄(#IMG_PATH)が見つかりませんでした');
    await fileInputHandle.uploadFile(tempImagePath);
    // SalonBoard側の非同期アップロード処理が完了するまで待つ
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } finally {
    fs.unlink(tempImagePath, () => {}); // 一時ファイルを削除(失敗しても無視)
  }
}

// ===== 投稿者・カテゴリを選択する =====
async function selectStylistAndCategory(page, stylistId, categoryCd) {
  if (stylistId) {
    await page.select('select[name="stylistId"]', stylistId);
  }
  if (categoryCd) {
    await page.select('select[name="blogCategoryCd"]', categoryCd);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

// ===== 「確認する」→「登録・未反映にする」まで進める =====
async function submitAsDraft(page) {
  // 「確認する」ボタン(タッチイベント専用)
  const confirmMarked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));
    const btn = candidates.find((el) => (el.textContent || el.value || '').trim() === '確認する');
    if (btn) {
      btn.setAttribute('data-auto-confirm-target', 'true');
      return true;
    }
    return false;
  });
  if (!confirmMarked) throw new Error('「確認する」ボタンが見つかりませんでした');

  await page.evaluate(() => {
    const el = document.querySelector('[data-auto-confirm-target="true"]');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await new Promise((resolve) => setTimeout(resolve, 800));

  await page.click('[data-auto-confirm-target="true"]').catch(() => {});
  await tapElement(page, '[data-auto-confirm-target="true"]');

  await new Promise((resolve) => setTimeout(resolve, 1000));
  await waitForPageStable(page);

  // 「登録・未反映にする」ボタン(こちらもタッチイベント専用)
  // 「登録・反映する」ボタンは絶対にクリックしない(即座に一般公開されてしまうため)
  const draftMarked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));
    const btn = candidates.find((el) => (el.textContent || el.value || '').trim() === '登録・未反映にする');
    if (btn) {
      btn.setAttribute('data-auto-draft-target', 'true');
      return true;
    }
    return false;
  });
  if (!draftMarked) {
    // 診断用に、現在のURLとページ本文冒頭を含めてエラーを投げる
    const currentUrl = page.url();
    const bodyPreview = await page
      .evaluate(() => (document.body ? document.body.innerText.slice(0, 400) : '(bodyなし)'))
      .catch(() => '(本文取得失敗)');
    throw new Error(
      `「登録・未反映にする」ボタンが見つかりませんでした(確認画面に正しく遷移できていない可能性があります)。` +
      `URL: ${currentUrl} / ページ本文冒頭: ${bodyPreview}`
    );
  }

  await page.click('[data-auto-draft-target="true"]').catch(() => {});
  await tapElement(page, '[data-auto-draft-target="true"]');

  await new Promise((resolve) => setTimeout(resolve, 1000));
  await waitForPageStable(page);

  const finalUrl = page.url();
  const bodyText = await page
    .evaluate(() => (document.body ? document.body.innerText.slice(0, 300) : ''))
    .catch(() => '');
  const success = bodyText.includes('登録が完了しました');

  return { success, finalUrl, bodyText };
}

/**
 * SalonBoardへブログを未反映状態で投稿する(メイン関数)
 * @param {object} store config/stores.js の1店舗分の設定オブジェクト
 * @param {{stylistId: string, categoryCd: string, title: string, body: string, imageUrl: string}} params
 * @returns {Promise<{success: boolean, finalUrl: string, message: string}>}
 */
async function postBlogToSalonBoard(store, params) {
  const { stylistId, categoryCd, title, body, imageUrl } = params;

  if (!title || title.length > 25) {
    throw new Error('タイトルは1〜25文字(全角)で指定してください');
  }
  if (!body || body.length > 1000) {
    throw new Error('本文は1〜1000文字(全角)で指定してください');
  }

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await setupPage(page);

    const loggedIn = await loginToSalonBoard(page, store.salonboard);
    if (!loggedIn) {
      throw new Error(`[${store.name}] SalonBoardへのログインに失敗しました(全パスワードで失敗)`);
    }

    await navigateToNewPostForm(page);
    await fillTitleAndBody(page, title, body);

    if (imageUrl) {
      await uploadImage(page, imageUrl);
    }

    await selectStylistAndCategory(page, stylistId, categoryCd);

    const result = await submitAsDraft(page);
    if (!result.success) {
      throw new Error(
        `SalonBoard投稿処理が完了しましたが、成功メッセージが確認できませんでした。URL: ${result.finalUrl}`
      );
    }

    return { success: true, finalUrl: result.finalUrl, message: '未反映状態で登録が完了しました' };
  } finally {
    await browser.close();
  }
}

module.exports = {
  fetchStylistOptions,
  postBlogToSalonBoard,
};
