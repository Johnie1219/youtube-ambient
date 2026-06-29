'use strict';

/**
 * 메타데이터(제목·해시태그·설명) 생성기 — "플러그형" 제공자 구조.
 *
 * 제공자 선택: 환경변수 METADATA_PROVIDER
 *   - 'template' (기본·무료): 테마/장르 기반 규칙 생성
 *   - 'claude'  : ANTHROPIC_API_KEY 필요 (최고 품질·유료)
 *   - 'ollama'  : OLLAMA_URL(예: http://localhost:11434) + OLLAMA_MODEL — NAS 로컬 AI(무료, 느림)
 *
 * 외부 의존성 없이 Node 내장 https/http 사용. 실패 시 항상 template로 폴백.
 */

const https = require('https');
const http = require('http');

// 테마(=음악 프리셋) → 메타데이터 시드. 키는 ambient-engine.js의 프리셋 키와 맞춤.
const SEEDS = {
  boom_drive:     { emoji: '🔥', ko: '두둠칫 드라이브', genre: '신나는 드라이브 그루브', en: 'Bright Drive Groove', moods: ['신나는', '밝은', '청량한'], benefits: ['드라이브', '운동', '기분전환', '출퇴근'], tags: ['드라이브', '플레이리스트', '신나는노래', '그루브', 'playlist', 'driving', 'citypop', 'funk', 'groove', 'upbeat'] },
  autumn_valley:  { emoji: '🌅', ko: '포근한 앰비언트', genre: '앰비언트', en: 'Warm Ambient', moods: ['잔잔한', '따뜻한', '포근한'], benefits: ['스트레스 해소', '수면', '집중', '휴식'], tags: ['앰비언트', '휴식음악', '수면음악', '집중음악', 'ambient', 'relaxing', 'sleep music', 'study music', 'calm', 'lofi'] },
  misty_dawn:     { emoji: '🌫️', ko: '새벽 안개 앰비언트', genre: '앰비언트', en: 'Misty Dawn Ambient', moods: ['몽환적인', '고요한', '맑은'], benefits: ['명상', '수면', '아침 루틴', '집중'], tags: ['앰비언트', '명상음악', '수면음악', '새벽', 'ambient', 'meditation', 'calm', 'sleep', 'morning', 'relax'] },
  rainy_valley:   { emoji: '🌧️', ko: '비 오는 날 앰비언트', genre: '빗소리 앰비언트', en: 'Rainy Ambient', moods: ['차분한', '사색적인', '포근한'], benefits: ['수면', '집중', '불면 완화', '휴식'], tags: ['빗소리', '앰비언트', '수면음악', 'ASMR', 'rain sounds', 'ambient', 'sleep', 'study', 'relaxing', 'rain'] },
  firelight_night:{ emoji: '🔥', ko: '모닥불 밤 앰비언트', genre: '앰비언트', en: 'Cozy Fireplace Ambient', moods: ['포근한', '따뜻한', '아늑한'], benefits: ['수면', '휴식', '독서'], tags: ['모닥불', '앰비언트', '수면음악', 'fireplace', 'cozy', 'ambient', 'sleep', 'relax', 'winter', 'reading'] },
  city_drive:     { emoji: '🚗', ko: '시티 드라이브 플레이리스트', genre: '시티팝 그루브', en: 'City Pop Drive', moods: ['신나는', '그루비한', '청량한'], benefits: ['드라이브', '기분전환', '운동', '출퇴근'], tags: ['시티팝', '드라이브', '플레이리스트', 'citypop', 'groove', 'funk', 'playlist', 'driving', 'kpop', 'chill'] },
  funky_sunset:   { emoji: '🌆', ko: '펑키 선셋 그루브', genre: '펑크·소울 그루브', en: 'Funky Sunset Groove', moods: ['그루비한', '나른한', '세련된'], benefits: ['드라이브', '카페', '기분전환'], tags: ['펑크', '소울', '그루브', 'funk', 'soul', 'groove', 'playlist', 'citypop', 'chill', 'lofi'] },
  dreamy_synth:   { emoji: '✨', ko: '드리미 신스', genre: '드림 신스 앰비언트', en: 'Dreamy Synth Ambient', moods: ['몽환적인', '밝은', '포근한'], benefits: ['집중', '휴식', '공부', '명상'], tags: ['앰비언트', '신스', '집중음악', '공부음악', 'ambient', 'synthwave', 'dreamy', 'study', 'chill', 'relax'] },
  deep_sleep:     { emoji: '🌙', ko: '깊은 수면', genre: '딥 슬립 앰비언트', en: 'Deep Sleep Ambient', moods: ['고요한', '깊은', '편안한'], benefits: ['수면', '불면 완화', '명상', '휴식'], tags: ['수면음악', '잠잘때듣는음악', '불면증', '앰비언트', 'sleep music', 'deep sleep', 'insomnia', 'ambient', 'calm', 'meditation'] },
  lofi_rain:      { emoji: '🌧️', ko: '로파이 칠', genre: 'Lo-fi 힙합', en: 'Lo-fi Chill', moods: ['나른한', '편안한', '재지한'], benefits: ['공부', '집중', '작업', '휴식'], tags: ['로파이', 'lofi', '공부음악', '집중음악', 'lofi hiphop', 'chill', 'study', 'beats', 'relax', 'cafe'] },
  night_city:     { emoji: '🌃', ko: '나이트 시티 시티팝', genre: '시티팝', en: 'City Pop Night', moods: ['세련된', '그루비한', '도시적인'], benefits: ['드라이브', '밤', '기분전환', '카페'], tags: ['시티팝', 'citypop', '플레이리스트', 'playlist', 'citypop night', 'groove', 'chill', 'kpop', 'jpop', 'driving'] },
};
const DEFAULT_SEED = SEEDS.autumn_valley;

function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function pick2(rng, arr) {
  const a = pick(rng, arr);
  let b = pick(rng, arr); let guard = 0;
  while (b === a && guard++ < 5) b = pick(rng, arr);
  return [a, b];
}

function generateTemplate(presetKey, durationSec, seed) {
  const s = SEEDS[presetKey] || DEFAULT_SEED;
  const rng = mulberry32((seed || 1) ^ (presetKey ? presetKey.length * 7919 : 1));
  const mood = pick(rng, s.moods);
  const [b1, b2] = pick2(rng, s.benefits);
  const descriptor = pick(rng, ['음악', '플레이리스트', '연주곡', 'BGM']);

  const title = `${s.emoji} ${mood} ${s.genre} | ${b1}·${b2}을 위한 ${descriptor} | ${s.en}`.slice(0, 100);

  const tags = s.tags.slice();

  const benefitsLine = s.benefits.slice(0, 3).join(', ');
  const hashline = s.tags.slice(0, 6).map((t) => '#' + t.replace(/\s+/g, '')).join(' ');
  const description =
    `${s.emoji} ${s.ko}\n` +
    `${mood} ${s.genre}으로 채운 ${descriptor}예요. ${b1}, ${b2}에 함께하세요.\n\n` +
    `🎧 ${benefitsLine}에 좋은 음악입니다.\n` +
    `🎵 코드로 직접 생성한 오리지널 사운드 — 저작권 걱정 없이 자유롭게 즐기세요.\n\n` +
    `${hashline}\n\n` +
    `▶ 채널을 구독하면 새로운 플레이리스트를 가장 먼저 받아볼 수 있어요.`;

  return { title, tags, description, provider: 'template' };
}

function buildPrompt(presetKey, durationSec) {
  const s = SEEDS[presetKey] || DEFAULT_SEED;
  return (
    `너는 유튜브 음악 채널 SEO 전문가야. 아래 정보로 클릭률 높은 한국 유튜브 음악 영상의 메타데이터를 만들어줘.\n` +
    `- 장르/분위기: ${s.genre} (${s.moods.join(', ')})\n` +
    `- 용도: ${s.benefits.join(', ')}\n` +
    `- 길이: 약 ${Math.round((durationSec || 180) / 60)}분\n` +
    `- 음악은 코드로 생성한 오리지널(저작권 free).\n` +
    `반드시 아래 JSON만 출력(설명 금지):\n` +
    `{"title": "100자 이내, 이모지+한글+영문 병기, 효익 포함", "tags": ["12~15개 키워드, 한/영 혼합"], "description": "5~8줄, 분위기 1줄 + 용도 + 오리지널 안내 + 해시태그 줄 + 구독 유도"}`
  );
}

function httpJson(mod, options, body) {
  return new Promise((resolve, reject) => {
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 300)));
        resolve(data);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function extractJson(text) {
  const a = text.indexOf('{'); const b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('JSON 파싱 실패');
  const obj = JSON.parse(text.slice(a, b + 1));
  return {
    title: String(obj.title || '').slice(0, 100),
    tags: Array.isArray(obj.tags) ? obj.tags.map(String).slice(0, 20) : [],
    description: String(obj.description || ''),
  };
}

async function generateClaude(presetKey, durationSec) {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const body = JSON.stringify({
    model, max_tokens: 1024,
    messages: [{ role: 'user', content: buildPrompt(presetKey, durationSec) }],
  });
  const raw = await httpJson(https, {
    host: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(body) },
  }, body);
  const j = JSON.parse(raw);
  const text = (j.content && j.content[0] && j.content[0].text) || '';
  return Object.assign(extractJson(text), { provider: 'claude' });
}

async function generateOllama(presetKey, durationSec) {
  const url = new URL(process.env.OLLAMA_URL || 'http://localhost:11434');
  const model = process.env.OLLAMA_MODEL || 'llama3.2';
  const body = JSON.stringify({ model, prompt: buildPrompt(presetKey, durationSec), stream: false, format: 'json' });
  const raw = await httpJson(url.protocol === 'https:' ? https : http, {
    host: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: '/api/generate', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  }, body);
  const j = JSON.parse(raw);
  return Object.assign(extractJson(j.response || ''), { provider: 'ollama' });
}

async function generate(opts) {
  const presetKey = opts.preset || 'autumn_valley';
  const durationSec = opts.durationSec || 180;
  const provider = (process.env.METADATA_PROVIDER || 'template').toLowerCase();
  try {
    if (provider === 'claude' && process.env.ANTHROPIC_API_KEY) return await generateClaude(presetKey, durationSec);
    if (provider === 'ollama') return await generateOllama(presetKey, durationSec);
  } catch (e) {
    // AI 실패 시 조용히 템플릿 폴백
    const t = generateTemplate(presetKey, durationSec, opts.seed);
    t.provider = 'template(fallback: ' + (e.message || 'error').slice(0, 60) + ')';
    return t;
  }
  return generateTemplate(presetKey, durationSec, opts.seed);
}

module.exports = { generate, SEEDS };
