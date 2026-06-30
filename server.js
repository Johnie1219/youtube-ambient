'use strict';

/**
 * AI Music Studio — 코드로 음악 생성 + 영상 합치기 → MP4
 *
 * - 음악은 브라우저(public/audio/ambient-engine.js)에서 Tone.js로 코드 생성됩니다.
 * - 이 서버는 생성된 음악(WAV)과 영상/이미지를 받아 ffmpeg로 고화질 MP4를 만듭니다.
 * - ffmpeg는 ffmpeg-static로 번들되어 별도 설치가 필요 없습니다.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const youtube = require('./youtube');
const metadata = require('./metadata');
const stock = require('./stock');

// ffmpeg 경로: FFMPEG_PATH(예: Docker의 /usr/bin/ffmpeg)가 있으면 우선, 없으면 번들(ffmpeg-static)
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

// 빌드 버전 — 배포 때마다 올려, 화면 푸터에서 "업데이트 반영"을 눈으로 확인할 수 있게 한다.
const APP_VERSION = '2026.06.30-3';

const app = express();
const PORT = process.env.PORT || 5174;
const HOST = process.env.HOST || '0.0.0.0'; // 모든 인터페이스 → LAN/원격 접속 허용

// 리버스 프록시(NAS) 뒤에서 동작 시 클라이언트 IP/프로토콜 신뢰
app.set('trust proxy', true);

// (선택) 외부 노출용 간단 Basic 인증 — BASIC_AUTH_USER/PASS 환경변수가 있으면 활성화
const AUTH_USER = process.env.BASIC_AUTH_USER;
const AUTH_PASS = process.env.BASIC_AUTH_PASS;
if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || '';
    const [scheme, encoded] = hdr.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const idx = decoded.indexOf(':');
      const u = decoded.slice(0, idx);
      const p = decoded.slice(idx + 1);
      if (u === AUTH_USER && p === AUTH_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="ambient"');
    return res.status(401).send('인증이 필요합니다.');
  });
}

// 작업용 임시 업로드 폴더 + 완성 영상 영구 저장 폴더(OUTPUT_DIR → NAS 볼륨에 매핑)
const WORK = path.join(os.tmpdir(), 'youtube-ambient');
const UPLOADS = path.join(WORK, 'uploads');
const OUTPUTS = process.env.OUTPUT_DIR || path.join(WORK, 'outputs');
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(OUTPUTS, { recursive: true });

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB
});

app.use(express.json({ limit: '1mb' }));

// 정적 파일
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'tone', 'build')));
app.use(express.static(path.join(__dirname, 'public')));

// ── 완성 영상 메타데이터(제목/설명/태그/유튜브 상태) 헬퍼 ──────────────
function metaPath(id) { return path.join(OUTPUTS, id + '.json'); }
function videoPath(id) { return path.join(OUTPUTS, id + '.mp4'); }
function isValidId(id) { return /^[a-f0-9]{8,32}$/.test(String(id)); }

function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); }
  catch (_) { return null; }
}
function writeMeta(id, meta) {
  try { fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2)); } catch (_) { /* ignore */ }
}
function listVideos() {
  let files = [];
  try { files = fs.readdirSync(OUTPUTS); } catch (_) { return []; }
  return files
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => {
      const id = f.replace(/\.mp4$/, '');
      let size = 0;
      try { size = fs.statSync(videoPath(id)).size; } catch (_) {}
      const meta = readMeta(id) || {};
      return {
        id,
        title: meta.title || id,
        description: meta.description || '',
        tags: meta.tags || [],
        theme: meta.theme || null,
        preset: meta.preset || null,
        durationSec: meta.durationSec || null,
        resolution: meta.resolution || null,
        createdAt: meta.createdAt || 0,
        sizeMB: Math.round((size / (1024 * 1024)) * 10) / 10,
        youtube: meta.youtube || null,
      };
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// jobId -> { status, percent, file, error, listeners[], cleanup[] }
const jobs = new Map();

function notify(job) {
  const payload = JSON.stringify({
    status: job.status,
    percent: Math.round(job.percent),
    note: job.note || null,
    error: job.error,
  });
  for (const send of job.listeners) {
    try { send(payload); } catch (_) { /* ignore broken pipe */ }
  }
}

function timemarkToSeconds(tm) {
  if (!tm) return 0;
  const parts = String(tm).split(':');
  if (parts.length !== 3) return 0;
  const [h, m, s] = parts;
  return (+h) * 3600 + (+m) * 60 + parseFloat(s);
}

function safeUnlink(p) {
  if (!p) return;
  fs.promises.unlink(p).catch(() => {});
}

/**
 * 영상 필터 체인을 만든다.
 * - 영상 클립: 비율 유지 스케일 + 레터박스 패드
 * - 이미지: 느린 켄번스 줌
 * - 폴백: lavfi gradients(서버 입력에서 생성)
 */
// 자동 생성 배경 테마 5종 (gradients 2색 + 흐름 속도). 색은 0xRRGGBB.
const THEMES = {
  autumn_valley:  { c0: '0x16281c', c1: '0x4a3410', speed: 0.006 }, // 가을 계곡: 숲 그린 → 앰버
  golden_sunset:  { c0: '0x3a1e08', c1: '0xc8862a', speed: 0.005 }, // 황금 노을: 갈색 → 황금빛
  misty_dawn:     { c0: '0x10202a', c1: '0x3a4a52', speed: 0.004 }, // 새벽 안개: 짙은 청록 → 슬레이트
  rosewood_night: { c0: '0x2a0e1a', c1: '0x4a2440', speed: 0.004 }, // 모닥불 밤: 적갈색 → 자줏빛
  forest_emerald: { c0: '0x0e2014', c1: '0x2f5a36', speed: 0.005 }, // 숲 에메랄드: 짙은 녹 → 모스 그린
  dreamy_violet:  { c0: '0x1a1030', c1: '0x4a2a6a', speed: 0.006 }, // 드리미: 짙은 보라 → 라일락
  deep_indigo:    { c0: '0x080a1a', c1: '0x1c2a4a', speed: 0.003 }, // 딥 슬립: 한밤 인디고
  lofi_dusk:      { c0: '0x2a1a2a', c1: '0x6a4a3a', speed: 0.005 }, // 로파이: 더스크 보라/브라운
  neon_city:      { c0: '0x0a1428', c1: '0x2a1a4a', speed: 0.007 }, // 나이트 시티: 네온 블루/퍼플
};

function buildVideoFilter({ kind, w, h, fps, duration, loopSec }) {
  const period = loopSec || 10; // 배경 호흡/모션 주기(초) — 루프 클립 길이와 맞추면 이음새 없음
  if (kind === 'image') {
    const frames = Math.max(1, Math.ceil(duration * fps));
    // 살짝 크게 스케일 후 천천히 줌인(켄번스). zoompan은 입력 1프레임을 frames개로 늘린다.
    return (
      `scale=${Math.round(w * 1.2)}:-2,` +
      `zoompan=z='min(zoom+0.00015,1.15)':d=${frames}:` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps},` +
      `setsar=1,format=yuv420p`
    );
  }
  if (kind === 'gradient') {
    // 자동 테마 배경: gradients를 작게 생성(서버 입력 640x360)했으므로 무거운 픽셀 연산
    // (eq 매프레임 sin + vignette)을 작은 프레임에서 처리한 뒤 목표 해상도로 업스케일.
    // → ARM NAS에서 인코딩 속도 대폭 향상(부드러운 그라데이션이라 확대해도 깨끗).
    return (
      `eq=brightness='0.05*sin(2*PI*t/${period})':saturation='1.06+0.10*sin(2*PI*t/${period})':eval=frame,` +
      `vignette,` +
      `scale=${w}:${h}:flags=bilinear,` +
      `fps=${fps},setsar=1,format=yuv420p`
    );
  }
  // 영상 클립: 비율 유지 스케일 + 레터박스 패드
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `fps=${fps},setsar=1,format=yuv420p`
  );
}

// ── (선택) 영상 제목 오버레이 — 플레이리스트 커버형(가운데 큰 세리프 제목 + 부제) ──
const FONT_PATH = process.env.FONT_PATH || '/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf';

// 우아한 세리프(명조). 이미지에 없으면 기본 폰트로 안전 폴백.
const FONT_SERIF_PATH = (() => {
  if (process.env.FONT_SERIF_PATH) return process.env.FONT_SERIF_PATH;
  const candidates = [
    '/usr/share/fonts/truetype/nanum/NanumMyeongjoBold.ttf',
    '/usr/share/fonts/truetype/nanum/NanumMyeongjo.ttf',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return FONT_PATH;
})();

function wrapText(text, perLine) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > perLine && cur) { lines.push(cur); cur = w; }
    else cur = (cur ? cur + ' ' : '') + w;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3).join('\n'); // 최대 3줄
}

// 부제: 글자 사이를 벌려(자간 넓게) 라틴은 대문자로 — 레퍼런스의 "JAZZ VOCAL PLAYLIST" 톤.
function spaceOut(text) {
  return String(text).trim().toUpperCase().split('').join(' ').replace(/\s{2,}/g, '  ').trim();
}

// 화면 가운데 정렬. title은 세리프 큰 글씨, subtitle은 그 아래 작은 자간 글씨.
// 박스 없이 외곽선+그림자만 → 실사 영상 위에서도 또렷하면서 우아하게.
function buildOverlay({ titlePath, subPath, h }) {
  const parts = [];
  if (titlePath) {
    parts.push(
      `drawtext=fontfile=${FONT_SERIF_PATH}:textfile=${titlePath}:` +
      `fontcolor=white:fontsize=${Math.round(h / 11)}:line_spacing=${Math.round(h / 40)}:` +
      `borderw=3:bordercolor=black@0.45:shadowcolor=black@0.5:shadowx=2:shadowy=3:` +
      `x=(w-text_w)/2:y=(h-text_h)/2-h*0.03`
    );
  }
  if (subPath) {
    parts.push(
      `drawtext=fontfile=${FONT_PATH}:textfile=${subPath}:` +
      `fontcolor=white@0.9:fontsize=${Math.round(h / 36)}:` +
      `borderw=2:bordercolor=black@0.4:shadowcolor=black@0.4:shadowx=1:shadowy=2:` +
      `x=(w-text_w)/2:y=(h/2)+h*0.06`
    );
  }
  return parts.join(',');
}

app.post(
  '/api/render',
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'media', maxCount: 1 }]),
  (req, res) => {
    const audio = req.files && req.files.audio && req.files.audio[0];
    const media = req.files && req.files.media && req.files.media[0];

    if (!audio) {
      if (media) safeUnlink(media.path);
      return res.status(400).json({ error: '음악(WAV) 파일이 없습니다.' });
    }

    const duration = Math.max(1, parseFloat(req.body.duration) || 60);
    const fps = parseInt(req.body.fps, 10) === 60 ? 60 : 30;
    const resv = String(req.body.resolution).toLowerCase();
    let w = 1920, h = 1080, crf = 20, resLabel = '1080p';
    if (resv === '4k') { w = 3840; h = 2160; crf = 23; resLabel = '4k'; }
    else if (resv === '720p') { w = 1280; h = 720; crf = 20; resLabel = '720p'; }

    const jobId = crypto.randomBytes(8).toString('hex');
    const outFile = path.join(OUTPUTS, jobId + '.mp4');

    // 영상 메타데이터(제목/설명/태그) — 유튜브 업로드에 그대로 사용
    const meta = {
      id: jobId,
      title: (req.body.title || '').toString().trim() || '내 음악',
      description: (req.body.description || '').toString(),
      tags: (req.body.tags || '')
        .toString()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 30),
      theme: req.body.theme || null,
      preset: req.body.preset || null,
      keyword: (req.body.keyword || '').toString().trim() || null,
      durationSec: Math.round(duration),
      resolution: resLabel,
      createdAt: Date.now(),
      youtube: null,
    };

    const job = {
      status: 'processing',
      percent: 0,
      file: outFile,
      error: null,
      listeners: [],
      cleanup: [audio.path, media && media.path].filter(Boolean),
      meta,
    };
    jobs.set(jobId, job);

    // 즉시 jobId 응답 → 클라이언트는 SSE로 진행률 구독
    res.json({ jobId });

    const keyword = (req.body.keyword || '').toString().trim();
    const seedNum = parseInt(req.body.seed, 10) || 1;

    // ── 2단계 렌더: ① 짧은 배경 루프 클립만 인코딩 → ② 무한 루프하며 오디오와 합침(영상 복사)
    // 음악이 길어도 배경은 짧게만 인코딩하므로 ARM NAS에서도 빠름.
    // 그라데이션은 5초(이음새 없음), 실사 영상은 10초(컷 잦지 않게)로 인코딩.
    const basePath = path.join(UPLOADS, jobId + '_base.mp4');
    job.cleanup.push(basePath);

    function fail(err) {
      job.status = 'error';
      job.error = err && err.message ? err.message : String(err);
      notify(job);
      job.cleanup.forEach(safeUnlink);
    }

    // ── PASS 1: 배경 루프 클립 인코딩(소스 종류에 맞춰) ──
    function startPass1(srcKind, srcPath, loopSec) {
      const c1 = ffmpeg();
      if (srcKind === 'video' || srcKind === 'image') {
        c1.input(srcPath);
      } else {
        const theme = THEMES[req.body.theme] || THEMES.autumn_valley;
        c1
          .input(
            `gradients=s=640x360:c0=${theme.c0}:c1=${theme.c1}:` +
              `x0=0:y0=0:x1=640:y1=360:d=${loopSec}:speed=${theme.speed}`
          )
          .inputOptions(['-f', 'lavfi']);
      }

      const vf = buildVideoFilter({ kind: srcKind, w, h, fps, duration: loopSec, loopSec });
      let chain = vf;
      const overlayText = (req.body.overlayText || '').toString().trim();
      const subtitleText = (req.body.subtitle || '').toString().trim();
      if (overlayText || subtitleText) {
        let titlePath = null, subPath = null;
        try {
          if (overlayText) {
            titlePath = path.join(UPLOADS, jobId + '_title.txt');
            fs.writeFileSync(titlePath, wrapText(overlayText, 16));
            job.cleanup.push(titlePath);
          }
          if (subtitleText) {
            subPath = path.join(UPLOADS, jobId + '_sub.txt');
            fs.writeFileSync(subPath, spaceOut(subtitleText));
            job.cleanup.push(subPath);
          }
          const overlay = buildOverlay({ titlePath, subPath, h });
          if (overlay) chain = vf + ',' + overlay;
        } catch (_) { /* 실패 시 오버레이 없이 진행 */ }
      }

      c1
        .complexFilter([`[0:v]${chain}[vout]`])
        .outputOptions([
          '-map', '[vout]',
          '-an',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', String(crf),
          '-pix_fmt', 'yuv420p',
          '-profile:v', 'high',
          '-g', String(fps), // 매초 키프레임 → 루프 경계가 항상 키프레임(복사 루프 시 깔끔)
          '-r', String(fps),
          '-t', String(loopSec),
        ])
        .on('progress', (p) => {
          const sec = timemarkToSeconds(p.timemark);
          job.percent = Math.min(35, (sec / loopSec) * 35);
          notify(job);
        })
        .on('end', runPass2)
        .on('error', fail)
        .save(basePath);
    }

    // 배경 소스 선택: ① 업로드 파일 > ② 키워드(실사 스톡) > ③ 그라데이션 테마
    if (media) {
      const k = (media.mimetype || '').startsWith('image') ? 'image' : 'video';
      startPass1(k, media.path, 5);
    } else if (keyword && stock.isConfigured()) {
      // 키워드 → 실사 영상 검색·다운로드. 실패하면 그라데이션으로 폴백.
      job.note = '실사 영상 찾는 중…';
      notify(job);
      stock
        .search(keyword, { targetW: w, seed: seedNum })
        .then((found) => {
          if (!found) throw new Error('검색 결과 없음');
          const stockPath = path.join(UPLOADS, jobId + '_stock.mp4');
          job.cleanup.push(stockPath);
          job.meta.stock = {
            source: found.source, query: keyword,
            author: found.author, authorUrl: found.authorUrl, pageUrl: found.pageUrl,
          };
          job.note = '영상 내려받는 중…';
          notify(job);
          return stock.download(found.url, stockPath).then(() => {
            job.note = '인코딩 중…';
            notify(job);
            startPass1('video', stockPath, 10);
          });
        })
        .catch(() => { job.note = null; startPass1('gradient', null, 5); });
    } else {
      startPass1('gradient', null, 5);
    }

    // ── PASS 2: 5초 클립을 무한 루프 + 오디오 합치기(영상 스트림 복사 → 빠름) ──
    function runPass2() {
      ffmpeg()
        .input(basePath)
        .inputOptions(['-stream_loop', '-1'])
        .input(audio.path)
        .outputOptions([
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy', // 재인코딩 없음 → 길이와 무관하게 빠름
          '-c:a', 'aac',
          '-b:a', '320k',
          '-ar', '48000',
          '-ac', '2',
          '-t', String(duration),
          '-shortest',
          '-movflags', '+faststart',
        ])
        .on('progress', (p) => {
          const sec = timemarkToSeconds(p.timemark);
          job.percent = Math.min(99, 35 + (sec / duration) * 64);
          notify(job);
        })
        .on('end', () => {
          job.status = 'done';
          job.percent = 100;
          writeMeta(jobId, job.meta);
          notify(job);
          job.cleanup.forEach(safeUnlink); // 임시 업로드 + 5초 base 클립 정리(결과물은 유지)
        })
        .on('error', fail)
        .save(outFile);
    }
  }
);

// 진행률 SSE
app.get('/api/progress/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders && res.flushHeaders();

  if (!job) {
    res.write(`data: ${JSON.stringify({ status: 'error', error: '알 수 없는 작업입니다.' })}\n\n`);
    return res.end();
  }

  const send = (payload) => {
    res.write(`data: ${payload}\n\n`);
    if (job.status === 'done' || job.status === 'error') {
      res.end();
    }
  };
  job.listeners.push(send);

  // 현재 상태 즉시 1회 전송
  notify(job);

  req.on('close', () => {
    const i = job.listeners.indexOf(send);
    if (i >= 0) job.listeners.splice(i, 1);
  });
});

// 결과 MP4 다운로드 (영구 저장본에서 직접 — 서버 재시작 후에도 동작)
app.get('/api/download/:id', (req, res) => {
  const id = req.params.id;
  if (!isValidId(id) || !fs.existsSync(videoPath(id))) {
    return res.status(404).send('결과 파일을 찾을 수 없습니다.');
  }
  const name = req.query.name ? String(req.query.name) : `music-${id}.mp4`;
  res.download(videoPath(id), name);
});

// 갤러리: NAS에 저장된 영상 목록
app.get('/api/videos', (req, res) => {
  res.json({ videos: listVideos(), youtube: { configured: youtube.isConfigured() } });
});

// 영상 인라인 재생/스트리밍
app.get('/api/videos/:id/file', (req, res) => {
  const id = req.params.id;
  if (!isValidId(id) || !fs.existsSync(videoPath(id))) return res.status(404).end();
  res.type('video/mp4');
  fs.createReadStream(videoPath(id)).pipe(res);
});

// 영상 삭제
app.delete('/api/videos/:id', (req, res) => {
  const id = req.params.id;
  if (!isValidId(id)) return res.status(400).json({ error: '잘못된 ID' });
  safeUnlink(videoPath(id));
  safeUnlink(metaPath(id));
  res.json({ ok: true });
});

// 유튜브 연결 상태
app.get('/api/youtube/status', (req, res) => {
  res.json({ configured: youtube.isConfigured() });
});

// 유튜브 업로드 (자격 증명이 설정돼 있을 때만)
app.post('/api/videos/:id/youtube', async (req, res) => {
  const id = req.params.id;
  if (!isValidId(id) || !fs.existsSync(videoPath(id))) {
    return res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
  }
  if (!youtube.isConfigured()) {
    return res.status(400).json({
      error: 'YouTube가 아직 연결되지 않았습니다. 서버 환경변수 YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN을 설정하세요.',
      needsSetup: true,
    });
  }
  const meta = readMeta(id) || {};
  const body = req.body || {};
  const title = (body.title || meta.title || '내 음악').toString();
  const description = (body.description || meta.description || '').toString();
  const tags = Array.isArray(body.tags)
    ? body.tags
    : (body.tags || (meta.tags || []).join(','))
        .toString()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  const privacyStatus = ['public', 'unlisted', 'private'].includes(body.privacy) ? body.privacy : 'private';

  try {
    const result = await youtube.uploadVideo({
      filePath: videoPath(id),
      title,
      description,
      tags,
      privacyStatus,
    });
    meta.youtube = { uploaded: true, id: result.id, url: result.url, privacy: privacyStatus, uploadedAt: Date.now() };
    meta.title = title;
    meta.description = description;
    meta.tags = tags;
    writeMeta(id, meta);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// AI/템플릿 메타데이터 생성 (제목·해시태그·설명)
app.post('/api/metadata/generate', async (req, res) => {
  try {
    const md = await metadata.generate({
      preset: req.body.preset,
      theme: req.body.theme,
      durationSec: parseFloat(req.body.durationSec) || 180,
      seed: parseInt(req.body.seed, 10) || 1,
    });
    res.json(md);
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

// 키워드로 실사 영상 미리보기 (렌더 전에 어떤 영상이 잡히는지 확인)
app.get('/api/stock/search', async (req, res) => {
  if (!stock.isConfigured()) {
    return res.status(400).json({ error: '실사 영상이 아직 연결되지 않았습니다. 서버에 PEXELS_API_KEY 또는 PIXABAY_API_KEY를 설정하세요.', needsSetup: true });
  }
  const keyword = (req.query.keyword || '').toString().trim();
  if (!keyword) return res.status(400).json({ error: '키워드를 입력하세요.' });
  const seed = parseInt(req.query.seed, 10) || 1;
  try {
    const found = await stock.search(keyword, { targetW: 1920, seed });
    if (!found) return res.status(404).json({ error: '결과가 없습니다. 다른 키워드(영어가 더 정확)로 시도하세요.' });
    // 직접 mp4 링크는 노출하지 않고, 미리보기 썸네일·출처만 전달
    res.json({ image: found.image, author: found.author, source: found.source, pageUrl: found.pageUrl, duration: found.duration, query: keyword, searchQuery: found.searchQuery });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    ffmpeg: ffmpegPath,
    youtube: youtube.isConfigured(),
    stock: stock.isConfigured(),
    metadataProvider: process.env.METADATA_PROVIDER || 'template',
  });
});

app.listen(PORT, HOST, () => {
  console.log('\n  🎵  AI Music Studio');
  console.log(`  ▶  로컬:       http://localhost:${PORT}`);
  console.log(`  ▶  같은 네트워크(LAN/휴대폰): http://<이 서버의 IP>:${PORT}`);
  if (AUTH_USER && AUTH_PASS) console.log('  🔒  Basic 인증 활성화됨');
  console.log('');
});
