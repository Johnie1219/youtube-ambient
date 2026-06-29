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

// ffmpeg 경로: FFMPEG_PATH(예: Docker의 /usr/bin/ffmpeg)가 있으면 우선, 없으면 번들(ffmpeg-static)
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

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

function buildVideoFilter({ kind, w, h, fps, duration }) {
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
    // 자동 테마 배경: gradients 소스가 이미 WxH로 생성되므로 스케일 불필요.
    // 색을 천천히 흐르게(소스 speed) + 10초 주기의 은은한 밝기/채도 호흡 + 비네팅.
    // sin은 매 프레임 평가되어야 하므로 eq에 eval=frame 지정(기본은 init이라 정지함).
    return (
      `eq=brightness='0.05*sin(2*PI*t/10)':saturation='1.06+0.10*sin(2*PI*t/10)':eval=frame,` +
      `vignette,` +
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
    const res4k = String(req.body.resolution).toLowerCase() === '4k';
    const w = res4k ? 3840 : 1920;
    const h = res4k ? 2160 : 1080;
    const crf = res4k ? 20 : 18;

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
      durationSec: Math.round(duration),
      resolution: res4k ? '4k' : '1080p',
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

    let mediaKind = 'gradient';
    if (media) {
      if ((media.mimetype || '').startsWith('video')) mediaKind = 'video';
      else if ((media.mimetype || '').startsWith('image')) mediaKind = 'image';
    }

    const cmd = ffmpeg();

    // 입력 0: 영상 소스
    if (mediaKind === 'video') {
      cmd.input(media.path).inputOptions(['-stream_loop', '-1']); // 음악 길이까지 무한 루프
    } else if (mediaKind === 'image') {
      // 단일 이미지 입력 → zoompan이 직접 프레임을 생성(켄번스). -loop 금지.
      cmd.input(media.path);
    } else {
      // 자동 테마 배경: 선택한 테마의 2색 그라데이션을 음악 길이만큼 연속 생성(이음새 없음).
      const theme = THEMES[req.body.theme] || THEMES.autumn_valley;
      cmd
        .input(
          `gradients=s=${w}x${h}:c0=${theme.c0}:c1=${theme.c1}:` +
            `x0=0:y0=0:x1=${w}:y1=${h}:d=${Math.ceil(duration)}:speed=${theme.speed}`
        )
        .inputOptions(['-f', 'lavfi']);
    }

    // 입력 1: 음악
    cmd.input(audio.path);

    const vf = buildVideoFilter({ kind: mediaKind, w, h, fps, duration });

    cmd
      .complexFilter([`[0:v]${vf}[vout]`])
      .outputOptions([
        '-map', '[vout]',
        '-map', '1:a:0',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', String(crf),
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'high',
        '-level', '4.2',
        '-g', String(fps * 2),
        '-r', String(fps),
        '-c:a', 'aac',
        '-b:a', '320k',
        '-ar', '48000',
        '-ac', '2',
        '-t', String(duration),
        '-shortest',
        '-movflags', '+faststart',
      ])
      .on('start', (line) => {
        job.commandLine = line;
      })
      .on('progress', (p) => {
        const sec = timemarkToSeconds(p.timemark);
        job.percent = Math.min(99, (sec / duration) * 100);
        notify(job);
      })
      .on('end', () => {
        job.status = 'done';
        job.percent = 100;
        writeMeta(jobId, job.meta); // NAS에 메타데이터 저장(영상은 OUTPUT_DIR에 영구 보존)
        notify(job);
        job.cleanup.forEach(safeUnlink); // 임시 업로드(오디오/영상)만 정리, 결과물은 유지
      })
      .on('error', (err) => {
        job.status = 'error';
        job.error = err && err.message ? err.message : String(err);
        notify(job);
        job.cleanup.forEach(safeUnlink);
      })
      .save(outFile);
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

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ffmpeg: ffmpegPath,
    youtube: youtube.isConfigured(),
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
