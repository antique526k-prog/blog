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
/**
 * ============================================
 * 【追加分】口コミ返信まわりの関数群
 * salonboardService.js の既存コード(loginToSalonBoard, launchBrowser,
 * waitForPageStable, tapElement, setupPage など)をそのまま再利用する前提。
 * この内容を salonboardService.js の末尾(module.exports の手前)に貼り付けてください。
 *
 * 【本部アカウントについて】
 * 既存の config/stores.js は店舗ごとの個別ログイン(store.salonboard)を前提にしているが、
 * 口コミチェックは本部アカウント(全店舗共通の1ログイン)を使う方針のため、
 * 呼び出し側で以下のような設定オブジェクトを渡すこと:
 *
 *   const HQ_SALONBOARD_CONFIG = {
 *     loginId: process.env.SALONBOARD_HQ_ID,
 *     passwords: [
 *       process.env.SALONBOARD_HQ_PASSWORD_1,
 *       process.env.SALONBOARD_HQ_PASSWORD_2,
 *     ].filter(Boolean),
 *   };
 *
 * 【店舗IDについて】
 * サロン一覧(/CNC/groupTop/)の各店舗リンクのid属性がそのままSalonBoard内部の店舗ID。
 * 2026/08/20 実機確認済み:
 *   aimer: H000056993 / Day.: H000514272 / Fika: H000724174 / style: H000039194
 *   merry: H000086179 / ritta: H000226786 / Luke: H000695311 / rudii: H000086195
 * ============================================
 */

const GROUP_TOP_URL = 'https://salonboard.com/CNC/groupTop/';
const REVIEW_LIST_URL = 'https://salonboard.com/CLS/bt/review/reviewList/';
const REVIEW_DETAIL_URL = 'https://salonboard.com/CLS/bt/review/reviewReply/';
const REVIEW_PAGE_SIZE = 20; // 確認済み。1ページあたりの表示件数

// ===== 本部アカウントでログインし、ページを開いたまま返す =====
// (レビューチェックは複数店舗を回るため、1回ログインしてページを使い回す設計。
//  fetchStylistOptions のように呼び出し毎にログインし直すと本部アカウントへの
//  負荷・ログイン回数が増えてしまうため、あえてこちらは呼び出し元でbrowser/pageを
//  使い回す前提にしている)
async function loginHQAndGetPage(hqSalonboardConfig) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await setupPage(page);

  const loggedIn = await loginToSalonBoard(page, hqSalonboardConfig);
  if (!loggedIn) {
    await browser.close();
    throw new Error('SalonBoard本部アカウントへのログインに失敗しました(全パスワードで失敗)');
  }
  return { browser, page };
}

// ===== サロン一覧から指定店舗に切り替える =====
async function switchToStore(page, salonId) {
      await page.goto(GROUP_TOP_URL, { waitUntil: 'networkidle2' });
      const [clicked] = await Promise.all([
              page.evaluate((id) => {
                        const el = document.getElementById(id);
                        if (el) {
                                    el.click();
                                    return true;
                        }
                        return false;
              }, salonId),
            ]);
      if (!clicked) {
              throw new Error(
                        `店舗ID "${salonId}" のリンクがサロン一覧(${GROUP_TOP_URL})に見つかりませんでした。config/stores.jsのhotpepperSalonIdを確認してください。`
                      );
      }
      await waitForPageStable(page);
      // 店舗切り替え後、口コミ一覧など次のページ操作の前に少し待つ
      // (headless環境ではnetworkidle2判定後もDOM描画が追いついていないことがあるため)
      await new Promise((r) => setTimeout(r, 800));
}

// ===== 現在のページから口コミ1件分の担当者名・管理番号を抜き出す =====
async function extractReviewSummariesFromPage(page) {
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('div.revInfo'));
    return items.map((item) => {
      const labels = Array.from(item.querySelectorAll('span.mr5.dib.w6e'));

      const staffLabel = labels.find((el) => el.textContent.trim() === '担当者');
      const staff =
        staffLabel && staffLabel.nextElementSibling
          ? staffLabel.nextElementSibling.textContent.replace('：', '').trim()
          : '(不明)';

      const mgmtLabel = labels.find((el) => el.textContent.trim() === '管理番号');
      const reviewId =
        mgmtLabel && mgmtLabel.nextElementSibling
          ? mgmtLabel.nextElementSibling.textContent.replace('：', '').trim()
          : null;

      return { staff, reviewId };
    });
  });
}

// ===== 現在ログイン中・店舗切り替え済みのpageで、未返信口コミ一覧を取得する =====
// (ページネーション対応込み。件数が多い店舗は複数ページ遷移するため時間がかかる)
async function fetchUnrepliedReviewSummaries(page) {
  await page.goto(REVIEW_LIST_URL, { waitUntil: 'networkidle2' });

  try {
          await page.waitForSelector('#reviewCategoryCd', { timeout: 15000 });
  } catch (e) {
          throw new Error(
                    `口コミ一覧ページに #reviewCategoryCd が見つかりませんでした(現在のURL: ${page.url()})。店舗切り替えが正しく完了していない可能性があります。`
                  );
  }
      await page.select('#reviewCategoryCd', '2'); // 2 = 未返信の口コミ
  await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));

  const totalCount = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('p'));
    const target = els.find(
      (el) => el.textContent.includes('該当する口コミが') && el.textContent.includes('件あります')
    );
    if (!target) return null;
    const m = target.textContent.match(/該当する口コミが(\d+)件/);
    return m ? parseInt(m[1], 10) : null;
  });

  if (totalCount === null) {
    throw new Error('未返信件数のテキストが見つかりませんでした。画面構造が変わっている可能性があります。');
  }

  let summaries = await extractReviewSummariesFromPage(page);

  const totalPages = Math.ceil(totalCount / REVIEW_PAGE_SIZE);
  for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
    await page.goto(`${REVIEW_LIST_URL}search?pn=${pageNum}`, { waitUntil: 'networkidle2' });
    const more = await extractReviewSummariesFromPage(page);
    summaries = summaries.concat(more);
  }

  return { totalCount, reviews: summaries };
}

// ===== 口コミ詳細(本文・評点・ニックネーム)を取得する =====
// 重要: 返信は必ず「ニックネーム」で呼びかけること。「予約者名」は内部管理用の
// 実名で、お客様の非公開情報。返信文にもLIFF画面にも絶対に表示してはいけない。
async function fetchReviewDetail(page, reviewId) {
  const url = `${REVIEW_DETAIL_URL}?reviewId=${encodeURIComponent(reviewId)}`;
  await page.goto(url, { waitUntil: 'networkidle2' });

  return page.evaluate(() => {
    const scoreLabelCell = Array.from(document.querySelectorAll('td, th')).find(
      (el) => el.textContent.trim() === '口コミ評点'
    );
    const scoreCell = scoreLabelCell ? scoreLabelCell.nextElementSibling : null;
    const scoreText = scoreCell ? scoreCell.textContent.trim() : '';

    const scores = {};
    const scorePattern = /(雰囲気|接客サービス|技術・仕上がり|メニュー・料金|総合満足度)：(\d+)/g;
    let m;
    while ((m = scorePattern.exec(scoreText)) !== null) {
      scores[m[1]] = parseInt(m[2], 10);
    }

    // 本文は「口コミ評点」行の直後の行にラベルなしで入っている。
    // 改行が<br>タグのため子要素の有無では判定せず、行の位置で特定する。
    let body = '';
    const scoreRow = scoreLabelCell ? scoreLabelCell.closest('tr') : null;
    const bodyRow = scoreRow ? scoreRow.nextElementSibling : null;
    const bodyCell = bodyRow ? bodyRow.querySelector('td') : null;
    if (bodyCell) body = bodyCell.textContent.trim();

    const nicknameLabel = Array.from(document.querySelectorAll('td, th')).find(
      (el) => el.textContent.trim() === 'ニックネーム'
    );
    const nickname =
      nicknameLabel && nicknameLabel.nextElementSibling
        ? nicknameLabel.nextElementSibling.textContent.trim()
        : '';

    return { scores, body, nickname };
  });
}

/**
 * ===== 口コミへの返信を投稿する =====
 *
 * 実機確認済み(2026/08/20、テスト文言を入力→確認画面まで到達→「戻る」で離脱、
 * 実際の投稿・保存は行っていないことを確認済み):
 *   1. reviewReply?reviewId=xxx に遷移
 *   2. #replyFrom に返信投稿者名(任意)、#replyContents に返信内容(必須・500字)を入力
 *   3. 「確認する」(id="confirm")をクリック → /reviewReply/confirm に遷移
 *      この画面にSalonBoard自身の警告が出る:
 *      「返信内容に『投稿者実名』(本名)が含まれていないことを必ずご確認ください」
 *      → ニックネームのみを使う実装方針の正しさが公式側からも裏付けられている
 *   4. 「投稿する」(id="replyComplete")をクリックすると本番公開される
 *      (「投稿せず保存する」id="replyCompleteSave" は下書き保存。
 *       LIFFで担当者が内容を確認済みという前提のため、ここでは
 *       下書き保存は経由せず直接 replyComplete を使う)
 *
 * @param {import('puppeteer').Page} page ログイン済み・対象店舗切り替え済みのpage
 * @param {string} reviewId 管理番号
 * @param {{replyContent: string, replyFrom?: string}} params
 * @returns {Promise<{success: boolean}>}
 */
async function postReviewReply(page, reviewId, { replyContent, replyFrom = '' }) {
  if (!replyContent || !replyContent.trim()) {
    throw new Error('返信内容が空です');
  }
  if (replyContent.length > 500) {
    throw new Error(`返信内容が500字を超えています(${replyContent.length}字)`);
  }

  const url = `${REVIEW_DETAIL_URL}?reviewId=${encodeURIComponent(reviewId)}`;
  await page.goto(url, { waitUntil: 'networkidle2' });

  // 既に返信済みでないか確認(念のための二重投稿防止)
  const alreadyHasContent = await page.evaluate(() => {
    const ta = document.querySelector('#replyContents');
    return ta ? ta.value.trim().length > 0 : false;
  });
  if (alreadyHasContent) {
    throw new Error(
      `reviewId=${reviewId} は既に返信内容が入力されています(二重投稿の可能性)。手動で確認してください。`
    );
  }

  if (replyFrom) {
    await page.waitForSelector('#replyFrom');
    await page.click('#replyFrom');
    await page.type('#replyFrom', replyFrom, { delay: 40 + Math.random() * 30 });
  }

  await page.waitForSelector('#replyContents');
  await page.click('#replyContents');
  await page.type('#replyContents', replyContent, { delay: 20 + Math.random() * 20 });

  await new Promise((r) => setTimeout(r, 400));

  // タッチイベント専用ボタンのためtapElementで直接タップする
  await tapElement(page, '#confirm');
  await waitForPageStable(page);

  const onConfirmPage = page.url().includes('/reviewReply/confirm');
  if (!onConfirmPage) {
    throw new Error(`確認画面への遷移に失敗しました。現在のURL: ${page.url()}`);
  }

  // 確認画面に入力内容がそのまま表示されているか最終チェック(ページ全体を対象に、
  // 特定のセレクタに依存しない形で確認。画面構造が変わっても壊れにくくするため)
  const pageHasContent = await page.evaluate(
    (text) => document.body.textContent.includes(text),
    replyContent.trim()
  );
  if (!pageHasContent) {
    throw new Error('確認画面の内容が入力内容と一致しません。手動で確認してください。');
  }

      // 「投稿する」(本番公開)。タッチイベント専用ボタンのためtapElementで直接タップする。
      await tapElement(page, '#replyComplete');
  await waitForPageStable(page);

  return { success: true };
}

module.exports = {
  fetchStylistOptions,
  postBlogToSalonBoard,
  // ↓ 追加分
  loginHQAndGetPage,
  switchToStore,
  fetchUnrepliedReviewSummaries,
  fetchReviewDetail,
  postReviewReply,
};

