// Shared Web Speech API helpers — used by both the floating voice mic and the
// in-camera AI layer so they transcribe the SAME way on a given device.
//
// On Android Chrome / desktop Chrome the browser's SpeechRecognition transcribes
// ON DEVICE in near-real-time (no audio upload, no server round-trip) — this is
// why the mic feels instant. iOS/desktop Safari expose webkitSpeechRecognition
// too, but it's flaky (bad start/stop, extra permission prompts, frequent
// errors), so there we prefer the push-to-talk MediaRecorder → Whisper path.

/** True on platforms where Web Speech is unreliable and we should use Whisper. */
export function preferWhisper(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iOS = /iP(hone|ad|od)/.test(ua)
    || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
  const isSafari = /^((?!chrome|crios|android|fxios|edg|opr).)*safari/i.test(ua);
  return iOS || isSafari;
}

/**
 * Construct a fresh SpeechRecognition tuned for one clean final transcript per
 * utterance (interimResults + continuous cause severe duplication on Android
 * WebView). Returns null when the API is unavailable.
 */
export function getRecognition(): any | null {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) return null;
  const r = new Ctor();
  r.lang = 'en-US';
  r.interimResults = false;
  r.maxAlternatives = 1;
  r.continuous = false;
  return r;
}

/** True if on-device Web Speech is the preferred transcription path here. */
export function canUseWebSpeech(): boolean {
  return !preferWhisper() && getRecognition() !== null;
}
