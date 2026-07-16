@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo.
echo   みつかる君 サーチくん を起動するで〜
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js が見つかりません。https://nodejs.org からインストールしてな。
  pause
  exit /b 1
)
if not exist node_modules (
  echo 初回セットアップ中… npm install
  call npm install
  call npx playwright install chromium
)
node server.js
pause
