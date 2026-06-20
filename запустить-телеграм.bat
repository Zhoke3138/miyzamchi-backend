@echo off
chcp 65001 >nul
title Мыйзамчы — Claude Code + Telegram
cd /d "C:\Users\Professional\Desktop\ИИ"

:: Папка с токеном и состоянием бота
set TELEGRAM_STATE_DIR=C:\Users\Professional\Desktop\ИИ\.telegram-state

:: Проверяем что токен уже вставлен
findstr /c:"ВСТАВЬ_ТОКЕН_СЮДА" ".telegram-state\.env" >nul 2>&1
if %errorlevel%==0 (
    echo.
    echo  ╔═══════════════════════════════════════════════════╗
    echo  ║  СТОП! Токен бота ещё не настроен.               ║
    echo  ║                                                   ║
    echo  ║  Открой файл:                                     ║
    echo  ║  .telegram-state\.env                             ║
    echo  ║                                                   ║
    echo  ║  И замени ВСТАВЬ_ТОКЕН_СЮДА на реальный токен    ║
    echo  ║  от @BotFather в Telegram.                        ║
    echo  ╚═══════════════════════════════════════════════════╝
    echo.
    pause
    exit /b 1
)

echo.
echo  ╔═══════════════════════════════════════════════════╗
echo  ║   Мыйзамчы: запуск Claude Code + Telegram        ║
echo  ╚═══════════════════════════════════════════════════╝
echo.
echo  Telegram-плагин активен.
echo  Напиши боту в Telegram — он пришлёт код паринга.
echo  Введи код здесь когда Claude его попросит.
echo.
echo  Нажми Ctrl+C чтобы остановить сессию.
echo.

claude
