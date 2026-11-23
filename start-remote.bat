@echo off
rem Developers only: students use the installer (UnioviVirtual-Setup-*.exe), whose hidden helper does this.
rem Runs the bridge + remote MCP + a public tunnel from this checkout, for ChatGPT / Gemini / claude.ai (web).
rem Tunnel providers are tried in order: localhost.run, tunnelmole, pinggy, cloudflared (only if installed;
rem not required). Keep this window open while you use it; close it to disconnect.
rem --rotate-token makes a new secret URL (the old one stops working).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js no esta instalado: https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm install
if not exist server\dist\index.js call npm run build
node server\dist\index.js --remote %*
pause
