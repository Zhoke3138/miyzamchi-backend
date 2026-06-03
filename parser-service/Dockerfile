# Miyzamchi 2.0 — Parser Microservice (IBM Docling) для Google Cloud Run
# Ключевая идея: МОДЕЛИ ЗАПЕКАЕМ В ОБРАЗ на этапе build, чтобы в рантайме
# (особенно на холодном старте) НИЧЕГО не качалось из сети и не лопнул таймаут.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # Куда Docling кладёт/ищет модели. Должно совпадать с местом prefetch ниже.
    DOCLING_ARTIFACTS_PATH=/opt/docling-models \
    # easyOCR тоже не должен качать модели в рантайме.
    EASYOCR_MODULE_PATH=/opt/easyocr-models

WORKDIR /app

# Системные либы для Docling/torch/easyocr (OpenCV, glib).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

# --- PREFETCH МОДЕЛЕЙ В ОБРАЗ (no runtime download) ---
# 1) layout + tableformer (и сопутствующие) через CLI-утилиту Docling.
RUN docling-tools models download --output-dir "${DOCLING_ARTIFACTS_PATH}"
# 2) Прогрев конвертера, чтобы любые ленивые артефакты подтянулись на build.
RUN python -c "from docling.document_converter import DocumentConverter; DocumentConverter()"

COPY main.py .

# Cloud Run подаёт порт через переменную $PORT (по умолчанию 8080).
ENV PORT=8080
EXPOSE 8080

# 1 воркер: конкурентность ограничиваем на уровне Cloud Run (--concurrency 1),
# тяжёлый парсинг внутри уводится в threadpool (asyncio.to_thread).
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
