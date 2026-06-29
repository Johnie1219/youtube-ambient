'use strict';

/**
 * 실사 스톡 영상 검색/다운로드 — Pexels Video API.
 *
 * 무료 API 키 1개만 있으면 키워드로 실제 촬영 영상을 가져온다.
 *   - 발급: https://www.pexels.com/api/ (무료, 가입 후 키 복사)
 *   - 환경변수 PEXELS_API_KEY 에 넣으면 활성화됨.
 * 키가 없거나 검색 결과가 없으면 null을 돌려주고, 서버는 기존 그라데이션 배경으로 폴백한다.
 *
 * 외부 의존성 없이 Node 내장 https 사용.
 */

const https = require('https');
const fs = require('fs');

function isConfigured() {
  return !!process.env.PEXELS_API_KEY;
}

function hasHangul(s) {
  return /[가-힣]/.test(String(s || ''));
}

// 시드 기반 PRNG — 같은 (키워드, 시드)면 같은 클립을 고르도록.
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error('Pexels HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Pexels 응답 파싱 실패')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('Pexels 검색 시간 초과')));
  });
}

// 한 영상의 video_files 중 목표 폭(targetW)에 가장 알맞은 mp4를 고른다.
function pickFile(video, targetW) {
  const files = (video.video_files || []).filter((f) => /mp4/i.test(f.file_type || '') && f.link);
  if (!files.length) return null;
  // 목표 폭 이상 중 가장 작은 것(=충분히 크면서 과하지 않음). 없으면 가장 큰 것.
  const sorted = files.slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  const atLeast = sorted.find((f) => (f.width || 0) >= targetW);
  return atLeast || sorted[sorted.length - 1];
}

/**
 * 키워드로 실사 영상 1개를 검색해 메타+직접 mp4 링크를 돌려준다.
 * @returns {Promise<null | {url, width, height, duration, author, authorUrl, pexelsUrl, image, query}>}
 */
async function search(keyword, opts) {
  if (!isConfigured()) return null;
  const o = opts || {};
  const q = String(keyword || '').trim();
  if (!q) return null;
  const targetW = o.targetW || 1920;
  const seed = (o.seed >>> 0) || 1;

  const params = new URLSearchParams({
    query: q,
    per_page: '20',
    orientation: 'landscape',
    size: 'medium',
  });
  if (hasHangul(q)) params.set('locale', 'ko-KR');

  const json = await getJson(
    'https://api.pexels.com/videos/search?' + params.toString(),
    { Authorization: process.env.PEXELS_API_KEY }
  );
  const videos = (json && json.videos) || [];
  // 가로 영상 + 충분한 길이(>=4s) 우선
  const usable = videos.filter((v) => (v.width || 0) >= (v.height || 0) && (v.duration || 0) >= 4);
  const pool = usable.length ? usable : videos;
  if (!pool.length) return null;

  const rng = mulberry32(seed ^ (q.length * 2654435761));
  const video = pool[Math.floor(rng() * pool.length)];
  const file = pickFile(video, targetW);
  if (!file) return null;

  return {
    url: file.link,
    width: file.width || null,
    height: file.height || null,
    duration: video.duration || null,
    author: (video.user && video.user.name) || 'Pexels',
    authorUrl: (video.user && video.user.url) || 'https://www.pexels.com',
    pexelsUrl: video.url || 'https://www.pexels.com',
    image: video.image || null,
    query: q,
  };
}

// 직접 mp4 링크를 파일로 내려받는다(리다이렉트 추적).
function download(url, destPath, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 5) return reject(new Error('리다이렉트 과다'));
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, destPath, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('다운로드 HTTP ' + res.statusCode));
      }
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(destPath)));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('다운로드 시간 초과')));
  });
}

module.exports = { isConfigured, search, download };
