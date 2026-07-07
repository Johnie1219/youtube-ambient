'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  // PWA 서비스 워커 (보안 컨텍스트에서만)
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // 상태
  let wavBlob = null, wavUrl = null, audioDuration = 0;
  let ytConfigured = false;
  let sourceMode = 'keyword'; // 'keyword'(실사 영상) | 'upload'(내 파일)
  let musicMode = 'upload';   // 'upload'(내 음악 파일) | 'generate'(코드 생성)
  let uploadedAudioFile = null;
  let sunoTracks = [];        // 가져온 Suno 곡 [{id, name, duration}]
  let selectedSunoId = null;  // 선택된 Suno 곡 id (파일 업로드보다 우선)
  let stockSeed = Math.floor(Math.random() * 1e9); // 실사 영상 선택 시드(미리보기 때마다 새로)

  const THEME_LABELS = {
    autumn_valley: '포근한 숲',
    golden_sunset: '황금 노을',
    misty_dawn: '새벽 안개',
    rosewood_night: '모닥불 밤',
    forest_emerald: '숲 에메랄드',
    dreamy_violet: '드리미 바이올렛',
    deep_indigo: '딥 인디고',
    lofi_dusk: '로파이 더스크',
    neon_city: '네온 시티',
  };

  // ── 프리셋 ────────────────────────────────────────────────
  const presetSel = $('preset');
  const presets = AmbientEngine.PRESETS;
  Object.keys(presets).forEach((key) => {
    const o = document.createElement('option');
    o.value = key; o.textContent = presets[key].name;
    presetSel.appendChild(o);
  });
  function applyPresetDefaults() {
    const p = presets[presetSel.value];
    $('presetDesc').textContent = p.desc;
    $('bpm').value = p.bpm;
    $('reverb').value = Math.round(p.reverbWet * 100);
    $('reverbVal').textContent = $('reverb').value;
    prefillMeta();
  }
  presetSel.addEventListener('change', applyPresetDefaults);
  $('theme').addEventListener('change', prefillMeta);
  $('reverb').addEventListener('input', () => ($('reverbVal').textContent = $('reverb').value));
  // 영상 보정 슬라이더 라이브 표시
  $('brightness').addEventListener('input', () => {
    const v = parseInt($('brightness').value, 10) || 0;
    $('brightVal').textContent = (v > 0 ? '+' : '') + v;
  });
  $('saturation').addEventListener('input', () => ($('satVal').textContent = $('saturation').value));
  $('randomSeed').addEventListener('click', () => ($('seed').value = Math.floor(Math.random() * 1000000)));

  // 모바일: 음악 길이 기본값 낮춤
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (isMobile) {
    $('duration').value = 2;
    const hint = $('duration').parentElement.querySelector('.hint');
    if (hint) hint.textContent = '휴대폰에서는 1~2분 권장(브라우저에서 생성). MP4 합치기는 서버에서 처리됩니다.';
  }

  // 제목/해시태그 기본값(비어 있을 때만). 더 좋은 결과는 "✨ 자동 작성" 버튼 사용.
  function prefillMeta() {
    const p = presets[presetSel.value];
    const presetName = p ? p.name.split(' (')[0] : '음악';
    if (!$('vidTitle').dataset.touched) {
      $('vidTitle').value = `${presetName} | 휴식·집중·드라이브를 위한 음악 플레이리스트`;
    }
    if (!$('vidTags').dataset.touched) {
      $('vidTags').value = `음악, 플레이리스트, BGM, playlist, music, chill`;
    }
    if (!$('vidDesc').dataset.touched) {
      $('vidDesc').value = `직접 제작한 오리지널 음악입니다.\n휴식·집중·드라이브에 함께하세요. ("✨ 자동 작성"으로 더 좋은 제목·태그·설명을 만들 수 있어요.)`;
    }
  }
  ['vidTitle', 'vidTags', 'vidDesc'].forEach((id) =>
    $(id).addEventListener('input', () => ($(id).dataset.touched = '1'))
  );
  applyPresetDefaults();

  // ── AI/템플릿 메타데이터 자동 작성 ────────────────────────
  async function fillMetadata(silent) {
    const resp = await fetch('/api/metadata/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preset: presetSel.value,
        theme: $('theme').value,
        durationSec: audioDuration || 180,
        seed: parseInt($('seed').value, 10) || 1,
      }),
    });
    const j = await resp.json();
    if (!resp.ok) throw new Error(j.error || '실패');
    $('vidTitle').value = j.title || '';
    $('vidTitle').dataset.touched = '1';
    $('vidTags').value = (j.tags || []).join(', ');
    $('vidTags').dataset.touched = '1';
    $('vidDesc').value = j.description || '';
    $('vidDesc').dataset.touched = '1';
    $('metaProvider').textContent = '생성 방식: ' + (j.provider || 'template');
    return j;
  }
  $('metaGenerate').addEventListener('click', async () => {
    const btn = $('metaGenerate');
    const old = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>작성 중…';
    try { await fillMetadata(); }
    catch (e) { alert('자동 작성 실패: ' + (e.message || e)); }
    finally { btn.disabled = false; btn.textContent = old; }
  });

  // ── 실사 영상 미리보기 (키워드 → Pexels) ──────────────────
  let stockConfigured = false;
  $('previewStock').addEventListener('click', async () => {
    const kw = $('keyword').value.trim();
    if (!kw) { alert('키워드를 입력하세요.'); return; }
    const btn = $('previewStock'), old = btn.textContent;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      stockSeed = Math.floor(Math.random() * 1e9); // 누를 때마다 새 영상
      const resp = await fetch('/api/stock/search?keyword=' + encodeURIComponent(kw) + '&seed=' + stockSeed);
      const j = await resp.json();
      if (!resp.ok) throw new Error(j.error || '검색 실패');
      $('stockThumb').src = j.image || '';
      const tq = j.searchQuery && j.searchQuery !== kw ? ' · 검색어: ' + j.searchQuery : '';
      $('stockCredit').textContent = '출처: ' + (j.source === 'pixabay' ? 'Pixabay' : 'Pexels') + ' · ' + (j.author || '') + (j.duration ? ' · ' + j.duration + '초' : '') + tq;
      $('stockPreview').classList.remove('hidden');
    } catch (e) {
      alert('영상 미리보기 실패: ' + (e.message || e));
    } finally { btn.disabled = false; btn.textContent = old; }
  });

  // ── 🪄 AI 생성 (팝업): 컨셉 → AI 추가 질문 → 결과 → 적용 ──
  let planQuestionsData = [], planAnswers = [], lastPlan = null;

  function showPlanModal() { $('planModal').classList.remove('hidden'); }
  function hidePlanModal() { $('planModal').classList.add('hidden'); }
  $('planModalClose').addEventListener('click', hidePlanModal);
  function planShow(section) {
    ['planLoading', 'planQuestions', 'planResult'].forEach((id) =>
      $(id).classList.toggle('hidden', id !== section));
  }

  $('planBtn').addEventListener('click', async () => {
    const concept = $('concept').value.trim();
    if (!concept) { alert('컨셉을 한 줄 적어주세요.'); return; }
    showPlanModal();
    planShow('planLoading');
    $('planLoadingText').textContent = '컨셉을 읽고 질문을 만드는 중…';
    try {
      const r = await fetch('/api/plan/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concept }),
      });
      const j = await r.json();
      if (!r.ok || !(j.questions && j.questions.length)) throw new Error(j.error || '질문 없음');
      renderPlanQuestions(j.questions);
    } catch (_) {
      runPlanGenerate([]); // 질문 실패 시 바로 생성
    }
  });

  function renderPlanQuestions(qs) {
    planQuestionsData = qs;
    // 중복 선택 가능: 질문마다 {picks: 선택 칩들, free: 직접 입력} — 모두 합쳐 전달
    planAnswers = qs.map(() => ({ picks: [], free: '' }));
    const box = $('planQuestions');
    box.innerHTML = '';
    const tip = document.createElement('p');
    tip.className = 'hint';
    tip.textContent = '여러 개를 함께 선택할 수 있어요. 원하는 게 없으면 직접 입력해도 됩니다.';
    box.appendChild(tip);
    qs.forEach((q, qi) => {
      const wrap = document.createElement('div');
      wrap.className = 'plan-q';
      const t = document.createElement('div');
      t.className = 'plan-q-title';
      t.textContent = (qi + 1) + '. ' + q.q;
      wrap.appendChild(t);
      const opts = document.createElement('div');
      opts.className = 'chips';
      // 직접 입력칸 — 칩 선택과 함께 조합돼 전달됨
      const free = document.createElement('input');
      free.type = 'text'; free.className = 'plan-free';
      free.placeholder = '✏️ 추가로 원하는 게 있으면 직접 입력… (선택과 함께 반영)';
      free.addEventListener('input', () => { planAnswers[qi].free = free.value.trim(); });
      (q.options || []).forEach((op) => {
        const c = document.createElement('button');
        c.type = 'button'; c.className = 'chip'; c.textContent = op;
        c.addEventListener('click', () => {
          const picks = planAnswers[qi].picks;
          const idx = picks.indexOf(op);
          if (idx >= 0) picks.splice(idx, 1); else picks.push(op); // 토글(중복 선택)
          c.classList.toggle('active', idx < 0);
        });
        opts.appendChild(c);
      });
      wrap.appendChild(opts);
      wrap.appendChild(free);
      box.appendChild(wrap);
    });
    const act = document.createElement('div');
    act.className = 'actions';
    const go = document.createElement('button');
    go.type = 'button'; go.className = 'btn btn-primary'; go.textContent = '🪄 이 내용으로 생성';
    go.addEventListener('click', () =>
      runPlanGenerate(planQuestionsData
        .map((q, i) => {
          const a = planAnswers[i];
          const parts = a.picks.slice();
          if (a.free) parts.push(a.free);
          return parts.length ? { q: q.q, a: parts.join(', ') } : null;
        })
        .filter(Boolean)));
    const skip = document.createElement('button');
    skip.type = 'button'; skip.className = 'btn btn-secondary'; skip.textContent = '건너뛰고 생성';
    skip.addEventListener('click', () => runPlanGenerate([]));
    act.appendChild(go); act.appendChild(skip);
    box.appendChild(act);
    planShow('planQuestions');
  }

  async function runPlanGenerate(answers) {
    planShow('planLoading');
    $('planLoadingText').textContent = '음악·영상 기획을 만드는 중…';
    try {
      const resp = await fetch('/api/plan/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concept: $('concept').value.trim(), durationSec: audioDuration || 180, answers }),
      });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j.error || '생성 실패');
      lastPlan = j;
      $('planSummary').innerHTML =
        '🎬 영상 키워드: <b>' + esc(j.keyword || '-') + '</b><br />' +
        '📺 유튜브 제목: ' + esc(j.title || '-') +
        (j.provider !== 'claude' ? '<br />⚠️ AI 키가 없어 기본 방식으로 만들었어요.' : '');
      $('sunoStyleText').value = j.sunoStyle || '';
      // 가사가 있으면 가사 UI, 없으면(연주곡) Instrumental 토글 안내
      const lyrics = (j.sunoLyrics || '').trim();
      const isInstrumental = !lyrics || /^\[?instrumental\]?$/i.test(lyrics);
      $('sunoLyricsText').value = isInstrumental ? '' : lyrics;
      $('sunoLyricsWrap').classList.toggle('hidden', isInstrumental);
      $('instrumentalNote').classList.toggle('hidden', !isInstrumental);
      planShow('planResult');
    } catch (e) {
      alert('AI 생성 실패: ' + (e.message || e));
      hidePlanModal();
    }
  }

  $('planApply').addEventListener('click', () => {
    const j = lastPlan;
    if (j) {
      if (j.keyword) { $('keyword').value = j.keyword; $('keyword').dataset.touched = '1'; }
      if (j.overlayTitle) $('overlayText').value = j.overlayTitle;
      if (j.subtitle) $('subtitle').value = j.subtitle;
      if (j.title) { $('vidTitle').value = j.title; $('vidTitle').dataset.touched = '1'; }
      if (j.tags && j.tags.length) { $('vidTags').value = j.tags.join(', '); $('vidTags').dataset.touched = '1'; }
      if (j.description) { $('vidDesc').value = j.description; $('vidDesc').dataset.touched = '1'; }
    }
    hidePlanModal();
  });
  function wireCopy(btnId, srcId, label) {
    $(btnId).addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($(srcId).value);
        $(btnId).textContent = '✅ 복사됨';
        setTimeout(() => ($(btnId).textContent = label), 1500);
      } catch (_) {
        $(srcId).select();
        document.execCommand('copy');
      }
    });
  }
  wireCopy('copySunoStyle', 'sunoStyleText', '📋 스타일 복사');
  wireCopy('copySunoLyrics', 'sunoLyricsText', '📋 가사 복사');

  // 📖 가이드의 복사 버튼들 (data-copy 속성 값을 클립보드로)
  document.querySelectorAll('.copy-btn[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const old = btn.textContent;
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = '✅ 복사됨';
      } catch (_) {
        // 클립보드 API 실패 시 임시 textarea로 폴백
        const ta = document.createElement('textarea');
        ta.value = btn.dataset.copy;
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
        btn.textContent = '✅ 복사됨';
      }
      setTimeout(() => (btn.textContent = old), 1200);
    });
  });

  // Suno 열기 — PC는 웹, 안드로이드는 Suno 앱(없으면 웹 폴백)
  // 단, 앱 내부 브라우저(WebView, UA에 'wv')에서는 intent://를 처리 못 해 에러가 나므로
  // 일반 https로 열기 → 새 APK가 외부 링크를 크롬으로 넘겨 앱 링크가 동작한다.
  $('openSuno').addEventListener('click', () => {
    const ua = navigator.userAgent;
    const isAndroid = /Android/i.test(ua);
    const isWebView = /\bwv\b/.test(ua);
    if (isAndroid && !isWebView) {
      location.href = 'intent://suno.com/#Intent;scheme=https;package=com.suno.android;' +
        'S.browser_fallback_url=https%3A%2F%2Fsuno.com;end';
    } else {
      window.open('https://suno.com', '_blank', 'noopener');
    }
  });

  // ── 🎵 Suno 곡 링크로 가져오기 → 목록에서 듣고 선택 ────────
  function renderSunoTracks() {
    const box = $('sunoTracks');
    box.innerHTML = '';
    sunoTracks.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'suno-track' + (selectedSunoId === t.id ? ' selected' : '');
      const label = document.createElement('label');
      label.className = 'suno-track-pick';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'sunoPick';
      radio.checked = selectedSunoId === t.id;
      radio.addEventListener('change', () => {
        selectedSunoId = t.id;
        audioDuration = t.duration || 0;
        try { $('audioFile').value = ''; } catch (_) {}
        uploadedAudioFile = null;
        $('audioInfo').className = 'status ok';
        $('audioInfo').textContent = '✓ ' + t.name + (t.duration ? ' · ' + fmtTime(t.duration) : '') + ' 선택됨';
        $('render').disabled = false;
        renderSunoTracks();
      });
      label.appendChild(radio);
      label.appendChild(document.createTextNode(' ' + t.name + (t.duration ? ' · ' + fmtTime(t.duration) : '')));
      const player = document.createElement('audio');
      player.controls = true; player.preload = 'none';
      player.src = '/api/suno/file/' + t.id;
      row.appendChild(label);
      row.appendChild(player);
      box.appendChild(row);
    });
  }

  $('sunoFetchBtn').addEventListener('click', async () => {
    const link = $('sunoLink').value.trim();
    if (!link) { alert('Suno 곡 링크를 붙여넣어 주세요. (곡에서 Share → Copy Link)'); return; }
    const btn = $('sunoFetchBtn'), old = btn.textContent;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const resp = await fetch('/api/suno/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: link }),
      });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j.error || '가져오기 실패');
      const track = { id: j.id, name: 'Suno 곡 ' + (sunoTracks.length + 1), duration: 0 };
      sunoTracks.push(track);
      // 길이 측정 후 표시 갱신
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => {
        if (isFinite(probe.duration) && probe.duration > 1) track.duration = probe.duration;
        if (selectedSunoId === track.id) audioDuration = track.duration || 0;
        renderSunoTracks();
      };
      probe.src = '/api/suno/file/' + track.id;
      // 방금 가져온 곡을 자동 선택
      selectedSunoId = track.id;
      uploadedAudioFile = null;
      try { $('audioFile').value = ''; } catch (_) {}
      $('render').disabled = false;
      $('sunoLink').value = '';
      renderSunoTracks();
    } catch (e) {
      alert('Suno 곡 가져오기 실패: ' + (e.message || e));
    } finally { btn.disabled = false; btn.textContent = old; }
  });

  // ── 음악 소스 토글 (내 음악 올리기 ↔ 코드 생성) ──────────
  document.querySelectorAll('#musicToggle .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      musicMode = btn.dataset.music;
      document.querySelectorAll('#musicToggle .seg-btn').forEach((b) =>
        b.classList.toggle('active', b === btn));
      $('musicUploadRow').classList.toggle('hidden', musicMode !== 'upload');
      $('musicGenRow').classList.toggle('hidden', musicMode !== 'generate');
    });
  });
  // 음악 파일 올리면 길이 읽어두기
  $('audioFile').addEventListener('change', () => {
    const f = $('audioFile').files[0];
    uploadedAudioFile = f || null;
    if (f) { selectedSunoId = null; renderSunoTracks(); } // 파일을 고르면 Suno 선택 해제
    const info = $('audioInfo');
    $('render').disabled = !f && !selectedSunoId;
    if (!f) { info.textContent = ''; return; }
    info.className = 'status'; info.textContent = '길이 확인 중…';
    const url = URL.createObjectURL(f);
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      audioDuration = isFinite(a.duration) && a.duration > 1 ? a.duration : 0;
      URL.revokeObjectURL(url);
      info.className = 'status ok';
      info.textContent = '✓ ' + f.name + (audioDuration ? ' · ' + fmtTime(audioDuration) : '');
    };
    a.onerror = () => { info.className = 'status err'; info.textContent = '이 파일을 읽을 수 없어요.'; };
    a.src = url;
  });

  // ── 영상 소스 토글 (키워드 ↔ 내 파일) ────────────────────
  document.querySelectorAll('#sourceToggle .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      sourceMode = btn.dataset.src;
      document.querySelectorAll('#sourceToggle .seg-btn').forEach((b) =>
        b.classList.toggle('active', b === btn));
      $('keywordRow').classList.toggle('hidden', sourceMode !== 'keyword');
      $('uploadRow').classList.toggle('hidden', sourceMode !== 'upload');
      if (sourceMode === 'keyword') { try { $('media').value = ''; } catch (_) {} }
    });
  });

  // ── 음악 생성 ─────────────────────────────────────────────
  async function generateMusic() {
    const btn = $('generate'), status = $('genStatus');
    const minutes = parseFloat($('duration').value) || 3;
    const duration = Math.max(8, Math.min(20 * 60, minutes * 60));
    const opts = {
      preset: presetSel.value, duration, seed: parseInt($('seed').value, 10) || 1,
      bpm: parseInt($('bpm').value, 10) || presets[presetSel.value].bpm,
      reverb: (parseInt($('reverb').value, 10) || 0) / 100,
      layers: {
        pad: $('layer-pad').checked, melody: $('layer-melody').checked,
        sub: $('layer-sub').checked, water: $('layer-water').checked,
      },
    };
    btn.disabled = true; $('autoGenerate').disabled = true; $('render').disabled = true;
    status.className = 'status'; status.innerHTML = '<span class="spinner"></span>음악 생성 중…';
    try {
      const audioBuffer = await AmbientEngine.render(opts, (s) => (status.innerHTML = '<span class="spinner"></span>' + s));
      audioDuration = audioBuffer.duration;
      status.innerHTML = '<span class="spinner"></span>WAV 인코딩 중…';
      await new Promise((r) => setTimeout(r, 30));
      wavBlob = WavEncoder.encodeWav(audioBuffer, 24);
      if (wavUrl) URL.revokeObjectURL(wavUrl);
      wavUrl = URL.createObjectURL(wavBlob);
      $('player').src = wavUrl;
      $('audioResult').classList.remove('hidden');
      $('render').disabled = false;
      $('renderStatus').textContent = '이제 MP4를 만들 수 있어요.';
      status.className = 'status ok';
      status.textContent = `완료 · ${fmtTime(audioDuration)} · WAV ${(wavBlob.size / 1048576).toFixed(1)} MB`;
      return true;
    } catch (err) {
      console.error(err);
      status.className = 'status err'; status.textContent = '생성 실패: ' + (err.message || err);
      return false;
    } finally { btn.disabled = false; $('autoGenerate').disabled = false; }
  }
  $('generate').addEventListener('click', generateMusic);
  $('downloadWav').addEventListener('click', () => { if (wavBlob) triggerDownload(wavUrl, fileBase() + '.wav'); });

  // ── MP4 만들기 ────────────────────────────────────────────
  async function renderMp4() {
    const usingUpload = musicMode === 'upload';
    const btn = $('render'), status = $('renderStatus');
    const fd = new FormData();
    if (usingUpload && selectedSunoId) {
      // Suno로 가져온 곡은 서버에 이미 있으므로 id만 전달(재업로드 없음 → 빠름)
      fd.append('serverAudioId', selectedSunoId);
    } else {
      const audioData = usingUpload ? uploadedAudioFile : wavBlob;
      if (!audioData) return false;
      fd.append('audio', audioData, usingUpload ? (uploadedAudioFile.name || 'music.mp3') : 'ambient.wav');
    }
    const media = sourceMode === 'upload' ? $('media').files[0] : null;
    if (media) fd.append('media', media);
    fd.append('theme', $('theme').value);
    fd.append('keyword', $('keyword').value);
    // 실사 영상 선택 시드: 미리보기로 고른 그 영상으로 만들어지도록 stockSeed 사용
    fd.append('seed', String(stockSeed));
    fd.append('preset', presetSel.value);
    // 업로드 음악은 길이를 못 읽었을 때 큰 값으로 보내고 서버 -shortest가 실제 길이에서 자름
    fd.append('duration', String(audioDuration > 1 ? audioDuration : 600));
    fd.append('resolution', $('resolution').value);
    fd.append('fps', $('fps').value);
    fd.append('title', $('vidTitle').value);
    fd.append('tags', $('vidTags').value);
    fd.append('description', $('vidDesc').value);
    fd.append('overlayText', $('overlayText').value);
    fd.append('subtitle', $('subtitle').value);
    // 영상 보정(밝기·채도) — 슬라이더(%) → 디케이션 값
    fd.append('brightness', String(((parseInt($('brightness').value, 10) || 0) / 100)));
    fd.append('saturation', String(((parseInt($('saturation').value, 10) || 100) / 100)));
    fd.append('ambience', $('ambience').value); // 배경 자연음(모닥불·비 등)

    btn.disabled = true; $('generate').disabled = true; $('autoGenerate').disabled = true;
    status.className = 'status'; status.innerHTML = '<span class="spinner"></span>업로드 중…';
    $('mp4Result').classList.add('hidden'); setProgress(0, true);
    try {
      const resp = await fetch('/api/render', { method: 'POST', body: fd });
      if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || ('서버 오류 ' + resp.status)); }
      const { jobId } = await resp.json();
      status.innerHTML = '<span class="spinner"></span>인코딩 중…';
      await trackProgress(jobId, status);
      return true;
    } catch (err) {
      console.error(err);
      status.className = 'status err'; status.textContent = 'MP4 생성 실패: ' + (err.message || err);
      setProgress(0, false);
      return false;
    } finally { btn.disabled = false; $('generate').disabled = false; $('autoGenerate').disabled = false; }
  }
  $('render').addEventListener('click', renderMp4);

  // ── 🤖 원클릭 자동: 테마에 맞춰 메타데이터→음악→영상까지 한 번에 ──
  const PRESET_THEME = {
    boom_drive: 'golden_sunset',
    autumn_valley: 'autumn_valley', misty_dawn: 'misty_dawn', rainy_valley: 'deep_indigo',
    firelight_night: 'rosewood_night', city_drive: 'neon_city', funky_sunset: 'golden_sunset',
    dreamy_synth: 'dreamy_violet', deep_sleep: 'deep_indigo', lofi_rain: 'lofi_dusk', night_city: 'neon_city',
  };
  // 프리셋에 어울리는 실사 영상 키워드(영어가 검색 정확도 높음)
  const PRESET_KEYWORD = {
    boom_drive: 'city night drive', autumn_valley: 'autumn forest', misty_dawn: 'misty mountain sunrise',
    rainy_valley: 'rain on window', firelight_night: 'cozy fireplace', city_drive: 'city night drive',
    funky_sunset: 'sunset beach drive', dreamy_synth: 'aurora night sky', deep_sleep: 'starry night sky',
    lofi_rain: 'rainy city street', night_city: 'tokyo city night',
  };
  // 사용자가 키워드를 직접 입력하면 자동 채움을 멈춤
  $('keyword').addEventListener('input', () => ($('keyword').dataset.touched = '1'));
  function syncByPreset() {
    const t = PRESET_THEME[presetSel.value];
    if (t) $('theme').value = t;
    const kw = PRESET_KEYWORD[presetSel.value];
    if (kw && !$('keyword').dataset.touched) $('keyword').value = kw;
  }
  // 음악 프리셋을 바꾸면 영상 테마·키워드도 어울리게 자동 동기화
  presetSel.addEventListener('change', syncByPreset);
  syncByPreset(); // 시작 시에도 기본 프리셋에 맞춰
  $('autoGenerate').addEventListener('click', async () => {
    const btn = $('autoGenerate'), status = $('genStatus');
    btn.disabled = true;
    try {
      // 1) 영상 테마를 음악 프리셋에 맞게 자동 선택
      const mapped = PRESET_THEME[presetSel.value];
      if (mapped) $('theme').value = mapped;
      // 2) 제목·해시태그·설명 자동 작성
      status.className = 'status'; status.innerHTML = '<span class="spinner"></span>제목·해시태그 작성 중…';
      try { await fillMetadata(true); } catch (_) { /* 메타 실패해도 계속 */ }
      // 제목·부제는 자동으로 채우지 않음 — 비워두면 영상에 글씨가 안 들어감.
      // (채널 이름이 정해지면 그때 직접 입력해서 넣을 예정)
      // 3) 음악: 업로드 모드면 올린 파일 사용, 아니면 코드로 생성
      if (musicMode === 'upload') {
        if (!uploadedAudioFile && !selectedSunoId) {
          status.className = 'status err';
          status.textContent = '먼저 음악을 준비해주세요 (Suno 링크 가져오기 또는 파일 올리기).';
          return;
        }
      } else {
        const okMusic = await generateMusic();
        if (!okMusic) return;
      }
      // 4) 영상(MP4)까지
      const okVideo = await renderMp4();
      if (okVideo) document.getElementById('gallery').scrollIntoView({ behavior: 'smooth' });
    } finally { btn.disabled = false; }
  });

  function trackProgress(jobId, status) {
    return new Promise((resolve, reject) => {
      const es = new EventSource('/api/progress/' + jobId);
      let settled = false;
      es.onmessage = (ev) => {
        let d; try { d = JSON.parse(ev.data); } catch (_) { return; }
        if (d.status === 'processing') {
          setProgress(d.percent || 0, true);
          if (d.note) status.innerHTML = '<span class="spinner"></span>' + d.note;
        }
        else if (d.status === 'done') {
          settled = true; es.close(); setProgress(100, true);
          const fileUrl = '/api/videos/' + jobId + '/file';
          $('mp4Preview').src = fileUrl;
          $('downloadMp4').href = '/api/download/' + jobId + '?name=' + encodeURIComponent(fileBase() + '.mp4');
          $('downloadMp4').setAttribute('download', fileBase() + '.mp4');
          $('mp4Result').classList.remove('hidden');
          status.className = 'status ok'; status.textContent = '완료! NAS에 저장되었습니다.';
          loadGallery();
          resolve();
        } else if (d.status === 'error') { settled = true; es.close(); reject(new Error(d.error || '인코딩 오류')); }
      };
      es.onerror = () => { if (!settled) { es.close(); reject(new Error('진행률 연결이 끊어졌습니다.')); } };
    });
  }

  // ── 갤러리 ────────────────────────────────────────────────
  async function loadGallery() {
    let data;
    try { data = await (await fetch('/api/videos')).json(); } catch (_) { return; }
    ytConfigured = !!(data.youtube && data.youtube.configured);
    const note = $('ytSetupNote');
    if (!ytConfigured) {
      note.classList.remove('hidden');
      note.textContent = '유튜브 업로드는 서버에 YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN을 설정하면 켜집니다. (README의 "유튜브 연결" 참고)';
    } else { note.classList.add('hidden'); }

    const grid = $('galleryGrid'); grid.innerHTML = '';
    const videos = data.videos || [];
    $('galleryEmpty').classList.toggle('hidden', videos.length > 0);
    videos.forEach((v) => grid.appendChild(renderCard(v)));
  }

  function renderCard(v) {
    const card = document.createElement('div');
    card.className = 'vcard';
    const created = v.createdAt ? new Date(v.createdAt).toLocaleString('ko-KR') : '';
    const yt = v.youtube && v.youtube.uploaded;
    card.innerHTML = `
      <video controls playsinline preload="none" src="/api/videos/${v.id}/file"></video>
      <div class="vtitle">${esc(v.title)}</div>
      <div class="vmeta">${v.resolution || ''} · ${v.durationSec ? fmtTime(v.durationSec) : ''} · ${v.sizeMB || 0}MB · ${created}</div>
      ${v.tags && v.tags.length ? `<div class="vtags">#${v.tags.map(esc).join(' #')}</div>` : ''}
      <div class="vrow">
        ${yt ? `<a class="badge yt" href="${esc(v.youtube.url)}" target="_blank" rel="noopener">▶ 유튜브에서 보기</a>` : ''}
      </div>
      <div class="vrow"></div>`;
    const row = card.querySelectorAll('.vrow')[1];

    const dl = document.createElement('a');
    dl.className = 'btn btn-secondary'; dl.textContent = '다운로드';
    dl.href = '/api/download/' + v.id; dl.setAttribute('download', '');
    row.appendChild(dl);

    if (!yt) {
      const up = document.createElement('button');
      up.className = 'btn btn-primary'; up.type = 'button';
      up.textContent = ytConfigured ? '유튜브 업로드' : '유튜브 연결 필요';
      up.disabled = !ytConfigured;
      up.addEventListener('click', () => uploadToYouTube(v, up));
      row.appendChild(up);
    }

    const del = document.createElement('button');
    del.className = 'btn btn-secondary'; del.type = 'button'; del.textContent = '삭제';
    del.addEventListener('click', async () => {
      if (!confirm('이 영상을 NAS에서 삭제할까요?')) return;
      await fetch('/api/videos/' + v.id, { method: 'DELETE' });
      loadGallery();
    });
    row.appendChild(del);
    return card;
  }

  async function uploadToYouTube(v, btn) {
    btn.disabled = true; const old = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span>업로드 중…';
    try {
      const resp = await fetch('/api/videos/' + v.id + '/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: v.title, description: v.description,
          tags: v.tags, privacy: $('vidPrivacy').value,
        }),
      });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j.error || '업로드 실패');
      alert('유튜브 업로드 완료!\n' + j.url);
      loadGallery();
    } catch (err) {
      alert('업로드 실패: ' + (err.message || err));
      btn.disabled = false; btn.textContent = old;
    }
  }

  // ── PWA 설치 ──────────────────────────────────────────────
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredPrompt = e;
    $('installBtn').classList.remove('hidden');
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null; $('installBtn').classList.add('hidden');
  });
  // iOS Safari는 beforeinstallprompt가 없음 → 안내 배너
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  if (isIOS && !standalone && !localStorage.getItem('iosHintDismissed')) {
    setTimeout(() => $('iosHint').classList.add('show'), 1200);
  }
  $('iosHintClose').addEventListener('click', () => {
    $('iosHint').classList.remove('show');
    localStorage.setItem('iosHintDismissed', '1');
  });

  // ── 유틸 ──────────────────────────────────────────────────
  function setProgress(pct, show) {
    $('progressWrap').classList.toggle('hidden', !show);
    $('progressBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
    $('progressPct').textContent = Math.round(pct) + '%';
  }
  function fmtTime(sec) { const m = Math.floor(sec / 60), s = Math.round(sec % 60); return m + ':' + String(s).padStart(2, '0'); }
  function fileBase() { return 'music-' + presetSel.value + '-' + ($('seed').value || '0'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function triggerDownload(url, name) {
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ── 연결 자가진단 + 버전 표시 ────────────────────────────────
  // 서버에 닿으면 푸터에 빌드 버전을 보여줘 "업데이트 반영"을 눈으로 확인.
  // 닿지 못하면(=NAS/컨테이너 다운, 잘못된 주소) 흰 화면 대신 친절한 배너.
  async function checkHealth() {
    const banner = $('connBanner'), detail = $('connDetail'), build = $('buildInfo');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const resp = await fetch('/api/health', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const j = await resp.json();
      banner.classList.add('hidden');
      stockConfigured = !!j.stock;
      if (!stockConfigured) {
        $('stockHint').innerHTML = '⚠️ 실사 영상을 쓰려면 서버에 <b>PEXELS_API_KEY</b> 또는 <b>PIXABAY_API_KEY</b>가 필요해요(무료). ' +
          '없으면 아래 테마 배경으로 자동 대체됩니다.';
      }
      const line = 'v' + (j.version || '?') +
        (j.youtube ? ' · 유튜브 연결됨' : '') +
        (j.stock ? ' · 실사영상 연결됨' : '') +
        (j.ai ? ' · AI 연결됨' : '') +
        ' · 메타: ' + (j.metadataProvider || 'template');
      build.textContent = line;
      const top = $('buildInfoTop');
      if (top) top.textContent = '🟢 ' + line;
    } catch (e) {
      detail.textContent = ' 현재 주소(' + location.host + ')에서 서버가 응답하지 않습니다. ' +
        'NAS 컨테이너가 켜져 있는지, 주소에 포트(:8443)가 맞는지 확인하세요.';
      banner.classList.remove('hidden');
      build.textContent = '서버 연결 안됨';
      const top = $('buildInfoTop');
      if (top) top.textContent = '🔴 서버 연결 안됨';
    }
  }

  // 시작 시 연결 확인 + 갤러리 로드
  checkHealth();
  loadGallery();
})();
