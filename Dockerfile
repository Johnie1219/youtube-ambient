# 가을 계곡 앰비언트 → 유튜브 MP4 메이커 — NAS/서버용 이미지
FROM node:20-slim

# 시스템 ffmpeg + 한글 폰트(영상 제목 오버레이용) 설치.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-nanum \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FONT_PATH=/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf \
    PORT=5174 \
    HOST=0.0.0.0

WORKDIR /app

# 의존성 먼저 설치(레이어 캐시). ffmpeg-static은 fallback일 뿐이라 빌드 실패 무시.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 앱 소스 전체 복사. (.dockerignore가 node_modules·android·docs 등을 제외)
# 개별 COPY로 새 모듈을 빠뜨려 컨테이너가 크래시하던 문제를 원천 차단.
COPY . ./

EXPOSE 5174

CMD ["node", "server.js"]
