#!/bin/zsh -l
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "初回セットアップ中… npm install"
  npm install
  npx playwright install chromium
fi
node server.js
