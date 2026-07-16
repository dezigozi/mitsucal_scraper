# CONTEXT — みつかる君 サーチくん 計画・進捗

## 目的
みつかる君（https://mitsucal.arai-denki.co.jp）の全メーカー×全車種の商品・価格を、
Eマエカワ サーチくんと同じベース構成（ダッシュボード＋区分け保存）で取得する。

## 全体設計
- アプリ = ローカルWebサーバー（server.js, **:3940**）＋ 画面（public/index.html）。
  「①ログイン確認」「②スタート」の2ボタン。※3939 は Movie Downloader が使用中なので不可
- ログインは **.env の認証情報で全自動**（Eマエカワと違い手動ログイン不要）。
  `env_template.txt` を `.env` にコピーして MITSUCAL_USERNAME / PASSWORD / COMPANY_CODE を設定。
- クロール本体 = crawler.js（Playwright/Node）。旧 Python 版（mitsucal_scraper.py）の
  セレクタ・ロジックをそのまま移植。Python 版は当面残す（レガシー）。

## サイト構造（Python版から継承）
- ログイン: `#MypageLoginId` / `#MypagePassword` / `#MypageCompanyCd` → `input[type=image]` クリック → `.topBox` 出現で成功
- メーカー一覧: `.topBox ul a`（img.alt が名前）
- 車種一覧: メーカーページの `input[name="data[Product][car_cd][]"]`（li 内 img.alt が名前）
- 商品ページ: 車種チェック→ `#ProductSelectCarsForm` submit → URL に `/products/products`
- 商品: `.products ul > li` の `span.fo14`（品番/品名/コメント内メーカー）＋ `span.fo15`（価格）
- カテゴリ巡回はリクエスト過多で失敗するため「全て」タブ一括取得（Python版の教訓）

## データの区分け保存
- `output/mitsucal_全車種商品_{stamp}.csv` … 全件（BOM付きUTF-8）
- `output/メーカー別/{stamp}/{メーカー名}.csv` … メーカーごとに区分け
- `archive/{stamp}.json` … 完走時のみ保存する保管庫（前回との差分＝値上げ/値下げ/新規/削除を画面表示）
- 25車種ごと＋エラー時に途中自動保存

## チェックリスト
- [x] Eマエカワと同じベース構成（server.js / crawler.js / public/index.html）に移植
- [x] .env 自動ログイン＋①ログイン確認ボタン
- [x] 失敗車種の自動再試行（最大2周）＋ブラウザ死亡時の自動復旧
- [x] 全件CSV＋メーカー別CSVの区分け保存
- [x] 保管庫（archive/）＋差分表示（値上げ/値下げ/新規/削除）
- [x] start.command / 起動_Windows.bat ランチャー
- [x] サーバー起動・API のスモークテスト
- [x] .env 作成（Dropbox旧フォルダから発見）＋①ログイン確認OK
- [x] テスト実行で抽出検証（メーカーフィルタ修正込み）
- [x] 全車種の本番クロール完走（163車種・8010行・2026-07-16）

## メモ
- ポート 3940。変える時は server.js の PORT と CONTEXT.md を両方直す。
- テスト実行: `curl -X POST 'localhost:3940/api/start?maxCars=2'`
