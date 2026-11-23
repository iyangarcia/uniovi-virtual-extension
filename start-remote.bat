@echo off
rem Uniovi Virtual: connector for ChatGPT / Gemini / claude.ai (web).
rem Keep this window open while you use it. Close it to disconnect.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js no esta instalado: https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm install
if not exist server\dist\index.js call npm run build
node server\dist\index.js --remote %*
pause
