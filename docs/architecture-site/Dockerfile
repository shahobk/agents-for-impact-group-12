FROM python:3.13-slim

WORKDIR /site
COPY dist/ ./

ENV PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080

USER 65534
CMD ["python", "-m", "http.server", "8080", "--bind", "0.0.0.0"]
