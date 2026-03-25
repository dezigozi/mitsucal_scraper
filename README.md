# mitsucal_scraper

みつかる君向けスクレイピングツール。**ツールの使い方の詳細は [README.txt](README.txt) を参照**してください。

---

## 依頼・リポジトリ（Git プッシュ作業）

- **GitHub:** [https://github.com/dezigozi/mitsucal_scraper.git](https://github.com/dezigozi/mitsucal_scraper.git)
- **プッシュ対象（ローカル）:**  
  `E:\Dropbox\会社\仕事\マイドキュメント\Ｍ／G\生産性向上(働き方改革)\AI\●仕事\mitsucal_scraper`

上記リポジトリに、上記フォルダの内容をプッシュする作業を実施しました。

## 作業が完了しました

### 結果

[dezigozi/mitsucal_scraper](https://github.com/dezigozi/mitsucal_scraper) の **`main`** ブランチへ、`mitsucal_scraper` フォルダの内容をプッシュ済みです。

### 含めたもの（代表）

- `mitsucal_scraper.py`、`requirements.txt`、`run.sh`
- `env_template.txt`、`README.txt`
- `mitsucal_prices.csv`、`scraper.log`、`ログ_20260217.rtf`
- デバッグ用 PNG（`debug_*.png`）
- `.gitignore`（リポジトリ用）

### あえてプッシュしていないもの（`.gitignore`）

| 除外 | 理由 |
|------|------|
| `venv/` / `.venv/` | 環境依存・容量が大きい。`pip install -r requirements.txt` で再構築 |
| `.env` | ログイン情報が入るため。リポジトリに載せないのが安全です |

別 PC では `env_template.txt` を `.env` にコピーし、値を入れてから実行してください。

### クローン後

```bash
git clone https://github.com/dezigozi/mitsucal_scraper.git
cd mitsucal_scraper
python -m venv venv
# Windows: venv\Scripts\activate
# macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
# env_template.txt を .env にコピーして編集
```

GitHub の 100MB 制限や LFS は不要なサイズで、通常の `git push` で問題なく通っています。
