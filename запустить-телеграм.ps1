$Host.UI.RawUI.WindowTitle = "Мыйзамчы — Claude Code + Telegram"
Set-Location "C:\Users\Professional\Desktop\ИИ"

# Папка с токеном и состоянием бота
$env:TELEGRAM_STATE_DIR = "C:\Users\Professional\Desktop\ИИ\.telegram-state"
$envFile = "$env:TELEGRAM_STATE_DIR\.env"

# Проверяем что токен уже вставлен
if (Select-String -Path $envFile -Pattern "ВСТАВЬ_ТОКЕН_СЮДА" -Quiet) {
    Write-Host ""
    Write-Host "  ╔═══════════════════════════════════════════════════╗" -ForegroundColor Red
    Write-Host "  ║  СТОП! Токен бота ещё не настроен.               ║" -ForegroundColor Red
    Write-Host "  ║                                                   ║" -ForegroundColor Red
    Write-Host "  ║  Открой файл:                                     ║" -ForegroundColor Red
    Write-Host "  ║  .telegram-state\.env                             ║" -ForegroundColor Red
    Write-Host "  ║                                                   ║" -ForegroundColor Red
    Write-Host "  ║  Замени ВСТАВЬ_ТОКЕН_СЮДА на токен от @BotFather ║" -ForegroundColor Red
    Write-Host "  ╚═══════════════════════════════════════════════════╝" -ForegroundColor Red
    Write-Host ""
    Read-Host "Нажми Enter для выхода"
    exit 1
}

Write-Host ""
Write-Host "  ╔═══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║   Мыйзамчы: запуск Claude Code + Telegram        ║" -ForegroundColor Cyan
Write-Host "  ╚═══════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Telegram-плагин активен. Напиши боту — он пришлёт" -ForegroundColor Green
Write-Host "  код паринга. Введи код когда Claude его попросит." -ForegroundColor Green
Write-Host ""
Write-Host "  Ctrl+C = остановить сессию." -ForegroundColor DarkGray
Write-Host ""

claude
