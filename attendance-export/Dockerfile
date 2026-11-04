FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Asia/Bangkok
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 exporter \
    && useradd --uid 10001 --gid exporter --no-create-home exporter
COPY attendance_export.py .
USER 10001:10001
ENTRYPOINT ["python", "attendance_export.py"]
