"""
Miyzamchi 2.0 — Parser Microservice (IBM Docling)
=================================================
Приватный FastAPI-сервис для Google Cloud Run (2GB RAM).
Принимает PDF, парсит ЕГО В ПАМЯТИ (Zero Data Retention) и отдаёт Markdown.

АУТЕНТИФИКАЦИЯ:
    Сервис деплоится как `--no-allow-unauthenticated`. Валидацию OIDC ID-токена
    выполняет САМА платформа Cloud Run (IAM) ДО того, как запрос дойдёт сюда:
    вызывающему сервис-аккаунту выдаётся роль `roles/run.invoker`.
    Поэтому в коде токен повторно не проверяется (платформа уже отсеяла чужих).
    Нужна доп. защита — раскомментируйте verify_id_token ниже (defense-in-depth).

ZERO DATA RETENTION:
    Файл НИКОГДА не пишется на диск. Docling читает из io.BytesIO и работает
    исключительно в оперативной памяти контейнера. После ответа GC освобождает буфер.

CLOUD RUN DEPLOY (справочно, см. README ниже в этом каталоге):
    gcloud run deploy miyzamchi-parser \
        --source . --region europe-west1 \
        --memory 2Gi --cpu 1 --concurrency 1 \
        --timeout 300 --no-allow-unauthenticated
    # concurrency=1 — критично: Docling прожорлив по RAM, параллель = OOM в 2GB.
"""

import asyncio
import io
import logging
import os

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from docling.datamodel.base_models import DocumentStream
from docling.document_converter import DocumentConverter

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("miyzamchi-parser")

# Ограничение размера входа (защита памяти 2GB). 25 МБ с запасом для юр. PDF.
MAX_FILE_BYTES = int(os.getenv("MAX_FILE_BYTES", str(25 * 1024 * 1024)))

app = FastAPI(title="Miyzamchi Parser", version="2.0.0")

# DocumentConverter тяжёлый (грузит ML-модели layout/tableformer/OCR).
# Инициализируем ОДИН раз на старте контейнера, переиспользуем между запросами.
# Модели запечены в образ (см. Dockerfile), поэтому здесь только загрузка в RAM.
_converter: DocumentConverter | None = None


@app.on_event("startup")
def _warmup() -> None:
    global _converter
    log.info("Initializing Docling DocumentConverter (loading models into RAM)...")
    _converter = DocumentConverter()
    log.info("Docling ready.")


@app.get("/health")
def health() -> dict:
    """Liveness/readiness-проба для Cloud Run."""
    return {"status": "ok", "ready": _converter is not None}


def _convert_to_markdown(raw: bytes, filename: str) -> dict:
    """Синхронный (CPU-bound) парсинг. Запускается в отдельном потоке."""
    assert _converter is not None, "Converter not initialized"
    # DocumentStream оборачивает байты в поток — Docling не трогает диск.
    source = DocumentStream(name=filename, stream=io.BytesIO(raw))
    result = _converter.convert(source)
    doc = result.document
    markdown = doc.export_to_markdown()
    return {
        "markdown": markdown,
        "pages": len(getattr(doc, "pages", []) or []),
        # эвристика: есть ли '##'-заголовки → решает уже Node (Graceful Degradation),
        # но прокидываем флаг для удобства телеметрии.
        "has_headings": "\n##" in markdown or markdown.startswith("##"),
    }


@app.post("/parse")
async def parse(file: UploadFile = File(...)) -> JSONResponse:
    # --- defense-in-depth (опционально): проверка ID-токена в контейнере ---
    # from google.oauth2 import id_token
    # from google.auth.transport import requests as g_requests
    # token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    # id_token.verify_oauth2_token(token, g_requests.Request(), audience=AUDIENCE)
    # -----------------------------------------------------------------------

    raw = await file.read()  # читаем целиком в память (ZDR: никакого диска)
    size = len(raw)
    if size == 0:
        raise HTTPException(status_code=400, detail="Empty file")
    if size > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large: {size} bytes (limit {MAX_FILE_BYTES})",
        )

    log.info("Parsing '%s' (%d bytes)...", file.filename, size)
    try:
        # Docling блокирует поток → уводим в threadpool, чтобы /health не вис.
        payload = await asyncio.to_thread(_convert_to_markdown, raw, file.filename or "doc.pdf")
    except Exception as exc:  # noqa: BLE001 — наружу отдаём чистую 422
        log.exception("Docling failed for '%s'", file.filename)
        raise HTTPException(status_code=422, detail=f"Parse error: {exc}") from exc
    finally:
        # ZDR: явно роняем ссылку на буфер; GC освободит память.
        del raw

    log.info("Parsed '%s': %d chars markdown", file.filename, len(payload["markdown"]))
    return JSONResponse(payload)
