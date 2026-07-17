/**
 * みつかる君 × Eマエカワ 価格比較モジュール
 * -----------------------------------------
 * 両プロジェクトの output/ から最新の「全車種商品CSV」を自動で拾い、
 * 車種名を正規化＋エイリアス辞書で紐づけて比較する。
 *
 * サーバーからは compare(genreKey) を呼ぶ。CLIでも使える:
 *   node compare.js          → マット比較
 *   node compare.js visor    → バイザー比較
 *
 * 注意: Eマエカワの金額はサイト表示のまま（税表記なし）。みつかる君は税抜。
 */
const fs = require('fs');
const path = require('path');

const MITSUCAL_DIR = path.join(__dirname, 'output');
// リポジトリは同じ親フォルダに並んでいる前提（Mac: ~/git/、Windows: E:\git\）
const EMAEKAWA_DIR = path.join(__dirname, '..', 'e-maekawa_search', 'output');

// 比較ジャンル: みつかる君の「ジャンル」⇔ Eマエカワの「商品カテゴリ」の対応
// mode: 'car' = 車種名で紐づけ / 'hinban' = 品番で紐づけ（ナビ等の汎用品向け）
const GENRES = {
  mat: { label: 'フロアマット', mode: 'car', mit: 'フロアマット', emk: 'マット' },
  visor: { label: 'サイドバイザー', mode: 'car', mit: 'サイドバイザー', emk: 'バイザー' },
  navi: { label: 'ナビ（品番比較）', mode: 'hinban', mit: 'ナビ/DA', emk: 'ナビゲーション' },
};

// 相当品番（世代違い）: みつかる君の品番 → Eマエカワの品番
// 同一品番が存在しないときだけ使い、結果には「≒(相当)」と明示する
// ※2026-07時点: みつかる君=新世代(D213/D413/D613)、Eマエカワ=旧世代(D212/D412/D612)で完全一致ゼロのため
const EQUIV_HINBAN = {
  'MDR-D213': ['MDR-D212M', 'MDR-D212WM'],
  'MDV-D413': ['MDV-D412'],
  'MDV-D613': ['MDV-D612'],
};

// みつかる君キー → Eマエカワキー（正規化後どうしても残る表記ゆれの辞書）
// 値が複数なら 1対多（例: NV200バネット → バン/ワゴン両方と比較）
const ALIASES = {
  'AURA': ['オーラ'],
  'KICKS': ['キックス'],
  'ROOX': ['ルークス'],
  'マツダ2': ['MAZDA2'],
  'マツダ3セダン': ['MAZDA3'],
  'マツダ3ファストバック': ['MAZDA3'],
  'CX30': ['MAZDACX30'],
  'クリッパーEV': ['クリッパーバンEV'],
  'NV200バネット': ['NV200バネットバン', 'NV200バネットワゴン'],
};

/** 車種名を突き合わせ用キーに正規化する */
function normName(name) {
  let s = String(name).normalize('NFKC');
  s = s.replace(/\([^)]*\)|（[^）]*）/g, ''); // 括弧サフィックス（スピーカー有無・ナビSP等）を除去
  s = s.replace(/[■●\s・\-]/g, '');
  s = s.replace(/ィ/g, 'イ'); // キャリィ/エブリィ/ブローニィ の表記ゆれ吸収
  s = s.replace(/^旧型/, '').replace(/福祉車両.*$/, '');
  return s.toUpperCase();
}

/** 引用符対応の素朴なCSVパーサ → 行ごとの配列 */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** CSV → オブジェクト配列（1行目をヘッダーとして使う） */
function readCsvObjects(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] ?? ''; });
    return o;
  });
}

/** パターンに合う最新ファイルを返す（無ければ null） */
function latestFile(dir, prefix) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.csv')).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

/** norm名 -> { maker, names:Set, items:Map("品名|価格" -> {name, price}) } に集計 */
function collect(records, { nameCol, itemCol, priceCol, makerCol, filter }) {
  const data = new Map();
  for (const r of records) {
    if (!filter(r)) continue;
    const price = parseInt(String(r[priceCol]).replace(/,/g, ''), 10);
    if (!(price > 0)) continue;
    const key = normName(r[nameCol]);
    if (!data.has(key)) data.set(key, { maker: '', names: new Set(), items: new Map() });
    const d = data.get(key);
    d.maker = String(r[makerCol]).normalize('NFKC');
    d.names.add(r[nameCol]);
    d.items.set(`${r[itemCol]}|${price}`, { name: r[itemCol], price });
  }
  return data;
}

const itemsArr = (d) => [...d.items.values()].sort((a, b) => a.price - b.price);
const minPrice = (d) => Math.min(...[...d.items.values()].map((i) => i.price));

/**
 * 比較本体。
 * @returns {{ok:boolean, genre:string, mode:string, mitCsv:string, emkCsv:string, rows:Array, stats:Object}}
 */
function compare(genreKey = 'mat') {
  const genre = GENRES[genreKey];
  if (!genre) throw new Error(`知らんジャンルや: ${genreKey}`);

  const mitCsv = latestFile(MITSUCAL_DIR, 'mitsucal_全車種商品_');
  const emkCsv = latestFile(EMAEKAWA_DIR, 'e-maekawa_全車種商品_');
  if (!mitCsv) throw new Error('みつかる君のCSVがまだ無いで（②スタートで取得してな）');
  if (!emkCsv) throw new Error(`Eマエカワ側のCSVが見つからへん（${EMAEKAWA_DIR} を確認してな）`);

  const mitRecords = readCsvObjects(mitCsv);
  const emkRecords = readCsvObjects(emkCsv);
  const rows = genre.mode === 'hinban'
    ? hinbanRows(genre, mitRecords, emkRecords)
    : carRows(genre, mitRecords, emkRecords);

  const stats = {
    matched: rows.filter((r) => r.match.startsWith('○') || r.match.startsWith('≒')).length,
    mitOnly: rows.filter((r) => r.match === 'みつかる君のみ').length,
    emkOnly: rows.filter((r) => r.match === 'Eマエカワのみ').length,
    diffCount: rows.filter((r) => r.diff !== null && r.diff !== 0).length,
  };
  return {
    ok: true, genre: genreKey, genreLabel: genre.label, mode: genre.mode,
    mitCsv: path.basename(mitCsv), emkCsv: path.basename(emkCsv),
    rows, stats,
  };
}

/** 車種名で紐づける比較（マット・バイザー等の車種別商品向け） */
function carRows(genre, mitRecords, emkRecords) {
  const mit = collect(mitRecords, {
    nameCol: '車種名', itemCol: '品名', priceCol: '税抜価格', makerCol: 'メーカー',
    filter: (r) => r['ジャンル'] === genre.mit && r['品名'] !== '案内文',
  });
  const emk = collect(emkRecords, {
    nameCol: '車名', itemCol: '商品名', priceCol: '金額', makerCol: 'メーカー',
    filter: (r) => r['商品カテゴリ'] === genre.emk,
  });

  const rows = [];
  const usedEmk = new Set();

  for (const key of [...mit.keys()].sort()) {
    const m = mit.get(key);
    const targets = ALIASES[key] || [key];
    const hits = targets.filter((t) => emk.has(t));
    if (hits.length) {
      for (const t of hits) {
        usedEmk.add(t);
        const e = emk.get(t);
        rows.push({
          match: key === t ? '○' : '○(辞書)',
          maker: m.maker,
          mitNames: [...m.names].sort().join(' / '),
          emkNames: [...e.names].sort().join(' / '),
          mitItems: itemsArr(m), emkItems: itemsArr(e),
          mitMin: minPrice(m), emkMin: minPrice(e),
          diff: minPrice(m) - minPrice(e),
        });
      }
    } else {
      rows.push({
        match: 'みつかる君のみ', maker: m.maker,
        mitNames: [...m.names].sort().join(' / '), emkNames: '',
        mitItems: itemsArr(m), emkItems: [],
        mitMin: minPrice(m), emkMin: null, diff: null,
      });
    }
  }

  for (const key of [...emk.keys()].sort()) {
    if (usedEmk.has(key)) continue;
    const e = emk.get(key);
    rows.push({
      match: 'Eマエカワのみ', maker: e.maker,
      mitNames: '', emkNames: [...e.names].sort().join(' / '),
      mitItems: [], emkItems: itemsArr(e),
      mitMin: null, emkMin: minPrice(e), diff: null,
    });
  }

  sortRows(rows);
  return rows;
}

/** マッチ行 → みつかる君のみ → Eマエカワのみ の順に並べる */
function sortRows(rows) {
  const order = { '○': 0, '○(辞書)': 0, '≒(相当品番)': 0, 'みつかる君のみ': 1, 'Eマエカワのみ': 2 };
  rows.sort((a, b) => (order[a.match] - order[b.match])
    || a.maker.localeCompare(b.maker, 'ja')
    || (a.mitNames || a.emkNames).localeCompare(b.mitNames || b.emkNames, 'ja'));
}

/**
 * 品番で紐づける比較（ナビ等の汎用品向け）。
 * みつかる君は「品番」列、Eマエカワは商品名の先頭トークンを品番として抽出する。
 * Eマエカワは同じ品番でも車種ごとに価格が違う（取付キット込みと思われる）ため、
 * 価格ごとに「どの車種の価格か」を持たせる。
 */
function hinbanRows(genre, mitRecords, emkRecords) {
  // 品番 -> { maker, prices: Map(price -> {prod, cars:Set}) }
  const collectH = (records, { hinbanFn, prodFn, priceCol, makerCol, carCol, filter }) => {
    const data = new Map();
    for (const r of records) {
      if (!filter(r)) continue;
      const price = parseInt(String(r[priceCol]).replace(/,/g, ''), 10);
      const hinban = hinbanFn(r);
      if (!(price > 0) || !hinban) continue;
      if (!data.has(hinban)) data.set(hinban, { maker: '', prices: new Map() });
      const d = data.get(hinban);
      d.maker = String(r[makerCol]).normalize('NFKC').replace(/[\[\]]/g, '');
      if (!d.prices.has(price)) d.prices.set(price, { prod: prodFn(r), cars: new Set() });
      d.prices.get(price).cars.add(r[carCol]);
    }
    return data;
  };

  // 価格ごとの表示用エントリ（価格が複数あるときはどの車種の価格かを付ける）
  const priceEntries = (d) => {
    const multi = d.prices.size > 1;
    return [...d.prices.entries()].sort((a, b) => a[0] - b[0]).map(([price, v]) => {
      const cars = [...v.cars];
      const carLbl = cars.slice(0, 2).join('/') + (cars.length > 2 ? ` 他${cars.length - 2}車種` : '');
      return { name: multi ? `【${carLbl}】${v.prod}` : v.prod, price };
    });
  };
  const minP = (d) => Math.min(...d.prices.keys());

  const mit = collectH(mitRecords, {
    hinbanFn: (r) => String(r['品番']).trim().toUpperCase(),
    prodFn: (r) => r['品名'],
    priceCol: '税抜価格', makerCol: '商品メーカー', carCol: '車種名',
    filter: (r) => r['ジャンル'] === genre.mit && r['品名'] !== '案内文',
  });
  const emk = collectH(emkRecords, {
    // 商品名の先頭トークン（例: "MDR-D212WM ケンウッド製…" → MDR-D212WM）を品番とする
    hinbanFn: (r) => {
      const m = String(r['商品名']).match(/^([A-Za-z0-9][A-Za-z0-9\-/]+)\s/);
      return m ? m[1].toUpperCase() : '';
    },
    prodFn: (r) => String(r['商品名']).replace(/^[A-Za-z0-9][A-Za-z0-9\-/]+\s+/, ''),
    priceCol: '金額', makerCol: 'ブランド', carCol: '車名',
    filter: (r) => r['商品カテゴリ'] === genre.emk,
  });

  const rows = [];
  const usedEmk = new Set();

  for (const key of [...mit.keys()].sort()) {
    const m = mit.get(key);
    // 同一品番を最優先、無ければ相当品番（世代違い）
    const exact = emk.has(key);
    const targets = exact ? [key] : (EQUIV_HINBAN[key] || []).filter((t) => emk.has(t));
    if (targets.length) {
      for (const t of targets) {
        usedEmk.add(t);
        const e = emk.get(t);
        rows.push({
          match: exact ? '○' : '≒(相当品番)',
          maker: m.maker !== '未登録' ? m.maker : e.maker,
          mitNames: key, emkNames: t,
          mitItems: priceEntries(m), emkItems: priceEntries(e),
          mitMin: minP(m), emkMin: minP(e), diff: minP(m) - minP(e),
        });
      }
    } else {
      rows.push({
        match: 'みつかる君のみ', maker: m.maker === '未登録' ? '' : m.maker,
        mitNames: key, emkNames: '',
        mitItems: priceEntries(m), emkItems: [],
        mitMin: minP(m), emkMin: null, diff: null,
      });
    }
  }

  for (const key of [...emk.keys()].sort()) {
    if (usedEmk.has(key)) continue;
    const e = emk.get(key);
    rows.push({
      match: 'Eマエカワのみ', maker: e.maker,
      mitNames: '', emkNames: key,
      mitItems: [], emkItems: priceEntries(e),
      mitMin: null, emkMin: minP(e), diff: null,
    });
  }

  sortRows(rows);
  return rows;
}

const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const fmtItems = (items) => items.map((i) => `${i.name} ¥${i.price.toLocaleString()}`).join(' / ');

/** 比較結果 → CSVテキスト（Excel用にBOMを付けて返す） */
function toCsv(result) {
  const header = result.mode === 'hinban'
    ? ['マッチ', 'ブランド', '品番_みつかる君', '品番_Eマエカワ',
      'みつかる君_商品(税抜)', 'Eマエカワ_商品(車種別)', 'みつかる君_最安', 'Eマエカワ_最安', '最安差額(み-E)']
    : ['マッチ', 'メーカー', '車種_みつかる君', '車種_Eマエカワ',
      'みつかる君_商品(税抜)', 'Eマエカワ_商品', 'みつかる君_最安', 'Eマエカワ_最安', '最安差額(み-E)'];
  const lines = [header.join(',')];
  for (const r of result.rows) {
    lines.push([r.match, r.maker, r.mitNames, r.emkNames,
      fmtItems(r.mitItems), fmtItems(r.emkItems),
      r.mitMin ?? '', r.emkMin ?? '', r.diff ?? ''].map(esc).join(','));
  }
  return '﻿' + lines.join('\n') + '\n';
}

/** 全ジャンルの比較結果 → ジャンル列付きの1本のCSVテキスト */
function toCsvAll() {
  const header = ['ジャンル', 'マッチ', 'メーカー/ブランド', '車種・品番_みつかる君', '車種・品番_Eマエカワ',
    'みつかる君_商品(税抜)', 'Eマエカワ_商品', 'みつかる君_最安', 'Eマエカワ_最安', '最安差額(み-E)'];
  const lines = [header.join(',')];
  for (const genreKey of Object.keys(GENRES)) {
    const result = compare(genreKey);
    for (const r of result.rows) {
      lines.push([result.genreLabel, r.match, r.maker, r.mitNames, r.emkNames,
        fmtItems(r.mitItems), fmtItems(r.emkItems),
        r.mitMin ?? '', r.emkMin ?? '', r.diff ?? ''].map(esc).join(','));
    }
  }
  return '﻿' + lines.join('\n') + '\n';
}

function makeCsvPath(genreKey) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const label = genreKey === 'all' ? '全ジャンル' : GENRES[genreKey].label;
  return path.join(MITSUCAL_DIR, `${label}価格比較_${stamp}.csv`);
}

module.exports = { compare, toCsv, toCsvAll, makeCsvPath, GENRES };

// ---- CLI ----
if (require.main === module) {
  const genreKey = process.argv[2] || 'mat';
  if (genreKey === 'all') {
    const out = makeCsvPath('all');
    fs.writeFileSync(out, toCsvAll());
    console.log(`全ジャンル（${Object.values(GENRES).map((g) => g.label).join('・')}）まとめCSVを出力: ${out}`);
  } else {
    const result = compare(genreKey);
    console.log(`みつかる君: ${result.mitCsv}`);
    console.log(`Eマエカワ : ${result.emkCsv}`);
    const s = result.stats;
    console.log(`【${result.genreLabel}】紐づけ成功: ${s.matched}行 / みつかる君のみ: ${s.mitOnly} / Eマエカワのみ: ${s.emkOnly} / 価格差あり: ${s.diffCount}`);
    const out = makeCsvPath(genreKey);
    fs.writeFileSync(out, toCsv(result));
    console.log(`出力: ${out}`);
  }
}
