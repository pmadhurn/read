FROM python:3.12-slim-trixie

RUN apt-get update && apt-get install -y --no-install-recommends \
        postgresql-client tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin tesseract-ocr-guj \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY read ./read

# The books volume inherits this mode on first use, so any APP_UID can write to it.
RUN mkdir -p /data && chmod 1777 /data

ENV PYTHONUNBUFFERED=1 HOME=/tmp
EXPOSE 8000
CMD ["uvicorn", "read.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
