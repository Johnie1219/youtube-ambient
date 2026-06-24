'use strict';

/**
 * 가을 계곡 앰비언트 → 유튜브 MP4 메이커 (로컬 웹앱)
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

// 작업/업로드용 임시 폴더
const WORK = path.join(os.tmpdir(), 'youtube-ambient');
const UPLOADS = path.join(WORK, 'uploads');
const OUTPUTS = path.join(WORK, 'outputs');
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(OUTPUTS, { recursive: true });

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB
});

// 정적 파일
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'tone', 'build')));
app.use(express.static(path.join(__dirname, 'public')));

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
  // 영상 클립 또는 gradients 폴백 공통 처리
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

    const job = {
      status: 'processing',
      percent: 0,
      file: outFile,
      error: null,
      listeners: [],
      cleanup: [audio.path, media && media.path].filter(Boolean),
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
      // 가을톤 그라데이션 자동 생성 (deep forest green → warm amber). 2색 = 모든 빌드 호환.
      cmd
        .input(
          `gradients=s=${w}x${h}:c0=0x16281c:c1=0x4a3410:` +
            `x0=0:y0=0:x1=${w}:y1=${h}:d=${Math.ceil(duration)}:speed=0.006`
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
        notify(job);
        job.cleanup.forEach(safeUnlink);
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

// 결과 MP4 다운로드
app.get('/api/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !fs.existsSync(job.file)) {
    return res.status(404).send('결과 파일을 찾을 수 없습니다.');
  }
  const name = req.query.name ? String(req.query.name) : `autumn-ambient-${req.params.id}.mp4`;
  res.download(job.file, name);
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ffmpeg: ffmpegPath });
});

app.listen(PORT, HOST, () => {
  console.log('\n  🍂  가을 계곡 앰비언트 → 유튜브 MP4 메이커');
  console.log(`  ▶  로컬:       http://localhost:${PORT}`);
  console.log(`  ▶  같은 네트워크(LAN/휴대폰): http://<이 서버의 IP>:${PORT}`);
  if (AUTH_USER && AUTH_PASS) console.log('  🔒  Basic 인증 활성화됨');
  console.log('');
});
