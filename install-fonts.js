/**
 * postinstallで実行される、日本語フォントのインストールスクリプト
 * 
 * Renderのビルド環境ではapt-getが使えないため、
 * Google Fontsから直接TTFファイルをダウンロードして、
 * Linuxのシステムフォントディレクトリに配置する。
 * これにより、Puppeteerが起動するChromeが日本語を正しく表示できるようになる。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Noto Sans JP(日本語をカバーする定番のGoogle Fonts)をダウンロードする
const FONT_URL = 'https://github.com/googlefonts/noto-cjk/raw/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf';
// ホームディレクトリはビルド環境と実行環境で共有されない可能性があるため、
// Puppeteerのキャッシュと同様にプロジェクト内のディレクトリに配置する
const FONT_DIR = path.join(__dirname, '.fonts');
const FONT_PATH = path.join(FONT_DIR, 'NotoSansCJKjp-Regular.otf');

function downloadFont(url, dest, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('リダイレクトが多すぎます'));
      return;
    }

    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      // GitHubのraw URLはリダイレクトされることがあるため対応
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        downloadFont(response.headers.location, dest, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`フォントのダウンロードに失敗: HTTP ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function main() {
  try {
    if (!fs.existsSync(FONT_DIR)) {
      fs.mkdirSync(FONT_DIR, { recursive: true });
    }

    console.log('日本語フォントをダウンロード中...');
    await downloadFont(FONT_URL, FONT_PATH);
    console.log('日本語フォントのインストールが完了しました: ' + FONT_PATH);

    // フォントキャッシュを更新(fc-cacheコマンドが使える場合のみ)
    // HOME環境変数をプロジェクト内に向けて、確実にこのディレクトリを対象にする
    const { execSync } = require('child_process');
    try {
      execSync('fc-cache -f', {
        stdio: 'inherit',
        env: { ...process.env, HOME: __dirname }
      });
      console.log('フォントキャッシュを更新しました。');
    } catch (e) {
      console.log('fc-cacheコマンドが利用できませんでした(問題ない場合が多いです): ' + e.message);
    }
  } catch (error) {
    // フォント取得に失敗してもビルド全体は止めない(ベストエフォート)
    console.error('日本語フォントのインストールに失敗しました(処理は続行します): ' + error.message);
  }
}

main();
