# 가을 계곡 앰비언트 → 유튜브 MP4 메이커 — NAS/서버용 이미지
FROM node:20-slim

# 시스템 ffmpeg 설치(아키텍처/플랫폼에 안정적). 서버는 FFMPEG_PATH로 이 바이너리를 사용.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    PORT=5174 \
    HOST=0.0.0.0

WORKDIR /app

# 의존성 먼저 설치(레이어 캐시). ffmpeg-static은 fallback일 뿐이라 빌드 실패 무시.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 앱 소스 복사 (server.js가 require하는 모듈은 반드시 포함 — 누락 시 시작 크래시)
COPY server.js youtube.js metadata.js ./
COPY public ./public

EXPOSE 5174

CMD ["node", "server.js"]
