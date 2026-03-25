#!/bin/bash
# みつかる君 スクレイパー実行スクリプト
# 仮想環境を有効化してから実行します

set -e
cd "$(dirname "$0")"
echo "作業フォルダ: $(pwd)"

if [ ! -d "venv" ]; then
  echo "エラー: venv フォルダが見つかりません。"
  echo "先に以下のコマンドで仮想環境を作成してください:"
  echo "  python3 -m venv venv"
  echo "  source venv/bin/activate"
  echo "  pip install -r requirements.txt"
  echo "  python -m playwright install chromium"
  exit 1
fi

source venv/bin/activate
echo "スクレイパーを起動しています..."
python mitsucal_scraper.py "$@"
