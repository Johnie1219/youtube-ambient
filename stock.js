'use strict';

/**
 * 실사 스톡 영상 검색/다운로드 — Pexels 또는 Pixabay (무료).
 *
 * 키워드로 실제 촬영 영상을 가져온다. 둘 중 "아무 키나" 있으면 작동하며,
 * 둘 다 있으면 Pexels를 우선 사용한다.
 *
 *   - Pexels:  PEXELS_API_KEY   (발급: https://www.pexels.com/api/)
 *   - Pixabay: PIXABAY_API_KEY  (발급: https://pixabay.com/api/docs/ — 가입 시 키가 즉시 표시됨)
 *
 * 키가 없거나 결과가 없으면 null을 돌려주고, 서버는 그라데이션 배경으로 폴백한다.
 * 외부 의존성 없이 Node 내장 https 사용.
 */

const https = require('https');
const fs = require('fs');

function provider() {
  if (process.env.PEXELS_API_KEY) return 'pexels';
  if (process.env.PIXABAY_API_KEY) return 'pixabay';
  return null;
}
function isConfigured() {
  return !!provider();
}

function hasHangul(s) {
  return /[가-힣]/.test(String(s || ''));
}

// 한글 키워드 → 영어(스톡 검색 정확도↑). 자주 쓰는 풍경/무드 어휘 사전.
// 띄어쓰기 없이 붙여 써도("바다노을펜션") 부분 치환으로 잡히게 긴 단어부터 적용.
const KO_EN = {
  '바다': 'ocean', '바닷가': 'seaside', '해변': 'beach', '파도': 'waves', '섬': 'island',
  '노을': 'sunset', '일몰': 'sunset', '석양': 'sunset', '해돋이': 'sunrise', '일출': 'sunrise',
  '펜션': 'villa', '리조트': 'resort', '호텔': 'hotel', '통창': 'window ocean view', '창문': 'window', '창가': 'window',
  '숲': 'forest', '나무': 'trees', '산': 'mountain', '계곡': 'valley', '강': 'river', '호수': 'lake', '폭포': 'waterfall',
  '비': 'rain', '빗소리': 'rain', '눈': 'snow', '안개': 'fog', '구름': 'clouds', '하늘': 'sky', '별': 'starry sky', '오로라': 'aurora',
  '도시': 'city', '야경': 'city night', '밤': 'night', '거리': 'street', '골목': 'alley', '빌딩': 'buildings', '네온': 'neon city',
  '카페': 'cafe', '커피': 'coffee', '책': 'books', '독서': 'reading',
  '드라이브': 'driving', '자동차': 'car', '도로': 'road', '기차': 'train', '비행기': 'airplane', '공항': 'airport',
  '캠핑': 'camping', '모닥불': 'campfire', '벽난로': 'fireplace', '난로': 'fireplace',
  '꽃': 'flowers', '벚꽃': 'cherry blossom', '단풍': 'autumn leaves',
  '봄': 'spring', '여름': 'summer', '가을': 'autumn', '겨울': 'winter',
  '아침': 'morning', '새벽': 'dawn', '저녁': 'evening', '햇살': 'sunlight', '햇빛': 'sunlight',
  '도쿄': 'tokyo', '서울': 'seoul', '파리': 'paris', '뉴욕': 'new york',
};
const KO_KEYS = Object.keys(KO_EN).sort((a, b) => b.length - a.length);

// 한글이 섞인 키워드를 영어로 치환. 매칭 안 된 한글은 그대로 둔다.
function translate(q) {
  let s = ' ' + q + ' ';
  for (const k of KO_KEYS) {
    if (s.indexOf(k) >= 0) s = s.split(k).join(' ' + KO_EN[k] + ' ');
  }
  return s.replace(/\s+/g, ' ').trim();
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
    const req = https.get(url, { headers: headers || {} }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error('스톡 HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('스톡 응답 파싱 실패')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('스톡 검색 시간 초과')));
  });
}

// 목표 폭(targetW)에 가장 알맞은 파일을 고른다: 충분히 크면서 과하지 않게.
function bestByWidth(files, targetW) {
  const ok = files.filter((f) => f.url && (f.width || 0) > 0);
  if (!ok.length) return null;
  const sorted = ok.slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  return sorted.find((f) => (f.width || 0) >= targetW) || sorted[sorted.length - 1];
}

// ── Pexels ────────────────────────────────────────────────────────
async function searchPexels(q, targetW, seed) {
  const tq = translate(q);
  const params = new URLSearchParams({ query: tq, per_page: '20', orientation: 'landscape', size: 'medium' });
  if (hasHangul(tq)) params.set('locale', 'ko-KR');
  const json = await getJson('https://api.pexels.com/videos/search?' + params.toString(), {
    Authorization: process.env.PEXELS_API_KEY,
  });
  const videos = (json && json.videos) || [];
  const usable = videos.filter((v) => (v.width || 0) >= (v.height || 0) && (v.duration || 0) >= 4);
  const pool = usable.length ? usable : videos;
  if (!pool.length) return null;
  const rng = mulberry32(seed ^ (q.length * 2654435761));
  const video = pool[Math.floor(rng() * pool.length)];
  const files = (video.video_files || []).filter((f) => /mp4/i.test(f.file_type || ''));
  const file = bestByWidth(files, targetW);
  if (!file) return null;
  return {
    source: 'pexels', url: file.link, width: file.width || null, height: file.height || null,
    duration: video.duration || null, author: (video.user && video.user.name) || 'Pexels',
    authorUrl: (video.user && video.user.url) || 'https://www.pexels.com',
    pageUrl: video.url || 'https://www.pexels.com', image: video.image || null,
    query: q, searchQuery: tq,
  };
}

// ── Pixabay ───────────────────────────────────────────────────────
async function searchPixabay(q, targetW, seed) {
  const tq = translate(q);
  const base = {
    key: process.env.PIXABAY_API_KEY, q: tq, per_page: '40',
    video_type: 'film', safesearch: 'true', order: 'popular',
  };
  if (hasHangul(tq)) base.lang = 'ko';
  const fetchHits = async (extra) => {
    const p = new URLSearchParams(Object.assign({}, base, extra));
    const json = await getJson('https://pixabay.com/api/videos/?' + p.toString());
    return (json && json.hits) || [];
  };
  // ① 에디터 추천(큐레이션=아름다운 클립) + ② 일반 인기순을 합쳐 후보 풀 구성(중복 제거)
  let hits = await fetchHits({ editors_choice: 'true' });
  const seen = new Set(hits.map((h) => h.id));
  for (const h of await fetchHits({})) if (!seen.has(h.id)) hits.push(h);
  if (!hits.length) return null;
  // 가로·HD·충분한 길이 우선(밋밋한 세로/저화질 제외)
  const nice = hits.filter((h) => (h.videos && (h.videos.large || h.videos.medium)) && (h.duration || 0) >= 5);
  let pool = nice.length ? nice : hits;
  // 관련도: 클립 태그에 검색어 단어가 들어간 개수로 점수 → 가장 잘 맞는 클립만 남김.
  // ("city night drive"에서 drive 태그까지 있는 영상을 우선 → 엉뚱한 결과 줄임)
  const words = tq.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length) {
    const score = (h) => { const t = (h.tags || '').toLowerCase(); return words.reduce((n, w) => n + (t.indexOf(w) >= 0 ? 1 : 0), 0); };
    const maxS = pool.reduce((m, h) => Math.max(m, score(h)), 0);
    if (maxS > 0) pool = pool.filter((h) => score(h) >= maxS);
  }
  const rng = mulberry32(seed ^ (q.length * 2654435761));
  const hit = pool[Math.floor(rng() * pool.length)];
  const sizes = hit.videos || {};
  const files = Object.keys(sizes).map((k) => sizes[k]).filter(Boolean);
  const file = bestByWidth(files, targetW);
  if (!file) return null;
  const image = file.thumbnail || (hit.picture_id ? `https://i.vimeocdn.com/video/${hit.picture_id}_640x360.jpg` : null);
  return {
    source: 'pixabay', url: file.url, width: file.width || null, height: file.height || null,
    duration: hit.duration || null, author: hit.user || 'Pixabay',
    authorUrl: hit.pageURL || 'https://pixabay.com', pageUrl: hit.pageURL || 'https://pixabay.com',
    image, query: q, searchQuery: tq,
  };
}

/**
 * 키워드로 실사 영상 1개를 검색해 메타+직접 mp4 링크를 돌려준다.
 * @returns {Promise<null | {source,url,width,height,duration,author,authorUrl,pageUrl,image,query}>}
 */
async function search(keyword, opts) {
  const p = provider();
  if (!p) return null;
  const o = opts || {};
  const q = String(keyword || '').trim();
  if (!q) return null;
  const targetW = o.targetW || 1920;
  const seed = (o.seed >>> 0) || 1;
  return p === 'pexels' ? searchPexels(q, targetW, seed) : searchPixabay(q, targetW, seed);
}

// 직접 mp4/mp3 링크를 파일로 내려받는다(리다이렉트 추적, 선택적 헤더 — 핫링크 보호 우회용).
function download(url, destPath, redirects, headers) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 5) return reject(new Error('리다이렉트 과다'));
    const req = https.get(url, { headers: headers || {} }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, destPath, (redirects || 0) + 1, headers));
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
    req.setTimeout(180000, () => req.destroy(new Error('다운로드 시간 초과')));
  });
}

module.exports = { isConfigured, provider, search, download };
