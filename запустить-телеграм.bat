@echo off
chcp 65001 >nul
title Miyzamchi Telegram Bot

set TELEGRAM_STATE_DIR=%USERPROFILE%\.claude\channels\telegram
set BOT_TOKEN_FILE=%USERPROFILE%\.claude\channels\telegram\.env

:: Copy token from project folder to state dir
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

set PLUGIN_DIR=%USERPROFILE%\.claude\plugins\cache\claude-plugins-official\telegram\0.0.6

echo.
echo  [Telegram Bot] Starting bot server...
echo  Bot: @miyzamchi_work_bot
echo  1. Write any message to the bot in Telegram.
echo  2. Bot replies with: /telegram:access pair XXXXXX
echo  3. Type that command in VS Code Claude Code chat.
echo.
echo  Keep this window open while you work. Ctrl+C to stop.
echo.

:: IMPORTANT: --shell=bun is required so that "&&" in the start script works on Windows
"%USERPROFILE%\.bun\bin\bun.exe" run --cwd "%PLUGIN_DIR%" --shell=bun start
