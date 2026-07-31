/**
 * みつかる君クローラー（Node/Playwright版）
 * -----------------------------------------
 * Eマエカワ サーチくんと同じベース構成。
 * .env の認証情報で自動ログイン → 全メーカー×全車種の商品・価格を取得。
 *
 * 保存先:
 *   output/mitsucal_全車種商品_{stamp}.csv      … 全件CSV（BOM付きUTF-8）
 *   output/メーカー別/{stamp}/{メーカー}.csv     … メーカーごとに区分けしたCSV
 *   archive/{stamp}.json                        … 完走時のみ保存（差分比較用の保管庫）
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://mitsucal.arai-denki.co.jp';
const LOGIN_URL = BASE_URL + '/mypages/login';
const NAV_TIMEOUT = 60000;
const ELEM_TIMEOUT = 30000;
const LAUNCH_TIMEOUT = 30000;

// ログインフォームの入力欄。2026-07にサイトがASP.NET化してidが総取っ替えされたため、
// 新id → 旧id の順に試す（また変わったら先頭に足すこと）。
const LOGIN_FIELDS = {
  username: ['#txtLoginId', '#MypageLoginId'],
  password: ['#txtPassword', '#MypagePassword'],
  companyCode: ['#txtCompanyCd', '#MypageCompanyCd'],
  submit: ['#btnLogin', "input[type='image']"],
};

const OUTPUT_DIR = path.join(__dirname, 'output');
const ARCHIVE_DIR = path.join(__dirname, 'archive');

const DEFAULTS = {
  maxCars: 0,      // 0 = 全車種。テスト時は 2〜3 に
  delayMs: 500,    // 車種間ウェイト（サーバーにやさしく）
  tabDelayMs: 150, // ジャンルタブ間ウェイト
};

// ---- 状態（server.js から参照） -----------------------------------------
const state = {
  running: false,
  phase: 'idle',          // idle | crawling | done | error
  pagesDone: 0,
  makersTotal: 0,
  makersDone: 0,
  carsTotal: 0,
  carsDone: 0,
  currentCar: '',
  itemsFound: 0,
  warnings: 0,
  failedCars: [],
  csvPath: '',
  lastError: '',
  envReady: false,
  log: [],
};

let browser = null;
let abortFlag = false;

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('ja-JP')}] ${msg}`;
  state.log.push(line);
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
  console.log(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- .env ----------------------------------------------------------------
function loadEnv() {
  const file = path.join(__dirname, '.env');
  const env = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  const username = env.MITSUCAL_USERNAME || '';
  const password = env.MITSUCAL_PASSWORD || '';
  const companyCode = env.MITSUCAL_COMPANY_CODE || '';
  const ok = !!(username && password) && !username.startsWith('your_') && !password.startsWith('your_');
  state.envReady = ok;
  return { username, password, companyCode, ok };
}

// ---- ブラウザ管理 ----------------------------------------------------------
/**
 * ブラウザ起動。長時間起動しっぱなしのサーバーではChromeプロセスだけ先に死ぬことがあり、
 * その状態のlaunchは「Target page, context or browser has been closed」で落ちる。
 * → タイムアウト付きで最大3回リトライし、失敗した殻は必ず捨ててから張り直す。
 */
async function launchBrowser() {
  const attempts = 3;
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await chromium.launch({ headless: true, timeout: LAUNCH_TIMEOUT });
    } catch (e) {
      lastErr = e;
      log(`⚠ ブラウザ起動に失敗（${i}/${attempts}回目）: ${e.message.split('\n')[0]}`);
      await closeBrowser();
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(`ブラウザを起動できひんかった（${attempts}回試した）: ${lastErr && lastErr.message.split('\n')[0]}`);
}

async function getPage() {
  if (!browser || !browser.isConnected()) {
    await closeBrowser();
    browser = await launchBrowser();
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  return page;
}

async function closeBrowser() {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

// ---- ログイン --------------------------------------------------------------
/** 候補セレクタを順に試す。全部無かったらどれを探したか分かる形で落とす。 */
async function findField(page, selectors, label) {
  for (const sel of selectors) {
    if (await page.$(sel)) return sel;
  }
  throw new Error(`ログイン画面の「${label}」が見つからへん（試したのは ${selectors.join(' / ')}）。サイトの作りが変わったかもしれん`);
}

async function login(page, creds) {
  log('ログインページにアクセス中…');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  state.pagesDone++;
  await page.fill(await findField(page, LOGIN_FIELDS.username, 'ID'), creds.username);
  await page.fill(await findField(page, LOGIN_FIELDS.password, 'パスワード'), creds.password);
  if (creds.companyCode) {
    await page.fill(await findField(page, LOGIN_FIELDS.companyCode, '会社コード'), creds.companyCode);
  }
  await page.click(await findField(page, LOGIN_FIELDS.submit, 'ログインボタン'));
  await page.waitForSelector('.topBox', { timeout: ELEM_TIMEOUT });
  log('ログイン成功や！');
}

/** ①ログイン確認：.env の認証情報で実際にログインできるかテストする */
async function checkLogin() {
  const creds = loadEnv();
  if (!creds.ok) {
    throw new Error('.env に MITSUCAL_USERNAME / MITSUCAL_PASSWORD を設定してな（env_template.txt をコピーして作れるで）');
  }
  const page = await getPage();
  try {
    await login(page, creds);
    return true;
  } finally {
    await page.context().close().catch(() => {});
    // ブラウザを残すと、サーバーを何日も起動しっぱなしにしたとき殻だけ腐って次回のlaunchが死ぬ
    await closeBrowser();
  }
}

// ---- 収集ステップ ------------------------------------------------------------
async function getMakers(page) {
  return page.evaluate(() => {
    const container = document.querySelector('.topBox ul');
    if (!container) return [];
    const result = [];
    for (const a of container.querySelectorAll('a')) {
      const img = a.querySelector('img');
      result.push({ href: a.getAttribute('href'), name: img ? img.alt : '' });
    }
    return result;
  });
}

/**
 * メーカーページの車種一覧。
 * ※ DOMには全メーカーの車種が入っていて、そのメーカーの分だけが表示される構造。
 *   車種コードは各liのhidden input（hidMakerCarCd、例 "001:001120400"）に入っていて、
 *   先頭がメーカーコードなのでそれでフィルタする。
 *   （2026-07のASP.NET化でチェックボックスvalueは"on"になり、コードはhiddenに移った）
 */
async function getCars(page, makerCode) {
  const all = await page.evaluate(() => {
    const result = [];
    for (const hid of document.querySelectorAll('input[type="hidden"][name*="hidMakerCarCd"]')) {
      const li = hid.closest('li');
      const img = li ? li.querySelector('img') : null;
      result.push({ value: hid.value, name: img ? img.alt : '' });
    }
    return result;
  });
  return makerCode ? all.filter((c) => c.value.startsWith(makerCode + ':')) : all;
}

async function getProducts(page) {
  return page.evaluate(() => {
    const result = [];
    for (const li of document.querySelectorAll('.products ul > li')) {
      const fo14 = li.querySelector('span.fo14');
      const fo15 = li.querySelector('span.fo15');
      if (!fo14) continue;
      const html14 = fo14.innerHTML;
      const textParts = fo14.innerText.trim().split('\n').map((s) => s.trim()).filter((s) => s);
      const hinban = textParts[0] || '';
      const hinmei = textParts[1] || '';
      const commentMatch = html14.match(/<!--\s*\n?\s*(.+?)\s*<br/);
      const maker = commentMatch ? commentMatch[1].trim() : '';
      const price = fo15 ? fo15.innerText.trim() : '';
      result.push({ hinban, hinmei, maker, price });
    }
    return result;
  });
}

function extractPrice(text) {
  if (!text) return { price: '', priceText: '' };
  const t = String(text).trim();
  const m = t.match(/[\d,]+/);
  if (m) {
    const n = parseInt(m[0].replace(/,/g, ''), 10);
    if (!Number.isNaN(n)) return { price: n, priceText: t };
  }
  return { price: '', priceText: t };
}

/** メーカーページに移動して、指定車種だけチェック→フォーム送信で商品ページへ */
async function openProductsPage(page, makerHref, carValue) {
  await page.goto(BASE_URL + makerHref, { waitUntil: 'domcontentloaded' });
  state.pagesDone++;
  await page.waitForSelector('.carBox li', { state: 'attached', timeout: ELEM_TIMEOUT });
  // hidMakerCarCd の値で車種を名指し→同じliのチェックボックスをONにして送信ボタンをクリック
  // （ASP.NETのpostbackなので form.submit() やなくボタンclickで送ること）
  await page.evaluate((val) => {
    document.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
    let found = false;
    for (const hid of document.querySelectorAll('input[type="hidden"][name*="hidMakerCarCd"]')) {
      if (hid.value === val) {
        const cb = hid.closest('li').querySelector('input[type="checkbox"]');
        if (cb) { cb.checked = true; found = true; }
        break;
      }
    }
    if (!found) throw new Error(`車種コード ${val} がページに見つからへん`);
    document.getElementById('MainContent_SubmitButton').click();
  }, carValue);
  try {
    await page.waitForURL(/\/products\/products/, { timeout: 15000 });
  } catch (_) {
    throw new Error(`商品ページに遷移できへんかった: ${page.url()}`);
  }
  state.pagesDone++;
}

/**
 * 商品ページのジャンルタブ（ナビ/DA・ETC車載器・フロアマット…）を取る。
 * タブは /products/products/{メーカー}/{車種}/{ジャンルID} への単純なGETリンク。
 */
async function getCategoryTabs(page) {
  const tabs = await page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href^="/products/products/"]')) {
      const href = a.getAttribute('href');
      const name = (a.textContent || '').trim();
      if (/^\/products\/products\/[^/]+\/[^/]+\/\d+$/.test(href) && name) {
        out.push({ href, name });
      }
    }
    return out;
  });
  const seen = new Set();
  return tabs.filter((t) => t.name !== '全て' && (seen.has(t.href) ? false : (seen.add(t.href), true)));
}

/** 1車種の全ジャンルの商品を取得（ジャンル名つき） */
async function fetchProductsForCar(page, conf) {
  const tabs = await getCategoryTabs(page);
  if (!tabs.length) {
    // タブが見つからん時は「全て」表示のまま一括取得（ジャンル空欄）
    const ps = await getProducts(page);
    return ps.map((p) => ({ ...p, category: '' }));
  }
  const rows = [];
  for (const tab of tabs) {
    if (abortFlag) break;
    await page.goto(BASE_URL + tab.href, { waitUntil: 'domcontentloaded' });
    state.pagesDone++;
    const ps = await getProducts(page);
    rows.push(...ps.map((p) => ({ ...p, category: tab.name })));
    await sleep(conf.tabDelayMs);
  }
  return rows;
}

// ---- CSV / 区分け保存 --------------------------------------------------------
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function makeStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

const CSV_COLS = ['取得日時', 'メーカー', '車種名', 'ジャンル', '品番', '品名', '商品メーカー', '税抜価格', '価格テキスト'];

function rowsToCsv(rows) {
  const lines = [CSV_COLS.join(',')];
  for (const r of rows) {
    lines.push([r.obtainedAt, r.maker, r.carName, r.category, r.hinban, r.hinmei, r.prodMaker, r.price, r.priceText]
      .map(csvEscape).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

/** 全件CSV＋メーカー別CSVに区分けして保存 */
function writeCsv(rows, stamp) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `mitsucal_全車種商品_${stamp}.csv`);
  fs.writeFileSync(file, rowsToCsv(rows), 'utf8');

  const byMakerDir = path.join(OUTPUT_DIR, 'メーカー別', stamp);
  fs.mkdirSync(byMakerDir, { recursive: true });
  const groups = new Map();
  for (const r of rows) {
    const k = r.maker || '不明';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [maker, rs] of groups) {
    const safe = maker.replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(path.join(byMakerDir, `${safe}.csv`), rowsToCsv(rs), 'utf8');
  }
  return file;
}

// ---- 保管庫（スナップショット・差分）------------------------------------------
// 商品の同一性キー: メーカー＋車種＋品番（品番が無い時は品名）
function rowKey(r) {
  return `${r.maker}|${r.carName}|${r.hinban || r.hinmei}`;
}

function writeSnapshot(rows, stamp) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const slim = rows.map((r) => ({
    maker: r.maker, carName: r.carName, category: r.category || '', hinban: r.hinban,
    hinmei: r.hinmei, prodMaker: r.prodMaker, price: r.price,
  }));
  fs.writeFileSync(path.join(ARCHIVE_DIR, `${stamp}.json`),
    JSON.stringify({ stamp, savedAt: new Date().toISOString(), rows: slim }), 'utf8');
}

function listSnapshots() {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  return fs.readdirSync(ARCHIVE_DIR)
    .filter((f) => /^\d{8}_\d{4}\.json$/.test(f))
    .sort()
    .map((f) => f.replace(/\.json$/, ''));
}

function loadSnapshot(stamp) {
  const j = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, `${stamp}.json`), 'utf8'));
  return j.rows || [];
}

function stampLabel(stamp) {
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})$/);
  return m ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}` : stamp;
}

function diffSnapshots(oldRows, newRows) {
  const oldMap = new Map(oldRows.map((r) => [rowKey(r), r]));
  const newMap = new Map(newRows.map((r) => [rowKey(r), r]));
  const changed = [], added = [], removed = [];
  for (const [k, nr] of newMap) {
    const or = oldMap.get(k);
    if (!or) { added.push(nr); continue; }
    if (or.price !== nr.price) changed.push({ ...nr, oldPrice: or.price, newPrice: nr.price });
  }
  for (const [k, or] of oldMap) {
    if (!newMap.has(k)) removed.push(or);
  }
  return { changed, added, removed };
}

function latestDiff() {
  const snaps = listSnapshots();
  if (snaps.length < 2) return { snapshots: snaps.map(stampLabel), diff: null };
  const prev = snaps[snaps.length - 2], latest = snaps[snaps.length - 1];
  const d = diffSnapshots(loadSnapshot(prev), loadSnapshot(latest));
  const view = (r) => ({
    maker: r.maker, carName: r.carName, category: r.category || '', hinban: r.hinban, name: r.hinmei,
    brand: r.prodMaker, price: r.price, oldPrice: r.oldPrice, newPrice: r.newPrice,
    diff: (typeof r.oldPrice === 'number' && typeof r.newPrice === 'number') ? r.newPrice - r.oldPrice : '',
  });
  return {
    snapshots: snaps.map(stampLabel),
    prev: stampLabel(prev), latest: stampLabel(latest),
    diff: { changed: d.changed.map(view), added: d.added.map(view), removed: d.removed.map(view) },
  };
}

// ---- 本体 --------------------------------------------------------------------
async function runCrawl(opts = {}) {
  if (state.running) throw new Error('すでに実行中やで');
  const conf = { ...DEFAULTS, ...opts };
  abortFlag = false;
  state.log.length = 0; // 前回実行分のログはここでリセット（画面に残りっぱなしにしない）
  state.running = true;
  state.phase = 'crawling';
  state.pagesDone = 0;
  state.makersTotal = 0;
  state.makersDone = 0;
  state.carsTotal = 0;
  state.carsDone = 0;
  state.currentCar = '';
  state.itemsFound = 0;
  state.warnings = 0;
  state.failedCars = [];
  state.csvPath = '';
  state.lastError = '';

  const stamp = makeStamp();
  const obtainedAt = new Date().toLocaleString('ja-JP');
  const allRows = [];
  let page = null;

  const creds = loadEnv();
  try {
    if (!creds.ok) {
      throw new Error('.env に MITSUCAL_USERNAME / MITSUCAL_PASSWORD を設定してな（env_template.txt をコピーして作れるで）');
    }
    page = await getPage();
    await login(page, creds);

    // メーカー一覧 → 各メーカーの車種一覧を先に全部集める（進捗の分母確定）
    const makers = await getMakers(page);
    state.makersTotal = makers.length;
    log(`メーカー ${makers.length} 件見つけたで。車種一覧を集めるわ…`);

    const jobs = []; // { maker, makerHref, carName, carValue }
    for (const mk of makers) {
      if (abortFlag) break;
      await page.goto(BASE_URL + mk.href, { waitUntil: 'domcontentloaded' });
      state.pagesDone++;
      await page.waitForSelector('.carBox li', { state: 'attached', timeout: ELEM_TIMEOUT });
      const makerCode = (mk.href.match(/\/(\d+)\/?$/) || [])[1] || '';
      const cars = await getCars(page, makerCode);
      log(`  ${mk.name}: 車種 ${cars.length} 件`);
      for (const car of cars) {
        jobs.push({ maker: mk.name, makerHref: mk.href, carName: car.name, carValue: car.value });
      }
      await sleep(conf.delayMs);
    }

    let pending = conf.maxCars > 0 ? jobs.slice(0, conf.maxCars) : jobs;
    state.carsTotal = pending.length;
    log(`車種 合計 ${state.carsTotal} 件${conf.maxCars ? '（テストなので先頭だけ）' : ''}。ほな商品を取りに行くで🚀`);

    // 失敗した車種は最後に最大2周だけ自動再試行
    const failedFinal = [];
    const doneMakers = new Set();
    for (let pass = 1; pass <= 3 && pending.length && !abortFlag; pass++) {
      if (pass > 1) log(`↻ 取りこぼした ${pending.length}車種 を再試行するで（${pass - 1}回目）`);
      const failsThisPass = [];
      for (const job of pending) {
        if (abortFlag) { log('中断リクエストを受けたから止めるで'); break; }
        state.currentCar = `${job.maker} ${job.carName}`;
        try {
          await openProductsPage(page, job.makerHref, job.carValue);
          const products = await fetchProductsForCar(page, conf);
          for (const prod of products) {
            const { price, priceText } = extractPrice(prod.price);
            allRows.push({
              obtainedAt, maker: job.maker, carName: job.carName, category: prod.category,
              hinban: prod.hinban, hinmei: prod.hinmei, prodMaker: prod.maker,
              price, priceText,
            });
          }
          state.itemsFound = allRows.length;
        } catch (e) {
          log(`  ⚠ ${job.maker} ${job.carName}: ${e.message.split('\n')[0]}`);
          state.warnings++;
          failsThisPass.push(job);
          // ブラウザごと死んでたら開き直してログインし直す
          if (!browser || !browser.isConnected() || page.isClosed()) {
            try {
              page = await getPage();
              await login(page, creds);
              log('  ↻ ブラウザを開き直して続行するで');
            } catch (e2) {
              throw new Error(`復旧できへんかった: ${e2.message}`);
            }
          }
        }
        if (pass === 1) {
          state.carsDone++;
          if (state.carsDone % 5 === 0) {
            log(`進捗: 車種 ${state.carsDone}/${state.carsTotal} ／ 商品行 ${allRows.length} 件`);
          }
          if (!doneMakers.has(job.maker)) { doneMakers.add(job.maker); state.makersDone = doneMakers.size; }
          // 途中結果の自動保存（25車種ごと）
          if (state.carsDone % 25 === 0 && allRows.length) {
            state.csvPath = writeCsv(allRows, stamp);
          }
        }
        await sleep(conf.delayMs);
      }
      pending = failsThisPass;
    }
    failedFinal.push(...pending);

    state.csvPath = writeCsv(allRows, stamp);
    state.phase = 'done';
    state.failedCars = failedFinal.map((j) => `${j.maker} ${j.carName}`);

    if (failedFinal.length) {
      log(`⚠️ 再試行してもアカンかった車種 ${failedFinal.length}件はこれや：`);
      for (const j of failedFinal.slice(0, 30)) log(`   ・${j.maker} ${j.carName}`);
      if (failedFinal.length > 30) log(`   …ほか ${failedFinal.length - 30}件`);
    }

    if (abortFlag) {
      log(`⏹ 中断したで。処理済み ${state.carsDone}/${state.carsTotal} 車種 ／ 商品行${allRows.length}件 → ${state.csvPath}`);
      return { aborted: true, rows: allRows.length, csv: state.csvPath };
    }

    const okCars = state.carsTotal - failedFinal.length;
    log(`✅ 完了！ 車種 ${okCars}/${state.carsTotal} 件成功 ／ 商品行${allRows.length}件 → ${state.csvPath}`);
    log(`📂 メーカー別CSVも output/メーカー別/${stamp}/ に区分け保存したで`);

    // 保管庫への保存（完走した本番クロールだけ）
    if (!conf.maxCars && failedFinal.length === 0) {
      writeSnapshot(allRows, stamp);
      const snaps = listSnapshots();
      log(`📦 保管庫に保存したで（${stampLabel(stamp)}）。保管庫は全部で${snaps.length}回分や`);
      if (snaps.length >= 2) {
        const d = latestDiff().diff;
        const up = d.changed.filter((r) => r.diff > 0).length;
        const down = d.changed.filter((r) => r.diff < 0).length;
        log(`🔍 前回との差分: 値上げ${up}件・値下げ${down}件・新規${d.added.length}件・削除${d.removed.length}件`);
      }
    } else if (failedFinal.length) {
      log('📦 取りこぼしがあったから、今回は保管庫（差分比較用）には保存せんかったで');
    }
    return { cars: okCars, failed: failedFinal.length, rows: allRows.length, csv: state.csvPath };
  } catch (e) {
    if (allRows.length) {
      try { state.csvPath = writeCsv(allRows, stamp); log(`💾 途中結果を保存: ${allRows.length}件 → ${state.csvPath}`); } catch (_) {}
    }
    state.lastError = e.message;
    state.phase = 'error';
    log('⚠️ ' + e.message);
    throw e;
  } finally {
    state.running = false;
    state.currentCar = '';
    if (page) await page.context().close().catch(() => {});
    await closeBrowser();
  }
}

function requestAbort() { abortFlag = true; }

loadEnv(); // 起動時に envReady を反映

module.exports = {
  state, checkLogin, runCrawl, requestAbort, closeBrowser, loadEnv,
  OUTPUT_DIR, ARCHIVE_DIR,
  rowKey, writeSnapshot, listSnapshots, loadSnapshot, stampLabel, diffSnapshots, latestDiff,
};
