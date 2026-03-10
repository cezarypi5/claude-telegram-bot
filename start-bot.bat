@echo off
echo Starting Claude Telegram Bot...
echo.
echo Make sure you have filled in your .env file with:
echo  - TELEGRAM_BOT_TOKEN
echo  - ANTHROPIC_API_KEY
echo.
cd /d "%~dp0"
node index.js
pause
