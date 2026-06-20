@echo off
chcp 65001 >nul
title Miyzamchi Claude Code + Telegram

:: Add npm to PATH so 'claude' command is found (needed when launched by double-click)
set PATH=%USERPROFILE%\AppData\Roaming\npm;%USERPROFILE%\.bun\bin;%PATH%

:: Ensure token is in the default state dir
set BOT_TOKEN_FILE=%USERPROFILE%\.claude\channels\telegram\.env
set SRC_ENV=%~dp0.telegram-state\.env
if not exist "%USERPROFILE%\.claude\channels\telegram" mkdir "%USERPROFILE%\.claude\channels\telegram"
copy /Y "%SRC_ENV%" "%BOT_TOKEN_FILE%" >nul 2>&1

:: Check token
findstr /r "ВСТАВЬ" "%BOT_TOKEN_FILE%" >nul 2>&1
if %errorlevel%==0 (
    echo ERROR: Token not set. Open .telegram-state\.env and paste your BotFather token.
    pause
    exit /b 1
)

echo.
echo  Claude Code + Telegram starting...
echo  Leave this window open when you leave the office.
echo.

:: Run claude CLI - it auto-loads telegram plugin as MCP subprocess
"%USERPROFILE%\AppData\Roaming\npm\claude.cmd"

echo.
echo  Session ended. Press any key to close.
pause
