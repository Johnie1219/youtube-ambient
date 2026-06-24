'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  // 상태
  let wavBlob = null;
  let wavUrl = null;
  let audioDuration = 0; // 초

  // ── 프리셋 채우기 ─────────────────────────────────────────────
  const presetSel = $('preset');
  const presets = AmbientEngine.PRESETS;
  Object.keys(presets).forEach((key) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = presets[key].name;
    presetSel.appendChild(opt);
  });

  function applyPresetDefaults() {
    const p = presets[presetSel.value];
    $('presetDesc').textContent = p.desc;
    $('bpm').value = p.bpm;
    $('reverb').value = Math.round(p.reverbWet * 100);
    $('reverbVal').textContent = $('reverb').value;
  }
  presetSel.addEventListener('change', applyPresetDefaults);
  applyPresetDefaults();

  $('reverb').addEventListener('input', () => {
    $('reverbVal').textContent = $('reverb').value;
  });

  $('randomSeed').addEventListener('click', () => {
    $('seed').value = Math.floor(Math.random() * 1000000);
  });

  // ── 음악 생성 ─────────────────────────────────────────────────
  $('generate').addEventListener('click', async () => {
    const btn = $('generate');
    const status = $('genStatus');
    const minutes = parseFloat($('duration').value) || 3;
    const duration = Math.max(8, Math.min(20 * 60, minutes * 60));

    const opts = {
      preset: presetSel.value,
      duration: duration,
      seed: parseInt($('seed').value, 10) || 1,
      bpm: parseInt($('bpm').value, 10) || presets[presetSel.value].bpm,
      reverb: (parseInt($('reverb').value, 10) || 0) / 100,
      layers: {
        pad: $('layer-pad').checked,
        melody: $('layer-melody').checked,
        sub: $('layer-sub').checked,
        water: $('layer-water').checked,
      },
    };

    btn.disabled = true;
    $('render').disabled = true;
    status.className = 'status';
    status.innerHTML = '<span class="spinner"></span>음악 생성 중…';

    try {
      const audioBuffer = await AmbientEngine.render(opts, (stage) => {
        status.innerHTML = '<span class="spinner"></span>' + stage;
      });
      audioDuration = audioBuffer.duration;

      status.innerHTML = '<span class="spinner"></span>WAV 인코딩 중…';
      // 무거운 동기 작업 전 UI 갱신 한 틱
      await new Promise((r) => setTimeout(r, 30));
      wavBlob = WavEncoder.encodeWav(audioBuffer, 24);

      if (wavUrl) URL.revokeObjectURL(wavUrl);
      wavUrl = URL.createObjectURL(wavBlob);
      $('player').src = wavUrl;
      $('audioResult').classList.remove('hidden');
      $('render').disabled = false;

      const mb = (wavBlob.size / (1024 * 1024)).toFixed(1);
      const mmss = formatTime(audioDuration);
      status.className = 'status ok';
      status.textContent = `완료 · ${mmss} · WAV ${mb} MB`;
    } catch (err) {
      console.error(err);
      status.className = 'status err';
      status.textContent = '생성 실패: ' + (err.message || err);
    } finally {
      btn.disabled = false;
    }
  });

  $('downloadWav').addEventListener('click', () => {
    if (!wavBlob) return;
    triggerDownload(wavUrl, fileBase() + '.wav');
  });

  // ── MP4 만들기 ────────────────────────────────────────────────
  $('render').addEventListener('click', async () => {
    if (!wavBlob) return;
    const btn = $('render');
    const status = $('renderStatus');

    const fd = new FormData();
    fd.append('audio', wavBlob, 'ambient.wav');
    const media = $('media').files[0];
    if (media) fd.append('media', media);
    fd.append('duration', String(audioDuration));
    fd.append('resolution', $('resolution').value);
    fd.append('fps', $('fps').value);

    btn.disabled = true;
    $('generate').disabled = true;
    status.className = 'status';
    status.innerHTML = '<span class="spinner"></span>업로드 중…';
    $('mp4Result').classList.add('hidden');
    setProgress(0, true);

    try {
      const resp = await fetch('/api/render', { method: 'POST', body: fd });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.error || ('서버 오류 ' + resp.status));
      }
      const { jobId } = await resp.json();
      status.innerHTML = '<span class="spinner"></span>인코딩 중…';
      await trackProgress(jobId, status);
    } catch (err) {
      console.error(err);
      status.className = 'status err';
      status.textContent = 'MP4 생성 실패: ' + (err.message || err);
      setProgress(0, false);
    } finally {
      btn.disabled = false;
      $('generate').disabled = false;
    }
  });

  function trackProgress(jobId, status) {
    return new Promise((resolve, reject) => {
      const es = new EventSource('/api/progress/' + jobId);
      let settled = false;

      es.onmessage = (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch (_) { return; }

        if (data.status === 'processing') {
          setProgress(data.percent || 0, true);
        } else if (data.status === 'done') {
          settled = true;
          es.close();
          setProgress(100, true);
          const url = '/api/download/' + jobId + '?name=' + encodeURIComponent(fileBase() + '.mp4');
          $('mp4Preview').src = url;
          $('downloadMp4').href = url;
          $('downloadMp4').setAttribute('download', fileBase() + '.mp4');
          $('mp4Result').classList.remove('hidden');
          status.className = 'status ok';
          status.textContent = '완료! 아래에서 미리보기·다운로드 하세요.';
          resolve();
        } else if (data.status === 'error') {
          settled = true;
          es.close();
          reject(new Error(data.error || '인코딩 오류'));
        }
      };

      es.onerror = () => {
        if (settled) return;
        es.close();
        reject(new Error('진행률 연결이 끊어졌습니다.'));
      };
    });
  }

  // ── 유틸 ──────────────────────────────────────────────────────
  function setProgress(pct, show) {
    $('progressWrap').classList.toggle('hidden', !show);
    $('progressBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
    $('progressPct').textContent = Math.round(pct) + '%';
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function fileBase() {
    return 'autumn-ambient-' + presetSel.value + '-' + ($('seed').value || '0');
  }

  function triggerDownload(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
})();
