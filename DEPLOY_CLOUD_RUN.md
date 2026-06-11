# Деплой парсер-микросервиса на Google Cloud Run (пошагово)

> 🗑️ **DEPRECATED (11.06.2026, Этап 1 Backend Pivot):** парсер-микросервис на Cloud Run
> **СНЕСЁН**, эта инструкция больше НЕ применяется. Парсинг теперь локальный в Node
> (`services/parserService.js`). Сам сервис в GCP и env-переменные
> (`PARSER_SERVICE_URL`, `GCP_SA_KEY_JSON`, `PARSER_TIMEOUT_MS`) можно удалить вручную.
> Документ оставлен как историческая справка.

> Это инструкция для **не-программиста**. Делаем один раз. После настройки
> Node-бэкенд на Render будет сам обращаться к парсеру за извлечением текста из PDF.
>
> Что мы настраиваем:
> 1. Сервис-аккаунт (робот-пользователь) + его JSON-ключ — им Render «подписывает» запросы.
> 2. Сам микросервис `miyzamchi-parser` на Cloud Run (папка `parser-service/`).
> 3. Права: разрешаем роботу вызывать микросервис.
> 4. Переменные на Render.

---

## Часть 0. Что понадобится
- Аккаунт Google и проект в [Google Cloud Console](https://console.cloud.google.com).
- Включённая оплата (Billing) — Free Tier бесплатен, но карта нужна для активации.
- Папка `parser-service/` из этого репозитория (уже готова: `Dockerfile`, `main.py`, `requirements.txt`).

> 💡 Терминал не обязателен — почти всё делается мышкой в веб-консоли Google.
> Команды `gcloud` привожу как альтернативу, если кто-то помогает через консоль.

---

## Часть 1. Создать проект и включить сервисы
1. Зайди в [console.cloud.google.com](https://console.cloud.google.com).
2. Вверху выбери/создай **проект** (например `miyzamchi`). Запомни его **Project ID** (вид: `miyzamchi-123456`).
3. В строке поиска вверху найди и **включи (Enable)** два API:
   - **Cloud Run Admin API**
   - **Cloud Build API**

---

## Часть 2. Задеплоить микросервис (через GitHub/исходники — без терминала)
1. В поиске консоли набери **Cloud Run** → открой → кнопка **Deploy container** → **Service**.
2. Выбери **Continuously deploy from a repository (source or function)** → **Set up with Cloud Build**.
3. Подключи свой **GitHub-репозиторий** и ветку `main`.
4. **Build type:** выбери **Dockerfile**, а в поле **Source location / Dockerfile directory** укажи:
   ```
   /parser-service
   ```
   (микросервис лежит в этой подпапке репозитория).
5. Настрой ресурсы (важно!):
   - **Region:** `europe-west1` (или ближайший).
   - **Memory:** `2 GiB`
   - **CPU:** `1`
   - **Request timeout:** `300` секунд
   - **Maximum concurrent requests per instance (concurrency):** `1`  ← критично, иначе нехватка памяти
   - **Minimum number of instances:** `0` (Free Tier — холодный старт)
   - **Authentication:** выбери **Require authentication** (НЕ «Allow unauthenticated»).
6. Нажми **Create**. Первая сборка идёт ~5-15 минут (Docling тяжёлый, модели запекаются в образ).
7. Когда готово — скопируй **URL сервиса** (вид: `https://miyzamchi-parser-xxxxxxxx.run.app`).
   Он понадобится для Render (`PARSER_SERVICE_URL`).

<details>
<summary>Альтернатива через терминал (gcloud)</summary>

```bash
cd parser-service
gcloud run deploy miyzamchi-parser \
  --source . \
  --region europe-west1 \
  --memory 2Gi --cpu 1 \
  --concurrency 1 \
  --timeout 300 \
  --min-instances 0 \
  --no-allow-unauthenticated
```
</details>

---

## Часть 3. Создать сервис-аккаунт (робота для Render)
1. В поиске консоли → **IAM & Admin** → **Service Accounts** → **Create service account**.
2. **Name:** `miyzamchi-render-caller` → **Create and continue**.
3. На шаге «Grant access» можно ничего не выбирать → **Done** (права выдадим точечно в Части 5).

---

## Часть 4. Сгенерировать JSON-ключ
1. Открой только что созданный сервис-аккаунт `miyzamchi-render-caller@...`.
2. Вкладка **Keys** → **Add key** → **Create new key** → формат **JSON** → **Create**.
3. Браузер скачает файл вида `miyzamchi-render-caller-abcd1234.json`. **Это секрет — не публикуй, не коммить в Git!**

---

## Часть 5. Разрешить роботу вызывать микросервис
Нужно дать сервис-аккаунту роль **Cloud Run Invoker** именно на наш сервис.
1. **Cloud Run** → открой сервис `miyzamchi-parser` → вкладка **Security** (или **Permissions**).
2. **Add principal** →
   - **New principals:** вставь email робота (вид `miyzamchi-render-caller@ПРОЕКТ.iam.gserviceaccount.com`).
   - **Role:** `Cloud Run Invoker`.
3. **Save**.

<details>
<summary>Альтернатива через терминал (gcloud)</summary>

```bash
gcloud run services add-iam-policy-binding miyzamchi-parser \
  --region europe-west1 \
  --member="serviceAccount:miyzamchi-render-caller@ПРОЕКТ.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```
</details>

---

## Часть 6. Прописать переменные на Render
Зайди в Render → твой Node-сервис → **Environment** → добавь:

| Ключ | Значение |
|------|----------|
| `PARSER_SERVICE_URL` | URL из Части 2 (например `https://miyzamchi-parser-xxxx.run.app`) — **без слэша на конце** |
| `GCP_SA_KEY_JSON` | **всё содержимое** скачанного JSON-файла из Части 4 |
| `PARSER_TIMEOUT_MS` | `100000` (необязательно) |

### Как правильно вставить `GCP_SA_KEY_JSON`
- Открой скачанный `.json` в Блокноте → выдели **всё** (Ctrl+A) → копируй → вставь в поле значения.
- **Сжимать в одну строку НЕ обязательно** — наш код делает `JSON.parse()`, а сам файл уже валидный JSON.
- ⚠️ **Главное:** НЕ редактируй содержимое, особенно поле `private_key`. Внутри него стоят символы `\n`
  (обратный слэш + n) — это часть JSON, так и должно быть. Если заменишь их на реальные переносы строк —
  ключ сломается.
- Если Render капризничает с многострочным значением — минифицируй JSON в одну строку
  (например на [jsonformatter.org](https://jsonformatter.org) → кнопка **Minify/Compact**) и вставь результат.
  `\n` внутри `private_key` при минификации остаются как есть — это правильно.

---

## Часть 7. Проверка
1. **Health-check микросервиса** (он защищён auth, поэтому 403 без токена — это норма, значит сервис живой):
   открой `https://...run.app/health` в браузере → ждём `403 Forbidden` (доступ только роботу) — сервис работает.
2. **Боевой тест:** загрузи PDF через интерфейс Мыйзамчы.
   - Первый запрос после простоя — медленный (холодный старт Docling, до ~60-90с): код сделает 1 авто-ретрай.
   - Последующие — быстрые.
3. В логах Render должно быть видно обращение к парсеру; в логах Cloud Run — `Parsing '...' (N bytes)`.

---

## Частые проблемы
| Симптом | Причина / решение |
|---------|-------------------|
| `403` при загрузке PDF | Роль `Cloud Run Invoker` не выдана роботу (Часть 5) или неверный email SA |
| `GCP_SA_KEY_JSON не задан` в логах | Переменная не добавлена на Render (Часть 6) |
| `Unexpected token ... in JSON` | Сломан `private_key` — вставь файл заново, не трогая `\n` |
| Таймаут на первом PDF | Холодный старт. Это ожидаемо на Free Tier; ретрай отрабатывает. Хочешь убрать — `min-instances=1` (платно) |
| `PARSER_SERVICE_URL не задан` | Добавь URL сервиса в Render (Часть 6), без слэша на конце |

---

## Безопасность (ZDR)
- Файлы на Node живут в `/tmp` только на время отправки и удаляются в `finally` (`services/parserService.js`).
- Python парсит PDF **в памяти** (`io.BytesIO`), на диск ничего не пишет (`parser-service/main.py`).
- Cloud Run закрыт (`Require authentication`) — вызвать может только робот Render с ролью Invoker.
- Pinecone — Read-Only (только законы КР).
