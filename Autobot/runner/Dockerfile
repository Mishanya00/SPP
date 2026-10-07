FROM python:3.12.14-slim
RUN pip install --no-cache-dir aiogram==3.26.0 && useradd -u 10001 -m bot && mkdir /data /app && chown bot:bot /data /app
WORKDIR /data
COPY entrypoint.py /opt/entrypoint.py
USER bot
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
CMD ["python", "/opt/entrypoint.py"]
