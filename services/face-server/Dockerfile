FROM python:3.10-slim

# ✅ insightface/opencv + (혹시 소스빌드로 떨어질 때를 대비한) 컴파일 툴체인
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential g++ gcc cmake pkg-config \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8080
EXPOSE 8080

# ✅ Cloud Run의 PORT 환경변수 사용 (중요)
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
