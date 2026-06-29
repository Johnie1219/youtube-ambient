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

  const THEME_LABELS = {
    autumn_valley: '가을 계곡',
    golden_sunset: '황금 노을',
    misty_dawn: '새벽 안개',
    rosewood_night: '모닥불 밤',
    forest_emerald: '숲 에메랄드',
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
  $('randomSeed').addEventListener('click', () => ($('seed').value = Math.floor(Math.random() * 1000000)));

  // 모바일: 음악 길이 기본값 낮춤
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (isMobile) {
    $('duration').value = 2;
    const hint = $('duration').parentElement.querySelector('.hint');
    if (hint) hint.textContent = '휴대폰에서는 1~2분 권장(브라우저에서 생성). MP4 합치기는 서버에서 처리됩니다.';
  }

  // 제목/해시태그 자동 채우기(비어 있을 때만)
  function prefillMeta() {
    const presetName = presets[presetSel.value] ? presets[presetSel.value].name.split(' (')[0] : '가을 계곡';
    const themeName = THEME_LABELS[$('theme').value] || '가을';
    if (!$('vidTitle').dataset.touched) {
      $('vidTitle').value = `🍂 ${presetName} 앰비언트 | 잔잔한 휴식·수면·집중을 위한 연주 음악`;
    }
    if (!$('vidTags').dataset.touched) {
      $('vidTags').value = `앰비언트, ${themeName}, 수면음악, 집중음악, lofi, relaxing, ambient`;
    }
    if (!$('vidDesc').dataset.touched) {
      $('vidDesc').value = `코드로 생성한 ${presetName} 분위기의 잔잔한 앰비언트 음악입니다.\n휴식, 수면, 공부, 명상에 함께하세요.`;
    }
  }
  ['vidTitle', 'vidTags', 'vidDesc'].forEach((id) =>
    $(id).addEventListener('input', () => ($(id).dataset.touched = '1'))
  );
  applyPresetDefaults();

  // ── AI/템플릿 메타데이터 자동 작성 ────────────────────────
  $('metaGenerate').addEventListener('click', async () => {
    const btn = $('metaGenerate');
    const old = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>작성 중…';
    try {
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
    } catch (e) {
      alert('자동 작성 실패: ' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  // ── 음악 생성 ─────────────────────────────────────────────
  $('generate').addEventListener('click', async () => {
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
    btn.disabled = true; $('render').disabled = true;
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
    } catch (err) {
      console.error(err);
      status.className = 'status err'; status.textContent = '생성 실패: ' + (err.message || err);
    } finally { btn.disabled = false; }
  });
  $('downloadWav').addEventListener('click', () => { if (wavBlob) triggerDownload(wavUrl, fileBase() + '.wav'); });

  // ── MP4 만들기 ────────────────────────────────────────────
  $('render').addEventListener('click', async () => {
    if (!wavBlob) return;
    const btn = $('render'), status = $('renderStatus');
    const fd = new FormData();
    fd.append('audio', wavBlob, 'ambient.wav');
    const media = $('media').files[0];
    if (media) fd.append('media', media);
    fd.append('theme', $('theme').value);
    fd.append('preset', presetSel.value);
    fd.append('duration', String(audioDuration));
    fd.append('resolution', $('resolution').value);
    fd.append('fps', $('fps').value);
    fd.append('title', $('vidTitle').value);
    fd.append('tags', $('vidTags').value);
    fd.append('description', $('vidDesc').value);

    btn.disabled = true; $('generate').disabled = true;
    status.className = 'status'; status.innerHTML = '<span class="spinner"></span>업로드 중…';
    $('mp4Result').classList.add('hidden'); setProgress(0, true);
    try {
      const resp = await fetch('/api/render', { method: 'POST', body: fd });
      if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || ('서버 오류 ' + resp.status)); }
      const { jobId } = await resp.json();
      status.innerHTML = '<span class="spinner"></span>인코딩 중…';
      await trackProgress(jobId, status);
    } catch (err) {
      console.error(err);
      status.className = 'status err'; status.textContent = 'MP4 생성 실패: ' + (err.message || err);
      setProgress(0, false);
    } finally { btn.disabled = false; $('generate').disabled = false; }
  });

  function trackProgress(jobId, status) {
    return new Promise((resolve, reject) => {
      const es = new EventSource('/api/progress/' + jobId);
      let settled = false;
      es.onmessage = (ev) => {
        let d; try { d = JSON.parse(ev.data); } catch (_) { return; }
        if (d.status === 'processing') setProgress(d.percent || 0, true);
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
  function fileBase() { return 'autumn-ambient-' + presetSel.value + '-' + ($('seed').value || '0'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function triggerDownload(url, name) {
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // 시작 시 갤러리 로드
  loadGallery();
})();
