@echo off
chcp 65001 >nul

:: ---- Telegram state dir (ASCII path, no Cyrillic) ----
set TELEGRAM_STATE_DIR=%USERPROFILE%\.claude\channels\telegram

:: ---- Copy token from project .telegram-state to default location ----
set SRC_ENV=%~dp0.telegram-state\.env
set DST_ENV=%USERPROFILE%\.claude\channels\telegram\.env

if not exist "%USERPROFILE%\.claude\channels\telegram" mkdir "%USERPROFILE%\.claude\channels\telegram"
copy /Y "%SRC_ENV%" "%DST_ENV%" >nul 2>&1

:: ---- Check token is set ----
findstr /c:"ВСТАВЬ_ТОКЕН_СЮДА" "%DST_ENV%" >nul 2>&1
if %errorlevel%==0 (
    echo.
    echo ERROR: Bot token not set!
    echo Open file: .telegram-state\.env
    echo Replace ВСТАВЬ_ТОКЕН_СЮДА with your BotFather token.
    echo.
    pause
    exit /b 1
)

:: ---- Launch Claude Code ----
cd /d "%~dp0"
echo.
echo [Miyzamchi] Claude Code + Telegram started.
echo Send any message to your bot in Telegram.
echo It will reply with a 6-letter pairing code.
echo Enter that code here when Claude asks.
echo.
echo Press Ctrl+C to stop.
echo.

claude
