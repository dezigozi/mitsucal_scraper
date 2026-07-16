-- みつかる君 サーチくん ランチャー
-- ダブルクリックで（ターミナルを出さずに）サーバーを起動してブラウザを開く
set appPath to POSIX path of (path to me)
set repoDir to do shell script "dirname " & quoted form of appPath
do shell script "cd " & quoted form of repoDir & " && if /usr/bin/curl -s -m 1 http://127.0.0.1:3940/api/status >/dev/null 2>&1; then /usr/bin/open http://localhost:3940; else NODE=$(/bin/ls -d \"$HOME\"/.nvm/versions/node/*/bin/node 2>/dev/null | /usr/bin/tail -1); [ -z \"$NODE\" ] && NODE=$(command -v node); /usr/bin/nohup \"$NODE\" server.js > server.log 2>&1 & fi"
