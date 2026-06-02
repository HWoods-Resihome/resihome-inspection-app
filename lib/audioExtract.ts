/**
 * Client-side audio extraction for transcription.
 *
 * A full room video is far too large for /api/transcribe (and Whisper's 25MB
 * limit). But the AUDIO alone, decoded and re-encoded as 16 kHz mono 16-bit
 * WAV, is tiny (~1MB/min) and is exactly the format speech models want. We
 * decode the video's audio track with Web Audio, resample to 16 kHz mono via an
 * OfflineAudioContext, and emit a WAV blob.
 *
 * Returns null if the browser can't decode the track (we fall back to skipping
 * the voice-over rather than failing the scan).
 */

const TARGET_RATE = 16000;

export async function extractAudioWav16k(file: Blob): Promise<Blob | null> {
  try {
    if (typeof window === 'undefined') return null;
    const AC: typeof AudioContext | undefined =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    const OAC: typeof OfflineAudioContext | undefined =
      (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    if (!AC || !OAC) return null;

    const arr = await file.arrayBuffer();

    // Decode the container's audio track. decodeAudioData consumes the buffer,
    // so pass a copy.
    const decodeCtx = new AC();
    let decoded: AudioBuffer;
    try {
      decoded = await decodeCtx.decodeAudioData(arr.slice(0));
    } finally {
      try { await decodeCtx.close(); } catch { /* noop */ }
    }
    if (!decoded || decoded.duration <= 0) return null;

    // Resample → 16 kHz mono (connecting a multi-channel source to a 1-channel
    // destination downmixes automatically).
    const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
    const offline = new OAC(1, frames, TARGET_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    const pcm = rendered.getChannelData(0);
    if (!pcm || pcm.length === 0) return null;

    return encodeWav16(pcm, TARGET_RATE);
  } catch {
    return null;
  }
}

// Encode mono Float32 PCM as a 16-bit little-endian WAV.
function encodeWav16(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);      // PCM chunk size
  view.setUint16(20, 1, true);       // PCM format
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 2 bytes/sample)
  view.setUint16(32, 2, true);       // block align
  view.setUint16(34, 16, true);      // bits/sample
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}
