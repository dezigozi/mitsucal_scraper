/**
 * 取得結果を Dropbox の共有フォルダへ書き出す
 * ------------------------------------------------------
 *   {BASE}/{年}/スクレイピング/{YYYYMMDD}/
 *     mitsucal_全車種商品_{stamp}.csv
 *     メーカー別/{メーカー}.csv
 *     mitsucal_価格履歴_{stamp}.xlsx
 *     全ジャンル価格比較_{stamp}.csv   … Eマエカワとの比較（e-maekawa_search の output がある時だけ）
 *
 * BASE は .env の MITSUCAL_EXPORT_BASE で上書きできる（テストや Windows 用）。
 * BASE フォルダ自体が無い端末では何もせずスキップする（Dropbox の根っこを勝手に作らない）。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = '/Users/dezigozigmail.com/Dropbox/会社/仕事/マイドキュメント/Ｍ／G/架装品/みつかる君';

function exportBase() {
  return process.env.MITSUCAL_EXPORT_BASE || DEFAULT_BASE;
}

/** stamp = YYYYMMDD_HHMM（crawler の makeStamp） */
function exportDirFor(stamp) {
  return path.join(exportBase(), stamp.slice(0, 4), 'スクレイピング', stamp.slice(0, 8));
}

/**
 * @param {{stamp:string, csvPath:string, byMakerDir:string, log:(m:string)=>void}} p
 * @returns {Promise<string>} 書き出したフォルダ（スキップ時は ''）
 */
async function exportRun({ stamp, csvPath, byMakerDir, log }) {
  const base = exportBase();
  if (!fs.existsSync(base)) {
    log(`📁 書き出し先 ${base} が無いから、Dropbox への保存はスキップしたで`);
    return '';
  }
  const dir = exportDirFor(stamp);
  fs.mkdirSync(path.join(dir, 'メーカー別'), { recursive: true });

  fs.copyFileSync(csvPath, path.join(dir, path.basename(csvPath)));
  for (const f of fs.readdirSync(byMakerDir)) {
    fs.copyFileSync(path.join(byMakerDir, f), path.join(dir, 'メーカー別', f));
  }

  // history_excel / compare は crawler を require するので、循環を避けてここで読む
  const historyExcel = require('./history_excel');
  const compareMod = require('./compare');
  const problems = [];
  try {
    const xlsx = historyExcel.makeExcelPath();
    await historyExcel.buildHistoryWorkbook(xlsx);
    fs.copyFileSync(xlsx, path.join(dir, path.basename(xlsx)));
  } catch (e) {
    problems.push(`価格履歴Excel: ${e.message}`);
  }
  try {
    const cmp = compareMod.makeCsvPath('all');
    fs.writeFileSync(cmp, compareMod.toCsvAll());
    fs.copyFileSync(cmp, path.join(dir, path.basename(cmp)));
  } catch (e) {
    problems.push(`Eマエカワ比較CSV: ${e.message}`);
  }
  for (const p of problems) log(`⚠ Dropbox 書き出しで作れへんかったもの → ${p}`);
  log(`📁 Dropbox に保存したで → ${dir}`);
  return dir;
}

module.exports = { exportRun, exportDirFor, exportBase };
