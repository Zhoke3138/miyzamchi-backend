@echo off
chcp 65001 >nul
title Miyzamchi Claude Code + Telegram

:: Ensure token is in the default state dir (where the plugin looks by default)
set BOT_TOKEN_FILE=%USERPROFILE%\.claude\channels\telegram\.env
set SRC_ENV=%~dp0.telegram-state\.env
if not exist "%USERPROFILE%\.claude\channels\telegram" mkdir "%USERPROFILE%\.claude\channels\telegram"
copy /Y "%SRC_ENV%" "%BOT_TOKEN_FILE%" >nul 2>&1

:: Check token
findstr /r "ВСТАВЬ" "%BOT_TOKEN_FILE%" >nul 2>&1
if %errorlevel%==0 (
    echo ERROR: Open .telegram-state\.env and replace the placeholder with your BotFather token.
    pause
    exit /b 1
)

echo.
echo  Claude Code + Telegram bot starting...
echo  The bot @miyzamchi_work_bot will be ready in ~5 seconds.
echo.
echo  IMPORTANT: Leave this window open when you leave the office.
echo  Messages from Telegram will appear here and Claude will respond.
echo.

:: Run claude CLI — it auto-starts the telegram MCP plugin as subprocess
:: The plugin already has --shell=bun in its .mcp.json config
claude
