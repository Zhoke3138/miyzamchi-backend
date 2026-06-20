@echo off
chcp 65001 >nul
title Miyzamchi Claude Code + Telegram

set PATH=%USERPROFILE%\AppData\Roaming\npm;%USERPROFILE%\.bun\bin;%PATH%

set BOT_TOKEN_FILE=%USERPROFILE%\.claude\channels\telegram\.env
set SRC_ENV=%~dp0.telegram-state\.env
if not exist "%USERPROFILE%\.claude\channels\telegram" mkdir "%USERPROFILE%\.claude\channels\telegram"
copy /Y "%SRC_ENV%" "%BOT_TOKEN_FILE%" >nul 2>&1

echo.
echo  Claude Code + Telegram starting...
echo  Leave this window open when you leave the office.
echo.

"%USERPROFILE%\AppData\Roaming\npm\claude.cmd" --channels plugin:telegram@claude-plugins-official

echo.
echo  Session ended. Press any key to close.
pause