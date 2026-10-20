FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY data ./data
COPY agent ./agent
COPY frontend ./frontend

EXPOSE 8080

CMD ["sh", "-c", "exec uvicorn agent.service:app --host 0.0.0.0 --port ${PORT}"]
