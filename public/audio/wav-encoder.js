/**
 * AudioBuffer → WAV(PCM) Blob 인코더.
 * 기본 24-bit 정수 PCM(고음질). 16-bit도 지원.
 */
(function () {
  function clamp(x) {
    return x < -1 ? -1 : x > 1 ? 1 : x;
  }

  function encodeWav(audioBuffer, bitDepth) {
    bitDepth = bitDepth || 24;
    const numCh = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const numFrames = audioBuffer.length;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numCh * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    let offset = 0;
    function writeString(s) {
      for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i));
    }
    function writeUint32(v) { view.setUint32(offset, v, true); offset += 4; }
    function writeUint16(v) { view.setUint16(offset, v, true); offset += 2; }

    // RIFF 헤더
    writeString('RIFF');
    writeUint32(36 + dataSize);
    writeString('WAVE');
    // fmt 청크
    writeString('fmt ');
    writeUint32(16);
    writeUint16(1); // PCM
    writeUint16(numCh);
    writeUint32(sampleRate);
    writeUint32(sampleRate * blockAlign);
    writeUint16(blockAlign);
    writeUint16(bitDepth);
    // data 청크
    writeString('data');
    writeUint32(dataSize);

    // 채널 데이터 미리 확보
    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(audioBuffer.getChannelData(c));

    if (bitDepth === 16) {
      for (let i = 0; i < numFrames; i++) {
        for (let c = 0; c < numCh; c++) {
          const s = clamp(channels[c][i]);
          view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          offset += 2;
        }
      }
    } else {
      // 24-bit
      for (let i = 0; i < numFrames; i++) {
        for (let c = 0; c < numCh; c++) {
          const s = clamp(channels[c][i]);
          let val = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
          if (val < 0) val += 0x1000000;
          view.setUint8(offset++, val & 0xff);
          view.setUint8(offset++, (val >> 8) & 0xff);
          view.setUint8(offset++, (val >> 16) & 0xff);
        }
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  window.WavEncoder = { encodeWav: encodeWav };
})();
