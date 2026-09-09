@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在啟動語音測試伺服器,請稍候(第一次啟動比較久)...
echo.
node server.js
pause
