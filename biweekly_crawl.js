/**
 * 2週おき自動クロール（launchd から毎週月曜朝に起動される）
 * ------------------------------------------------------
 * launchd は「2週おき」を表現できないので毎週起こし、ここで実行する週かを判定する。
 *   ・ANCHOR（2026-10-19 月）から偶数週目 → 実行
 *   ・裏の週でも、最後に完走（archive 保存）してから14日を超えていたら取り直す（前回失敗・電源OFFの救済）
 * 実行は .env の自動ログインでクローラーを直接呼ぶ（サーバー不要・画面も開かない）。
 * 完走したら crawler 側が Dropbox …/みつかる君/{年}/スクレイピング/{YYYYMMDD}/ に書き出す。
 *
 * 1回の取得は実測18分（2026-10-09: 163車種）→ 90分でタイムアウト → 中断 → 5分待って最大3回まで。
 *
 * 手動実行:    FORCE=1 node biweekly_crawl.js            （週の判定を飛ばして本番取得）
 * テスト:      TEST_MAXCARS=2 node biweekly_crawl.js      （2車種だけ・判定も飛ばす・保管庫に入らない）
 *              MITSUCAL_EXPORT_BASE=/tmp/x を付けると書き出し先を差し替えられる
 */
const { execFileSync } = require('child_process');
const http = require('http');
const crawler = require('./crawler');

const ANCHOR = new Date(2026, 9, 19); // 2026-10-19（月）＝初回
const CATCHUP_DAYS = 14;
const RUN_TIMEOUT_MS = 90 * 60 * 1000;
const ABORT_GRACE_MS = 3 * 60 * 1000;
const RETRY_WAIT_MS = 5 * 60 * 1000;
const ATTEMPTS = 3;

const FORCE = process.env.FORCE === '1';
const TEST_MAXCARS = process.env.TEST_MAXCARS ? +process.env.TEST_MAXCARS : 0;
const DAY = 24 * 60 * 60 * 1000;

const log = (m) => console.log(`[${new Date().toLocaleString('ja-JP')}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function notify(msg) {
  try {
    execFileSync('osascript', ['-e',
      `display notification ${JSON.stringify(msg)} with title "みつかる君 サーチくん" sound name "Glass"`],
    { timeout: 10000 });
  } catch (e) {
    log(`通知を出せんかった: ${e.message.split('\n')[0]}`);
  }
}

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

/** 今日が実行する週か。理由つきで返す */
function shouldRun(now) {
  const week = Math.floor((startOfDay(now) - ANCHOR) / DAY / 7);
  if (week >= 0 && week % 2 === 0) return { run: true, why: `2週おきの実行週（初回から${week}週目）` };

  const snaps = crawler.listSnapshots();
  const last = snaps[snaps.length - 1];
  if (!last) return { run: true, why: '保管庫が空やから取り直す' };
  const m = last.match(/^(\d{4})(\d{2})(\d{2})/);
  const days = Math.floor((startOfDay(now) - new Date(+m[1], +m[2] - 1, +m[3])) / DAY);
  if (days > CATCHUP_DAYS) return { run: true, why: `裏の週やけど最後の完走（${crawler.stampLabel(last)}）から${days}日たってるから取り直す` };
  return { run: false, why: `裏の週（最後の完走は${crawler.stampLabel(last)}・${days}日前）` };
}

/** アプリ画面（:3940）側で手動クロール中なら、ぶつからんようにスキップする */
function serverIsCrawling() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:3940/api/status', { timeout: 3000 }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => {
        try { resolve(!!JSON.parse(b).running); } catch (_) { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false)); // サーバー未起動＝ぶつからへん
  });
}

/** 1回分。タイムアウトしたら中断要求 → 猶予内に止まらんかったら諦めて投げる */
async function runOnce() {
  const opts = TEST_MAXCARS ? { maxCars: TEST_MAXCARS, exportTest: true } : {};
  const job = crawler.runCrawl(opts);
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('TIMEOUT')), RUN_TIMEOUT_MS); });
  try {
    return await Promise.race([job, timeout]);
  } catch (e) {
    if (e.message !== 'TIMEOUT') throw e;
    log(`⏱ ${RUN_TIMEOUT_MS / 60000}分たっても終わらんから中断するで`);
    crawler.requestAbort();
    const settled = await Promise.race([job.then(() => true, () => true), sleep(ABORT_GRACE_MS).then(() => false)]);
    if (!settled) {
      await crawler.closeBrowser();
      throw new Error('FATAL: 中断要求にも反応せえへん');
    }
    throw new Error(`${RUN_TIMEOUT_MS / 60000}分でタイムアウト`);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const now = new Date();
  const test = TEST_MAXCARS ? `（テスト: ${TEST_MAXCARS}車種だけ）` : '';
  if (!FORCE && !TEST_MAXCARS) {
    const s = shouldRun(now);
    log(`判定: ${s.why}`);
    if (!s.run) return;
  }
  log(`2週おき自動クロール開始${test}`);

  if (await serverIsCrawling()) {
    log('アプリ画面でクロール中やから今回はスキップ（次の月曜に取り直すで）');
    return;
  }

  let lastErr = null;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      const r = await runOnce();
      if (r.aborted) throw new Error('途中で中断された');

      let extra = '';
      if (!TEST_MAXCARS && !r.failed) {
        try {
          const d = crawler.latestDiff().diff;
          if (d) {
            const up = d.changed.filter((x) => x.diff > 0).length;
            const down = d.changed.filter((x) => x.diff < 0).length;
            extra = ` 差分: 値上げ${up}・値下げ${down}・新規${d.added.length}・削除${d.removed.length}`;
          }
        } catch (e) {
          log(`差分サマリを作れんかった: ${e.message}`);
        }
      }
      const where = r.exportDir ? ' Dropboxに保存済み' : ' ※Dropboxには保存できてへん（ログ見てな）';
      if (r.failed) {
        log(`完了（取りこぼし${r.failed}車種）→ ${r.exportDir || '(書き出しなし)'}`);
        notify(`自動取得完了。ただし取りこぼし${r.failed}車種あり（保管庫には入れてへん）。${where}`);
      } else {
        log(`完走！ ${r.cars}車種・${r.rows}行 → ${r.exportDir || '(書き出しなし)'}`);
        notify(`自動取得 完走したで！${test}${extra}${where}`);
      }
      return;
    } catch (e) {
      lastErr = e;
      log(`❌ ${i}/${ATTEMPTS}回目 失敗: ${e.message.split('\n')[0]}`);
      if (e.message.startsWith('FATAL')) break;
      if (i < ATTEMPTS) { log(`${RETRY_WAIT_MS / 60000}分待ってやり直すで`); await sleep(RETRY_WAIT_MS); }
    }
  }
  notify(`自動取得に失敗: ${(lastErr && lastErr.message.split('\n')[0] || '').slice(0, 70)}…次の月曜に取り直すで`);
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    log('ERR ' + e.stack);
    notify('自動取得でエラー: ' + e.message.slice(0, 70));
    process.exit(1);
  });
}

module.exports = { shouldRun };
