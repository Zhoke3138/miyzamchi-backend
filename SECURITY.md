# Security Standards — Мыйзамчы

Последний аудит: **2026-05-21**.

## ✅ Что встроено в код

| Защита | Где | Как работает |
|---|---|---|
| **Static blocklist** | server.js (helmet) | Запросы к `/server.js`, `/package.json`, `/CLAUDE.md`, `/.env` и др. → 404 |
| **CSP-headers** | server.js (helmet) | Скрипты можно грузить только с whitelisted CDN (unpkg, jsdelivr, cdnjs, esm.sh) |
| **CORS whitelist** | server.js | Запросы только с доменов в `ALLOWED_ORIGINS` (по умолчанию Netlify + Render + dev) |
| **Helmet headers** | server.js | X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security и др. |
| **Rate limiting** | server.js | 30/мин `/api/chat`, 30/мин `/api/analyze`, 6/мин `/api/deep-analyze` |
| **Request size limit** | server.js | `express.json({ limit: '2mb' })` |
| **API key rotation** | server.js | Round-robin Gemini-ключей с auto-block при 429 |
| **Resilient retry** | server.js | Exp.backoff + jitter + fallback model на 503-шторме |
| **No PII in logs** | server.js | Логируется только длина сообщения, не контент |
| **No stack trace leak** | server.js | uncaughtException пишет только `err.message`, не stack |
| **XSS — DOMPurify** | IDE + chat UI | `marked.parse()` → `DOMPurify.sanitize()` перед innerHTML |
| **localStorage TTL** | IDE | Чаты старше 60 дней удаляются автоматически (privacy) |
| **No localhost fallback** | IDE | `_ensureBackend()` гарантирует продакшн URL даже при пустом BACKEND_URL |

## ⚙️ Что нужно настроить в Render (Environment Variables)

### Обязательные

```
GEMINI_API_KEY=<ваш платный ключ>
PINECONE_API_KEY=<ключ>
PINECONE_HOST=<host>
```

### Опциональные (но рекомендуемые)

```
DEEPSEEK_API_KEY=<ключ DeepSeek для JUDGE tier>
```

DeepSeek V4 Pro используется как «Судья» в `seniorPartnerSynthesis` и `runJudge`.
Если ключ не задан — оба endpoint'а автоматически идут на Gemini SENIOR (3.1-flash)
без прерывания работы. Это **soft dependency** — система работает без DeepSeek,
но качество финального вердикта в Deep Analysis ниже.

### Рекомендуемые (защита денег и приватности)

```
ADMIN_SECRET=<32-байтная строка>         # без неё /api/stats отключён
CLIENT_TOKEN=<32-байтная строка>         # без него API публичные
ALLOWED_ORIGINS=https://yourdomain.com   # CORS whitelist
```

Генерация секретов: `openssl rand -hex 32` (Git Bash / WSL / Mac).

## 💰 Защита от перерасхода Gemini API (КРИТИЧЕСКИ ВАЖНО)

Перед привязкой платёжной карты к Google Cloud:

1. Открой **Google Cloud Console** → выбери проект с Gemini API
2. **Billing** → **Budgets & alerts** → **Create Budget**
3. Поставь:
   - **Budget amount:** $10/месяц для старта (или сколько готов потерять в худшем случае)
   - **Alert threshold:** 50%, 90%, 100% (Pub/Sub email-уведомление)
   - **Действие при 100%:** запрос на cap (не автоматическое отключение, но письмо придёт)
4. **Quotas & System Limits** → найди `Gemini API` → выстави **Requests per day** = разумное число (например, 1000/день)

**Сценарий без cap:** скрипт-скрейпер находит endpoint → за ночь делает 100K запросов → счёт $500+. С cap → 1000 запросов и стоп.

## 🚧 Не реализовано (требует отдельной работы)

- **Пользовательская авторизация** (логин/пароль/JWT) — `CLIENT_TOKEN` это barrier, не auth. Для multi-tenant нужен полноценный auth flow.
- **Шифрование localStorage** через Web Crypto API — конфликтует со схемой синхронного сохранения чатов. Текущая защита: TTL 60 дней + DOMPurify против XSS.
- **Sentry / observability** — `logger` в `server.js` готов под Sentry (`Sentry.captureException` закомментирован). Подключите DSN когда будет нужно.
- **2FA для админки** — `/api/stats` защищён одним секретом. Для продакшн-админки нужен полноценный SSO.

## 🔍 Регулярные проверки

- **Раз в месяц:** проверить логи Render на `[CORS] Blocked origin` и `[SECURITY]`
- **Раз в квартал:** ротировать `ADMIN_SECRET` и `CLIENT_TOKEN`
- **При каждом релизе:** запустить `npm audit` (`npm audit fix` если есть high/critical)
- **Если потерял ключ:** немедленно revoke в Google Cloud Console + создать новый

## 📞 Что делать если что-то скомпрометировано

1. **Утёк Gemini-ключ:** Google Cloud Console → APIs & Services → Credentials → Delete API key. Создай новый, замени в Render.
2. **Утёк Pinecone:** Pinecone Console → API Keys → Revoke. Создай новый.
3. **DDoS / квотный шторм:** Render Dashboard → Settings → Suspend Service. Подожди 1-2 часа. Затем подкрути `rateLimit` (с 30/мин до 10/мин) и `CLIENT_TOKEN` сделай обязательным.
4. **Подозрение на XSS в логах:** очистить чат-историю всех пользователей (DOMPurify уже блокирует, но if in doubt — `localStorage.clear()` в браузере + console: `window.clearAllIdeHistory()`).
