# Build from the repository root:
#   docker build -f deploy/Dockerfile -t open-jev .
# Run (weights download to /data/hf on first boot; mount a volume there):
#   docker run -p 8080:8080 -v openjev-weights:/data open-jev
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir torch==2.10.0 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir fastapi uvicorn
COPY . /app/src
RUN pip install --no-cache-dir -e /app/src
COPY deploy/app.py .
ENV PORT=8080
ENV HF_HOME=/data/hf
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
