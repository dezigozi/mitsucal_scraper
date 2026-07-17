/**
 * みつかる君 サーチくん — 簡易アプリ本体
 * --------------------------------------
 * 起動:  npm start   （または start.command をダブルクリック）
 * ブラウザで http://localhost:3940 が開く。
 *
 *   ① ログイン確認 … .env の認証情報でログインできるかテスト
 *   ② スタート     … 全メーカー×全車種をクロール → CSV 出力
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crawler = require('./crawler');
const historyExcel = require('./history_excel');
const compareMod = require('./compare');

const PORT = 3940;

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ---- 画面 ----
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // ---- API ----
  if (req.method === 'GET' && url.pathname === '/api/check-login') {
    try {
      await crawler.checkLogin();
      return json(res, 200, { ok: true, loggedIn: true });
    } catch (e) {
      return json(res, 200, { ok: true, loggedIn: false, error: e.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    if (crawler.state.running) return json(res, 409, { ok: false, error: 'すでに実行中やで' });
    const maxCars = +url.searchParams.get('maxCars') || 0; // テスト用（例: ?maxCars=2）
    crawler.runCrawl(maxCars ? { maxCars } : {}).catch(() => {}); // 結果は /api/status で追う
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    crawler.requestAbort();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const s = crawler.state;
    return json(res, 200, {
      running: s.running, phase: s.phase, pagesDone: s.pagesDone,
      warnings: s.warnings, failedCars: s.failedCars,
      makersTotal: s.makersTotal, makersDone: s.makersDone,
      carsTotal: s.carsTotal, carsDone: s.carsDone, currentCar: s.currentCar,
      itemsFound: s.itemsFound, envReady: s.envReady,
      csvPath: s.csvPath, csvName: s.csvPath ? path.basename(s.csvPath) : '',
      lastError: s.lastError,
      log: s.log.slice(-200),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/open-folder') {
    try {
      fs.mkdirSync(crawler.OUTPUT_DIR, { recursive: true });
      const cmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'explorer'
        : 'xdg-open';
      exec(`${cmd} "${crawler.OUTPUT_DIR}"`);
      return json(res, 200, { ok: true, path: crawler.OUTPUT_DIR });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/csv') {
    const p = crawler.state.csvPath;
    if (!p || !fs.existsSync(p)) return json(res, 404, { ok: false, error: 'CSVがまだ無いで' });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(p))}"`,
    });
    return res.end(fs.readFileSync(p));
  }

  // ---- 保管庫・差分 ----
  if (req.method === 'GET' && url.pathname === '/api/history') {
    try {
      const h = crawler.latestDiff();
      // 表示は各カテゴリ最大500件（画面が重くならんように）
      if (h.diff) {
        for (const k of ['changed', 'added', 'removed']) {
          h.diff[k + 'Total'] = h.diff[k].length;
          h.diff[k] = h.diff[k].slice(0, 500);
        }
      }
      return json(res, 200, { ok: true, ...h });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/excel') {
    try {
      fs.mkdirSync(crawler.OUTPUT_DIR, { recursive: true });
      const file = historyExcel.makeExcelPath();
      await historyExcel.buildHistoryWorkbook(file);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(file))}"`,
      });
      return res.end(fs.readFileSync(file));
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // ---- Eマエカワ価格比較 ----
  if (req.method === 'GET' && url.pathname === '/api/compare') {
    try {
      const genre = url.searchParams.get('genre') || 'mat';
      return json(res, 200, compareMod.compare(genre));
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/compare/csv') {
    try {
      const genre = url.searchParams.get('genre') || 'mat';
      const result = compareMod.compare(genre);
      fs.mkdirSync(crawler.OUTPUT_DIR, { recursive: true });
      const file = compareMod.makeCsvPath(genre);
      fs.writeFileSync(file, compareMod.toCsv(result)); // output/ にも残す
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(file))}"`,
      });
      return res.end(fs.readFileSync(file));
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = `http://localhost:${PORT}`;
  console.log(`\n🔧 みつかる君 サーチくん 起動！ → ${addr}\n`);
  if (process.platform === 'darwin') exec(`open ${addr}`);
  if (process.platform === 'win32') exec(`start ${addr}`);
});

process.on('SIGINT', async () => {
  console.log('\n終了するで〜');
  await crawler.closeBrowser();
  process.exit(0);
});
