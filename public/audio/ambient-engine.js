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

    // ── 그루비/플레이리스트 모드(드럼+베이스+코드 스탭) ──────────────
    city_drive: {
      name: '🚗 시티 드라이브 (둠칫 그루브)',
      desc: '드럼·펑키 베이스가 통통 튀는 신나는 시티팝 그루브',
      mode: 'groovy',
      bpm: 104,
      reverbWet: 0.16,
      chords: [
        { stab: ['E4', 'G4', 'B4', 'D5'], bass: 'C2' }, // Cmaj7
        { stab: ['C4', 'E4', 'G4', 'B4'], bass: 'A1' }, // Am7
        { stab: ['F4', 'A4', 'C5', 'E5'], bass: 'D2' }, // Dm7
        { stab: ['F4', 'B4', 'D5'], bass: 'G1' },       // G7
      ],
      scale: ['C5', 'D5', 'E5', 'G5', 'A5', 'C6', 'D6'],
    },
    funky_sunset: {
      name: '🌆 펑키 선셋 (둠칫 그루브)',
      desc: '나른하지만 그루비한 저녁 펑크/소울',
      mode: 'groovy',
      bpm: 100,
      reverbWet: 0.18,
      chords: [
        { stab: ['A3', 'C4', 'E4', 'G4'], bass: 'A1' }, // Am7
        { stab: ['D4', 'F4', 'A4', 'C5'], bass: 'D2' }, // Dm7
        { stab: ['E4', 'G4', 'B4', 'D5'], bass: 'E1' }, // Em7
        { stab: ['F4', 'A4', 'C5', 'E5'], bass: 'F1' }, // Fmaj7
      ],
      scale: ['A4', 'C5', 'D5', 'E5', 'G5', 'A5', 'C6'],
    },

    // ── 앰비언트 추가 ────────────────────────────────────────────
    dreamy_synth: {
      name: '✨ 드리미 신스 (Dreamy Synth)',
      desc: '밝고 몽환적인 신스 패드',
      bpm: 54, reverbWet: 0.6, noiseLevel: 0.2, noiseTone: 'pink', melodyDensity: 1.6,
      chords: [
        { pad: ['C4', 'E4', 'G4', 'D5'], bass: 'C2' },
        { pad: ['B3', 'D4', 'G4', 'A4'], bass: 'G1' },
        { pad: ['A3', 'C4', 'E4', 'G4'], bass: 'A1' },
        { pad: ['F3', 'A3', 'C4', 'E4'], bass: 'F1' },
      ],
      scale: ['C5', 'D5', 'E5', 'G5', 'A5', 'C6'],
    },
    deep_sleep: {
      name: '🌙 깊은 수면 (Deep Sleep)',
      desc: '아주 느리고 미니멀한 저음 중심',
      bpm: 48, reverbWet: 0.7, noiseLevel: 0.3, noiseTone: 'brown', melodyDensity: 0.8,
      chords: [
        { pad: ['A3', 'C4', 'E4', 'B4'], bass: 'A1' },
        { pad: ['E3', 'G3', 'B3', 'D4'], bass: 'E1' },
        { pad: ['F3', 'A3', 'C4', 'E4'], bass: 'F1' },
        { pad: ['C4', 'E4', 'G4', 'B4'], bass: 'C2' },
      ],
      scale: ['A4', 'C5', 'D5', 'E5', 'G5'],
    },

    // ── 그루비 추가 ──────────────────────────────────────────────
    lofi_rain: {
      name: '🌧️ 로파이 (Lo-fi Chill)',
      desc: '나른한 로파이 힙합 비트와 재지한 코드',
      mode: 'groovy', bpm: 82, reverbWet: 0.24, swing: 0.62,
      chords: [
        { stab: ['A3', 'C4', 'E4', 'G4'], bass: 'F1' }, // Fmaj7
        { stab: ['G3', 'B3', 'D4', 'F4'], bass: 'E1' }, // Em7
        { stab: ['F3', 'A3', 'C4', 'E4'], bass: 'D2' }, // Dm7
        { stab: ['E4', 'G4', 'B4', 'D5'], bass: 'C2' }, // Cmaj7
      ],
      scale: ['C5', 'D5', 'E5', 'G5', 'A5', 'C6'],
    },
    night_city: {
      name: '🌃 나이트 시티 (City Pop Night)',
      desc: '세련된 밤의 시티팝 그루브',
      mode: 'groovy', bpm: 98, reverbWet: 0.18,
      chords: [
        { stab: ['F#4', 'A4', 'C#5', 'E5'], bass: 'D2' }, // Dmaj7
        { stab: ['D4', 'F#4', 'A4', 'C#5'], bass: 'B1' }, // Bm7
        { stab: ['B3', 'D4', 'F#4', 'A4'], bass: 'G1' },  // Gmaj7
        { stab: ['C#4', 'G4', 'A4', 'E5'], bass: 'A1' },  // A7
      ],
      scale: ['D5', 'E5', 'F#5', 'A5', 'B5', 'D6'],
    },
  };

  // 그루비 모드: 드럼(킥/스네어/하이햇) + 펑키 베이스 + 코드 스탭 + 스파스 리드.
  // Tone.Offline 콜백 안에서 호출 → 생성되는 노드들이 오프라인 컨텍스트에 바인딩됨.
  // 사용하는 신스(Membrane/Noise/Mono/PolySynth)는 모두 비-워클릿이라 오프라인 안전.
  function buildGroovy(reverb, rng, duration, bpm, preset) {
    const T = Tone;
    const drumBus = new T.Gain(0.9).connect(reverb);

    const kick = new T.MembraneSynth({
      pitchDecay: 0.03, octaves: 6,
      envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 }, volume: -5,
    }).connect(drumBus);

    const snare = new T.NoiseSynth({
      noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.16, sustain: 0 }, volume: -13,
    });
    const snareFilter = new T.Filter(1500, 'highpass').connect(drumBus);
    snare.connect(snareFilter);

    const hat = new T.NoiseSynth({
      noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.04, sustain: 0 }, volume: -22,
    });
    const hatFilter = new T.Filter(7000, 'highpass').connect(drumBus);
    hat.connect(hatFilter);

    const bass = new T.MonoSynth({
      oscillator: { type: 'sawtooth' },
      filter: { Q: 2, type: 'lowpass' },
      filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.35, release: 0.2, baseFrequency: 120, octaves: 2.6 },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.2 }, volume: -7,
    }).connect(reverb);

    const chordSynth = new T.PolySynth(T.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.01, decay: 0.32, sustain: 0.18, release: 0.3 }, volume: -15,
    }).connect(reverb);
    chordSynth.maxPolyphony = 16;

    const lead = new T.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.01, decay: 0.15, sustain: 0.1, release: 0.2 }, volume: -19,
    }).connect(reverb);

    const spb = 60 / bpm, bar = spb * 4, eighth = spb / 2;
    const numBars = Math.ceil(duration / bar);
    const chords = preset.chords, scale = preset.scale;
    const fits = (t) => t < duration - 0.05;

    // 스윙(셔플) 비율: 0.5=정박, 클수록 오프비트가 뒤로 밀려 "그루비"해짐.
    // 로파이는 깊게, 시티팝은 가볍게. preset.swing로 덮어쓸 수 있음.
    const swing = preset.swing != null ? preset.swing : 0.55;
    // 8분음표 인덱스 e(0..7)의 바 내 시작 시간 — 오프비트(홀수)를 스윙만큼 지연.
    const eighthAt = (t0, e) => t0 + Math.floor(e / 2) * spb + (e % 2 ? spb * swing : 0);
    // 미세 타이밍 흔들림(±ms) — 기계적이지 않게. 간격(>=eighth)보다 훨씬 작아 순서는 유지됨.
    const hz = (ms) => (rng() * 2 - 1) * (ms / 1000);
    // 벨로시티 휴머나이즈
    const vh = (base, amt) => Math.max(0.05, Math.min(1, base + (rng() * 2 - 1) * amt));

    function bassTriplet(root) {
      const f = T.Frequency(root);
      return { root: root, oct: f.transpose(12).toNote(), fifth: f.transpose(7).toNote() };
    }

    for (let b = 0; b < numBars; b++) {
      const t0 = b * bar;
      if (t0 >= duration) break;
      const chord = chords[b % chords.length];
      const bn = bassTriplet(chord.bass);
      const intro = b < 2;                 // 인트로 2마디: 드럼 빼고 코드·베이스로 빌드업
      const fill = !intro && b % 4 === 3;  // 4마디마다 마지막 마디에 필인

      // 킥: 4-on-the-floor (인트로 제외). 필 마디는 4박째를 비워 필인에 공간.
      if (!intro) {
        for (let beat = 0; beat < 4; beat++) {
          if (fill && beat === 3) continue;
          const t = t0 + beat * spb + hz(6);
          if (fits(t)) kick.triggerAttackRelease('C1', 0.18, t, vh(0.92, 0.05));
        }
      }
      // 스네어: 2·4박 + 고스트 스네어(엇박, 아주 약하게)로 펑크 그루브
      if (!intro && !fill) {
        for (const beat of [1, 3]) {
          const t = t0 + beat * spb + hz(7);
          if (fits(t)) snare.triggerAttackRelease(0.16, t, vh(0.85, 0.06));
        }
        // 고스트: 3박 직전 16분 위치
        const tg = t0 + 2.75 * spb + hz(5);
        if (fits(tg)) snare.triggerAttackRelease(0.05, tg, 0.18 + rng() * 0.1);
      }
      // 하이햇: 8분, 오프비트 강세("칫"). 스윙 적용.
      if (!intro) {
        for (let e = 0; e < 8; e++) {
          const t = eighthAt(t0, e) + hz(4);
          if (fits(t)) hat.triggerAttackRelease(0.03, t, vh(e % 2 ? 0.65 : 0.35, 0.08));
        }
      }
      // 필인: 4박째를 16분 스네어 롤로 채워 다음 섹션으로 밀어줌
      if (fill) {
        for (let k = 0; k < 4; k++) {
          const t = t0 + (3 + k * 0.25) * spb + hz(4);
          if (fits(t)) snare.triggerAttackRelease(0.07, t, 0.4 + k * 0.16);
        }
        const tk = t0 + 3 * spb;
        if (fits(tk)) kick.triggerAttackRelease('C1', 0.18, tk, 0.9);
      }
      // 베이스: 펑키 8분 패턴 (스윙 적용). 인트로엔 루트만 길게.
      if (intro) {
        if (fits(t0)) bass.triggerAttackRelease(bn.root, bar * 0.95, t0 + hz(4), 0.7);
      } else {
        const pat = [bn.root, null, bn.root, bn.oct, null, bn.fifth, bn.root, null];
        for (let e = 0; e < 8; e++) {
          const n = pat[e];
          const t = eighthAt(t0, e) + hz(5);
          if (n && fits(t)) bass.triggerAttackRelease(n, eighth * 0.9, t, vh(0.85, 0.07));
        }
      }
      // 코드 스탭: 1박 + 2·4박의 뒷박(엇박). 인트로는 더 부드럽게.
      if (fits(t0)) chordSynth.triggerAttackRelease(chord.stab, 0.18, t0 + hz(6), intro ? 0.4 : vh(0.5, 0.08));
      for (const off of [1.5, 3.5]) {
        const t = t0 + off * spb + hz(6);
        if (fits(t)) chordSynth.triggerAttackRelease(chord.stab, 0.22, t, vh(0.55, 0.08));
      }
      // 리드: 2마디마다 스파스 리프 (인트로 제외). 스윙 그리드 위에 얹음.
      if (!intro && b % 2 === 1) {
        let prev = -1;
        for (let k = 0; k < 3; k++) {
          let t = eighthAt(t0, 4 + k) + hz(5);
          if (t <= prev) t = prev + 0.05;
          const note = scale[Math.floor(rng() * scale.length)];
          if (fits(t)) lead.triggerAttackRelease(note, eighth, t, vh(0.5, 0.12));
          prev = t;
        }
      }
    }
  }

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

      // 리버브: 컨볼루션(ConvolverNode). 감쇠 노이즈로 임펄스 응답(IR)을 직접 생성한다.
      // Tone.Freeverb·JCReverb는 AudioWorklet 기반이라 오프라인 렌더에서 멈춤 → 사용하지 않음.
      // ConvolverNode는 네이티브라 오프라인에서 안전하고, IR 정규화로 레벨이 안정적이다.
      const wetAmt = Math.max(0, Math.min(0.9, reverbWet));
      const rawCtx = Tone.getContext().rawContext;
      const irSeconds = 2.8;
      const irLen = Math.floor(irSeconds * sampleRate);
      const ir = rawCtx.createBuffer(2, irLen, sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < irLen; i++) {
          const t = i / irLen;
          const env = Math.pow(1 - t, 2.6); // 부드러운 지수형 감쇠
          d[i] = (rng() * 2 - 1) * env;
        }
      }
      // Convolver는 ToneAudioNode(웻 100%)라 드라이/웻을 직접 라우팅한다.
      const reverb = new Tone.Gain(1); // 악기 합류 지점
      const dryGain = new Tone.Gain(1).connect(limiter);
      const wetGain = new Tone.Gain(wetAmt).connect(limiter);
      reverb.connect(dryGain);
      const conv = new Tone.Convolver();
      conv.buffer = ir;
      reverb.connect(conv);
      conv.connect(wetGain);

      // 페이드 인/아웃
      const targetLevel = 0.85;
      const fadeIn = Math.min(3, duration * 0.1);
      const fadeOut = Math.min(6, duration * 0.18);
      master.gain.setValueAtTime(0.0001, 0);
      master.gain.linearRampToValueAtTime(targetLevel, fadeIn);
      master.gain.setValueAtTime(targetLevel, Math.max(fadeIn, duration - fadeOut));
      master.gain.linearRampToValueAtTime(0.0001, duration);

      if (preset.mode === 'groovy') {
        // ── 그루비/플레이리스트 모드 ───────────────────────────────
        buildGroovy(reverb, rng, duration, bpm, preset);
      } else {
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
      } // end else (ambient mode)
    }, duration, 2, sampleRate);

    if (onStage) onStage('인코딩 중…');
    // ToneAudioBuffer → 네이티브 AudioBuffer
    const native = typeof buffer.get === 'function' ? buffer.get() : buffer;

    // 피크 노멀라이즈: 프리셋/레이어와 무관하게 -1dBFS(≈0.89) 근처로 레벨 일정화.
    // (악기들이 의도적으로 낮게 믹스되어 그대로면 너무 작음)
    let peak = 0;
    for (let c = 0; c < native.numberOfChannels; c++) {
      const d = native.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    }
    if (peak > 0.0001) {
      const gain = Math.min(12, 0.89 / peak); // 거의 무음일 때 과증폭 방지
      for (let c = 0; c < native.numberOfChannels; c++) {
        const d = native.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] *= gain;
      }
    }
    return native;
  }

  window.AmbientEngine = { render: render, PRESETS: PRESETS };
})();
