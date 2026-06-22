# Мыйзамчы AI — ONLYOFFICE Plugin

Кастомный плагин для ONLYOFFICE Document Server. Боковая панель с AI-ассистентом.

## Установка в DocServer (Docker)

В `docker-compose.yml` раскомментировать volume-маунт плагина:

```yaml
volumes:
  - ./onlyoffice-plugin/miyzamchi-ai:/var/www/onlyoffice/documentserver/sdkjs-plugins/miyzamchi-ai
```

Перезапустить контейнер:
```bash
docker-compose down && docker-compose up -d
```

Открыть ONLYOFFICE → меню «Плагины» → «Мыйзамчы AI».

## Иконка (обязательно перед деплоем)

Создать два файла в этой папке:
- `icon.png` — 40×40 px, PNG, синий фон `#0069ff` с белым символом ⚖
- `icon@2x.png` — 80×80 px (retina)

Или сгенерировать из `icon.svg`:
```bash
npx sharp-cli -i icon.svg -o icon.png --width 40 --height 40
npx sharp-cli -i icon.svg -o icon@2x.png --width 80 --height 80
```

## Режимы плагина

| Режим | Что делает |
|---|---|
| 💬 Консультация | Вопрос-ответ по НПА КР (fast mode) |
| 🔍 Аудит | Глубокий анализ документа/выделения (thinking mode) → комментарии в полях |
| ✏ Агент | Выделить текст → получить правку → вставить одной кнопкой |

## Переменная BACKEND_URL

В `plugin.js` строка 1:
```js
var BACKEND_URL = 'https://miyzamchi-backend.onrender.com';
```
Изменить при необходимости.
