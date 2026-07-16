/**
 * 価格履歴Excel（.xlsx）生成
 * --------------------------------
 * 保管庫（archive/*.json）の全スナップショットを横断して、
 * 「商品1行 × 日付ごとの価格列」の履歴シートを作る。
 *
 * 色ルール:
 *   ・新規追加された商品 … 行を緑色、状態列に「新規」
 *   ・削除された商品     … 行をグレー、状態列に赤字で「削除」
 *   ・価格が変わったセル … 黄色（値上げは赤字・値下げは青字）
 */
const path = require('path');
const ExcelJS = require('exceljs');
const crawler = require('./crawler');

const FILL = {
  header: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E7E4D' } },
  added: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDF5E8' } },   // 緑
  removed: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9E9E9' } }, // グレー
  changed: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2B8' } }, // 黄
};
const FONT = {
  header: { color: { argb: 'FFFFFFFF' }, bold: true },
  removed: { color: { argb: 'FFE05563' }, bold: true },
  up: { color: { argb: 'FFC0392B' }, bold: true },   // 値上げ 赤
  down: { color: { argb: 'FF1A5FB4' }, bold: true }, // 値下げ 青
};

/** 全スナップショットから履歴ワークブックを作って file に保存 */
async function buildHistoryWorkbook(file) {
  const stamps = crawler.listSnapshots();
  if (!stamps.length) throw new Error('保管庫がまだ空やで（完走したクロールが1回も無い）');

  const snaps = stamps.map((s) => ({ stamp: s, label: crawler.stampLabel(s), rows: crawler.loadSnapshot(s) }));
  const latestStamp = stamps[stamps.length - 1];

  // 全期間の商品ユニオン（初登場順を保つ）
  const master = new Map(); // key -> { info行, prices: {stamp: price}, firstStamp, lastStamp }
  for (const snap of snaps) {
    for (const r of snap.rows) {
      const k = crawler.rowKey(r);
      let e = master.get(k);
      if (!e) {
        e = { row: r, prices: {}, firstStamp: snap.stamp, lastStamp: snap.stamp };
        master.set(k, e);
      }
      e.row = r; // 商品名・ジャンルなどは最新の表記で上書き
      e.prices[snap.stamp] = r.price;
      e.lastStamp = snap.stamp;
    }
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('価格履歴', { views: [{ state: 'frozen', xSplit: 5, ySplit: 1 }] });

  const infoCols = [
    { header: 'メーカー', key: 'maker', width: 10 },
    { header: '車種名', key: 'carName', width: 22 },
    { header: 'ジャンル', key: 'category', width: 16 },
    { header: '品番', key: 'hinban', width: 16 },
    { header: '品名', key: 'hinmei', width: 44 },
    { header: '商品メーカー', key: 'prodMaker', width: 16 },
    { header: '状態', key: 'status', width: 10 },
    { header: '最新差額', key: 'diff', width: 10 },
  ];
  ws.columns = [
    ...infoCols,
    ...snaps.map((s) => ({ header: s.label, key: 'p_' + s.stamp, width: 13 })),
  ];

  // ヘッダー装飾
  ws.getRow(1).eachCell((cell) => {
    cell.fill = FILL.header;
    cell.font = FONT.header;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  ws.getRow(1).height = 28;

  for (const [, e] of master) {
    const r = e.row;
    const isNew = e.firstStamp === latestStamp && snaps.length >= 2;
    const isRemoved = e.lastStamp !== latestStamp;

    // 最新差額（最後に価格がある2時点の差）
    const priceSeq = stamps.filter((s) => e.prices[s] !== undefined && e.prices[s] !== '');
    let diff = '';
    if (priceSeq.length >= 2) {
      const a = e.prices[priceSeq[priceSeq.length - 2]];
      const b = e.prices[priceSeq[priceSeq.length - 1]];
      if (typeof a === 'number' && typeof b === 'number' && a !== b) diff = b - a;
    }

    const status = isRemoved ? '削除' : isNew ? '新規' : (diff !== '' ? (diff > 0 ? '値上げ' : '値下げ') : '');

    const rowValues = {
      maker: r.maker, carName: r.carName, category: r.category || '',
      hinban: r.hinban, hinmei: r.hinmei, prodMaker: r.prodMaker, status, diff,
    };
    for (const s of stamps) {
      rowValues['p_' + s] = e.prices[s] !== undefined ? e.prices[s] : '';
    }
    const row = ws.addRow(rowValues);

    // 行の色（新規=緑・削除=グレー）
    if (isNew || isRemoved) {
      row.eachCell({ includeEmpty: false }, (cell) => { cell.fill = isNew ? FILL.added : FILL.removed; });
    }
    if (isRemoved) row.getCell('status').font = FONT.removed;
    if (status === '値上げ') row.getCell('diff').font = FONT.up;
    if (status === '値下げ') row.getCell('diff').font = FONT.down;

    // 価格が前の時点から変わったセルを黄色に
    for (let i = 1; i < stamps.length; i++) {
      const prev = e.prices[stamps[i - 1]];
      const cur = e.prices[stamps[i]];
      if (typeof prev === 'number' && typeof cur === 'number' && prev !== cur) {
        const cell = row.getCell('p_' + stamps[i]);
        cell.fill = FILL.changed;
        cell.font = cur > prev ? FONT.up : FONT.down;
      }
    }
  }

  // 価格列は数値の桁区切り表示
  for (const s of stamps) {
    ws.getColumn('p_' + s).numFmt = '#,##0';
  }
  ws.getColumn('diff').numFmt = '+#,##0;-#,##0;';
  ws.autoFilter = { from: 'A1', to: ws.getRow(1).getCell(ws.columnCount).address };

  await wb.xlsx.writeFile(file);
  return { file, products: master.size, snapshots: stamps.length };
}

function makeExcelPath() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return path.join(crawler.OUTPUT_DIR, `mitsucal_価格履歴_${stamp}.xlsx`);
}

module.exports = { buildHistoryWorkbook, makeExcelPath };
