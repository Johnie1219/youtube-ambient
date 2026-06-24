/**
 * 앰비언트 음악 엔진 — Tone.js 기반 절차적 생성.
 *
 * 브라우저에서 Tone.Offline로 전체 길이를 한 번에 고음질 렌더링한 뒤
 * AudioBuffer를 돌려준다. 같은 seed면 멜로디·코드 구성이 동일하게 재현된다
 * (물·바람 질감은 시드와 무관한 노이즈라 매번 미세하게 달라짐).
 *
 * 신호 흐름:
 *   pad   → padFilter(LFO) → chorus ┐
 *   melody → pingpong delay ────────┤
 *   sub   ──────────────────────────┤→ reverb → limiter → masterGain(fade) → out
 *   water → bandpass(LFO) → autopan ┘
 */
(function () {
  // 시드 기반 PRNG (mulberry32)
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 프리셋: 가을 계곡을 기본으로, 분위기 변주 4종
  const PRESETS = {
    autumn_valley: {
      name: '가을 계곡 (Autumn Valley)',
      desc: '안개 낀 단풍 숲, 따뜻하고 잔잔한 기본 무드',
      bpm: 60,
      reverbWet: 0.5,
      noiseLevel: 0.5,
      noiseTone: 'pink',
      melodyDensity: 2.5,
      chords: [
        { pad: ['A3', 'C4', 'E4', 'G4'], bass: 'A1' },
        { pad: ['F3', 'A3', 'C4', 'E4'], bass: 'F1' },
        { pad: ['C4', 'E4', 'G4', 'B4'], bass: 'C2' },
        { pad: ['G3', 'B3', 'D4', 'E4'], bass: 'G1' },
      ],
      scale: ['A4', 'C5', 'D5', 'E5', 'G5', 'A5', 'B4', 'D6'],
    },
    misty_dawn: {
      name: '새벽 안개 (Misty Dawn)',
      desc: '밝고 느린 패드 중심, 멜로디는 드물게',
      bpm: 52,
      reverbWet: 0.62,
      noiseLevel: 0.35,
      noiseTone: 'pink',
      melodyDensity: 1.4,
      chords: [
        { pad: ['C4', 'E4', 'G4', 'D5'], bass: 'C2' },
        { pad: ['E3', 'G3', 'B3', 'D4'], bass: 'E1' },
        { pad: ['F3', 'A3', 'C4', 'E4'], bass: 'F1' },
        { pad: ['G3', 'B3', 'D4', 'E4'], bass: 'G1' },
      ],
      scale: ['C5', 'D5', 'E5', 'G5', 'A5', 'C6', 'D6'],
    },
    rainy_valley: {
      name: '비 오는 계곡 (Rainy Valley)',
      desc: '빗소리 질감이 짙고 사색적인 단조',
      bpm: 56,
      reverbWet: 0.55,
      noiseLevel: 0.85,
      noiseTone: 'white',
      melodyDensity: 1.5,
      chords: [
        { pad: ['A3', 'C4', 'E4', 'G4'], bass: 'A1' },
        { pad: ['D3', 'F3', 'A3', 'C4'], bass: 'D2' },
        { pad: ['E3', 'G3', 'B3', 'D4'], bass: 'E1' },
        { pad: ['A3', 'C4', 'E4', 'G4'], bass: 'A1' },
      ],
      scale: ['A4', 'C5', 'D5', 'E5', 'G5', 'A5'],
    },
    firelight_night: {
      name: '모닥불 밤 (Firelight Night)',
      desc: '낮고 따뜻한 밤, 포근한 도리안',
      bpm: 50,
      reverbWet: 0.5,
      noiseLevel: 0.4,
      noiseTone: 'brown',
      melodyDensity: 2,
      chords: [
        { pad: ['D3', 'F3', 'A3', 'E4'], bass: 'D1' },
        { pad: ['A#3', 'D4', 'F4', 'A4'], bass: 'A#1' },
        { pad: ['F3', 'A3', 'C4', 'E4'], bass: 'F1' },
        { pad: ['E3', 'G3', 'C4', 'E4'], bass: 'C2' },
      ],
      scale: ['D4', 'F4', 'G4', 'A4', 'C5', 'D5', 'F5'],
    },
  };

  async function render(opts, onStage) {
    if (typeof Tone === 'undefined') {
      throw new Error('Tone.js가 로드되지 않았습니다.');
    }
    const preset = PRESETS[opts.preset] || PRESETS.autumn_valley;
    const duration = Math.max(8, opts.duration || 180); // 초
    const seed = (opts.seed >>> 0) || 1;
    const rng = mulberry32(seed);
    const bpm = opts.bpm || preset.bpm;
    const layers = Object.assign({ pad: true, melody: true, sub: true, water: true }, opts.layers || {});
    const reverbWet = opts.reverb != null ? opts.reverb : preset.reverbWet;
    const sampleRate = 44100;

    if (onStage) onStage('렌더링 준비 중…');

    const buffer = await Tone.Offline(async () => {
      // ── 마스터 체인 ──────────────────────────────────────────────
      const master = new Tone.Gain(0).toDestination();
      const limiter = new Tone.Limiter(-1).connect(master);
      const reverb = new Tone.Freeverb({ roomSize: 0.92, dampening: 2600 }).connect(limiter);
      reverb.wet.value = reverbWet;

      // 페이드 인/아웃
      const targetLevel = 0.85;
      const fadeIn = Math.min(3, duration * 0.1);
      const fadeOut = Math.min(6, duration * 0.18);
      master.gain.setValueAtTime(0.0001, 0);
      master.gain.linearRampToValueAtTime(targetLevel, fadeIn);
      master.gain.setValueAtTime(targetLevel, Math.max(fadeIn, duration - fadeOut));
      master.gain.linearRampToValueAtTime(0.0001, duration);

      // ── 악기 ─────────────────────────────────────────────────────
      // 패드: 따뜻한 fatsine, 느린 어택/릴리스 + 무빙 로우패스 + 코러스
      let pad, padFilter, padLfo, chorus;
      if (layers.pad) {
        chorus = new Tone.Chorus({ frequency: 0.4, delayTime: 4, depth: 0.6, wet: 0.4 })
          .connect(reverb)
          .start(0);
        padFilter = new Tone.Filter({ type: 'lowpass', frequency: 1200, Q: 0.5 }).connect(chorus);
        padLfo = new Tone.LFO({ frequency: 0.03, min: 700, max: 1900, type: 'sine' }).start(0);
        padLfo.connect(padFilter.frequency);
        pad = new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'fatsine', count: 3, spread: 28 },
          envelope: { attack: 4, decay: 3, sustain: 0.75, release: 8 },
          volume: -14,
        }).connect(padFilter);
        pad.maxPolyphony = 16;
      }

      // 멜로디: 부드러운 triangle + 핑퐁 딜레이
      let melody, melodyDelay;
      if (layers.melody) {
        melodyDelay = new Tone.PingPongDelay({ delayTime: 0.5, feedback: 0.35, wet: 0.32 }).connect(reverb);
        melody = new Tone.Synth({
          oscillator: { type: 'triangle' },
          envelope: { attack: 0.3, decay: 1.2, sustain: 0.18, release: 2.8 },
          volume: -17,
        }).connect(melodyDelay);
      }

      // 서브 베이스: 사인, 길게
      let sub;
      if (layers.sub) {
        sub = new Tone.Synth({
          oscillator: { type: 'sine' },
          envelope: { attack: 1.5, decay: 2, sustain: 0.85, release: 5 },
          volume: -15,
        }).connect(reverb);
      }

      // 물/바람 질감: 노이즈 → 무빙 밴드패스 → 오토패너
      let noise, noiseFilter, noiseLfo, autopan, noiseGain;
      if (layers.water && preset.noiseLevel > 0) {
        noiseGain = new Tone.Gain(0).connect(reverb);
        autopan = new Tone.AutoPanner({ frequency: 0.04, depth: 0.85 }).connect(noiseGain).start(0);
        noiseFilter = new Tone.Filter({ type: 'bandpass', frequency: 600, Q: 1.1 }).connect(autopan);
        noiseLfo = new Tone.LFO({ frequency: 0.05, min: 300, max: 1500, type: 'triangle' }).start(0);
        noiseLfo.connect(noiseFilter.frequency);
        noise = new Tone.Noise(preset.noiseTone).connect(noiseFilter);
        noise.start(0);
        // 노이즈 레벨: 선형 게인(0.06 안팎)으로 은은하게 깔기
        const lvl = 0.085 * preset.noiseLevel;
        noiseGain.gain.setValueAtTime(0, 0);
        noiseGain.gain.linearRampToValueAtTime(lvl, Math.min(6, duration * 0.2));
      }

      // ── 스케줄링 ─────────────────────────────────────────────────
      const secPerBeat = 60 / bpm;
      const barSec = secPerBeat * 4;
      const segSec = barSec * 2; // 코드 2마디 유지
      const numSegs = Math.ceil(duration / segSec) + 1;

      // 멜로디는 단음(mono) 신스라 이벤트 시간이 반드시 오름차순이어야 한다.
      // 세그먼트 내 무작위 시간이 뒤섞일 수 있으므로 전부 모아 정렬 후 스케줄링.
      const melodyEvents = [];

      for (let i = 0; i < numSegs; i++) {
        const t0 = i * segSec;
        if (t0 >= duration) break;
        const chord = preset.chords[i % preset.chords.length];

        if (pad) {
          pad.triggerAttackRelease(chord.pad, segSec * 1.05, t0, 0.45 + rng() * 0.12);
        }
        if (sub) {
          sub.triggerAttackRelease(chord.bass, segSec * 1.02, t0, 0.7);
        }
        if (melody) {
          const count = Math.max(0, Math.round(preset.melodyDensity + (rng() - 0.5) * 2));
          for (let n = 0; n < count; n++) {
            melodyEvents.push({
              at: t0 + rng() * (segSec - 2.5),
              note: preset.scale[Math.floor(rng() * preset.scale.length)],
              dur: 1.4 + rng() * 2.2,
              vel: 0.28 + rng() * 0.32,
            });
          }
        }
      }

      if (melody) {
        melodyEvents.sort((a, b) => a.at - b.at);
        let prev = -1;
        for (const e of melodyEvents) {
          let at = e.at;
          if (at <= prev) at = prev + 0.05; // 엄격히 증가하도록 보정
          if (at >= duration) continue;
          melody.triggerAttackRelease(e.note, e.dur, at, e.vel);
          prev = at;
        }
      }
    }, duration, 2, sampleRate);

    if (onStage) onStage('인코딩 중…');
    // ToneAudioBuffer → 네이티브 AudioBuffer
    const native = typeof buffer.get === 'function' ? buffer.get() : buffer;
    return native;
  }

  window.AmbientEngine = { render: render, PRESETS: PRESETS };
})();
