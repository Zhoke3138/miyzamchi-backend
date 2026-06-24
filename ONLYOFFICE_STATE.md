# ONLYOFFICE Integration — Заморожено (Freeze)

> **Статус:** ЗАМОРОЖЕНО 24.06.2026. Откладываем до версии 2.0.
> Продакшн работает на SuperDoc. ONLYOFFICE-код сохранён, не удалён.
> Чтобы вернуть — читай раздел «Как возобновить».

---

## Что было сделано

### Инфраструктура

**`docker-compose.yml`** — ONLYOFFICE Document Server 9.4.0 (Community Edition):
- Контейнер `miyzamchi-docserver`, порт `8080:80`
- JWT включён: `JWT_ENABLED=true`, секрет из `ONLYOFFICE_JWT_SECRET` в `.env`
- Плагин монтируется: `./onlyoffice-plugin/miyzamchi-ai → /var/www/.../sdkjs-plugins/miyzamchi-ai`
- Запуск: `docker-compose up -d`
- Проверка: `curl http://localhost:8080/healthcheck`

**Плагин `onlyoffice-plugin/miyzamchi-ai/`:**
- `plugin.js` — основной код плагина (запускается внутри ONLYOFFICE iframe)
- `index.html` — UI панели: вкладки Консультация / Аудит / Агент
- `config.json` — манифест плагина (статический, GUID: `asc.{f3a4b2c1-8e7d-4f6a-9b3c-2d1e5f8a7b4c}`)

**SDK плагина:** официальный CDN `https://onlyoffice.github.io/sdkjs-plugins/v1/plugins.js` + `plugins-ui.js` — инжектируется динамически в `routes/onlyoffice.js` при выдаче `index.html`.

---

### Backend: `routes/onlyoffice.js`

Все маршруты регистрируются в `server.js` через `app.use('/api', onlyofficeRouter)`.

| Маршрут | Что делает |
|---|---|
| `POST /api/files/upload` | Принимает .docx → сохраняет в `storage/documents/` → извлекает текст через mammoth → возвращает `{fileId, config}` |
| `GET /api/files/:fileId/download` | DocServer скачивает отсюда исходный .docx при открытии |
| `GET /api/files/:fileId/text` | Возвращает plain-text из DOCX (из mammoth-кеша) для ИИ-контекста |
| `GET /api/files/:fileId/config` | JWT-подписанный конфиг для инициализации `DocsAPI.DocEditor` |
| `POST /api/onlyoffice/callback/:fileId` | DocServer шлёт сюда события сохранения (status 2/6) |
| `GET /api/onlyoffice/plugin/config.json` | Динамический манифест плагина с абсолютными URL (нужен ONLYOFFICE 9.x) |
| `GET /api/onlyoffice/plugin/index.html` | Динамический HTML плагина с инжектом CDN SDK + CSP override |
| `GET /api/onlyoffice/plugin/plugin.js` | Статический JS плагина |
| `POST /api/onlyoffice/bridge/push` | Команда от App.jsx → очередь для плагина |
| `GET /api/onlyoffice/bridge/poll` | Плагин опрашивает (300ms) → получает pending команды |
| `POST /api/onlyoffice/bridge/doctext` | Плагин пушит живой текст документа каждые 8с |
| `GET /api/onlyoffice/bridge/doctext` | App.jsx читает текст перед ИИ-запросом |
| `POST /api/onlyoffice/bridge/selection` | Плагин пушит выделенный текст |
| `GET /api/onlyoffice/bridge/selection` | App.jsx читает выделение |
| `POST /api/onlyoffice/audit-docx` | Принимает `risks[]` → создаёт audit .docx через `lib/docxGenerator.js` |

**Ключевые переменные:**
```js
const DOCSERVER_BACKEND_URL = // host.docker.internal:3000 (Docker→хост)
const BROWSER_URL           = // localhost:3000 (браузер→бэк)
const OO_JWT_SECRET         = process.env.ONLYOFFICE_JWT_SECRET
```

---

### Frontend: `src/App.jsx`

**Переключатель режима:**
```js
const OO_MODE = !!import.meta.env.VITE_ONLYOFFICE_URL;
// На Render: не задан → false → SuperDoc (стабильный продакшн)
// Локально: задан → true → ONLYOFFICE
```

**Что добавлено в App.jsx (всё под `if (window.__ooMode)` или `if (OO_MODE)`):**
- `getDocSnapshot()` — в OO_MODE читает `window.__ooDocText` из bridge
- `applyAgentCommand()` — в OO_MODE: сначала `__ooConnector` (null в Community Ed), fallback → `bridge/push`
- OO setup useEffect — регистрирует `window.__ooLoadDocText`, `window.__ooOpenDocx`, polling выделения 1.5с
- Upload useEffect — вызывает `window.__ooLoadDocText(fileId)` после загрузки файла
- `renderLegalDocument()` — в OO_MODE пропускается (документ открывается через `__ooOpenDocx`)
- `ClauseLibrary.insertClause()` — в OO_MODE отправляет в `bridge/push`
- Async doctext refresh — перед каждым ИИ-запросом агента делает `GET /api/onlyoffice/bridge/doctext`

**Компонент `src/components/onlyoffice-workspace/OnlyOfficeEditor.jsx`:**
- Создаёт ONLYOFFICE-контейнер imperatively (не через React) — обход insertBefore crash
- Загружает `api.js` с DocServer через singleton `ensureDocsApi()`
- Диагностическое логирование в `onAppReady` (typeof методов редактора)

---

### Что подтверждено

- **`createConnector()` НЕ доступен в Community Edition 9.4.0** — только Developer/Enterprise. Bridge relay — единственный правильный путь.
- **SDK**: официальный CDN работает (200 OK, проверено `curl`).
- **`document.url`** для DocServer: должен быть `http://host.docker.internal:3000/...` (не `onrender.com`). Исправлено в `DOCSERVER_BACKEND_URL`.
- **JWT**: DocServer ожидает JWT если `JWT_ENABLED=true`. Секрет должен совпадать в `.env` и `docker-compose.yml`.

---

### На чём остановились — точный диагноз

**Симптом:** при загрузке `.docx` ONLYOFFICE показывает: `⚠ Загрузка не удалась. Убедитесь что DocServer доступен: http://localhost:8080`

**Генерация документов** (12 типов): сервер создаёт `.docx` через `buildDocx()` → возвращает `docxFileId` → App.jsx вызывает `window.__ooOpenDocx(docxFileId)` → падает на той же ошибке открытия. **Генерация работает, открытие — нет.**

**Bridge relay для ИИ-правок:** логика `Search().SetText()` в `plugin.js` реализована. Проблема в том, что ONLYOFFICE сам не открывает документ → до bridge дело не доходит.

**Вероятные причины ошибки открытия (непроверенные):**
1. `host.docker.internal` не резолвится из Docker на этой Windows-машине → DocServer не может скачать файл
2. JWT mismatch: секрет задан в `.env` но конфиг генерируется неправильно
3. `onError` от ONLYOFFICE содержит конкретное `errorDescription` — нужно посмотреть в DevTools Console

**Команды диагностики для возобновления:**
```powershell
# 1. Резолвится ли host.docker.internal из Docker?
docker exec miyzamchi-docserver curl -s -o /dev/null -w "%{http_code}" http://host.docker.internal:3000/api/ping

# 2. Логи DocServer в момент открытия:
docker logs miyzamchi-docserver --tail 50 -f
# → открыть браузер, загрузить docx, смотреть логи

# 3. DevTools Console: искать '[OO Diag] onAppReady' и любые onError
```

---

## Как возобновить в версии 2.0

1. Убедиться что в `.env` задан `ONLYOFFICE_JWT_SECRET`
2. Запустить Docker: `docker-compose up -d`
3. Добавить в локальный `.env` (фронт): `VITE_ONLYOFFICE_URL=http://localhost:8080`
4. Запустить диагностику: `docker exec miyzamchi-docserver curl http://host.docker.internal:3000/api/ping`
5. Если `host.docker.internal` не резолвится → узнать IP хоста: `docker exec miyzamchi-docserver cat /etc/hosts | grep host-gateway` → прописать в `OO_DOCSERVER_BACKEND_URL` в `.env`
6. Открыть DevTools, загрузить `.docx`, проверить `[OO Diag]` логи в Console
7. Исправить конкретную ошибку → всё остальное (bridge relay, AI-правки) уже готово

---

## Файлы ONLYOFFICE (не удалять)

```
routes/onlyoffice.js                          ← все API маршруты
onlyoffice-plugin/miyzamchi-ai/plugin.js      ← код плагина
onlyoffice-plugin/miyzamchi-ai/index.html     ← UI плагина
onlyoffice-plugin/miyzamchi-ai/config.json    ← манифест
docker-compose.yml                            ← DocServer конфиг
src/components/onlyoffice-workspace/          ← React-компонент
lib/docxGenerator.js                          ← генерация .docx (используется и SuperDoc и OO)
```

Все вызовы в `src/App.jsx` обёрнуты в `if (window.__ooMode)` или `if (OO_MODE)` — они **не выполняются** в продакшне (Render), где `VITE_ONLYOFFICE_URL` не задан.
