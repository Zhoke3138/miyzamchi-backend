# Запуск бэкенда для локальной разработки с ONLYOFFICE Docker
# BACKEND_URL = host.docker.internal — позволяет DocServer (внутри Docker)
# скачивать файлы с локального Node.js сервера (порт 3000)

$env:BACKEND_URL = 'http://host.docker.internal:3000'
Write-Host "Бэкенд запускается на http://localhost:3000"
Write-Host "ONLYOFFICE callback URL: http://host.docker.internal:3000"
node server.js
