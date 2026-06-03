/**
 * KnowledgeTrainerModal — "Teach the AI" popup.
 *
 * Opens over the AI camera. The inspector taps record, speaks a tip / house rule
 * ("gutter cleaning is always 100% tenant", "broken blinds are always faux wood
 * replacements"), and we transcribe it via /api/transcribe. They review and edit
 * the text, then submit it to the AI knowledge base (POST /api/ai-knowledge),
 * where it goes live immediately for the in-camera call-out model and admins can
 * later curate it. Purpose: inspectors train and grow the AI from the field.
 *
 * Uses its OWN short-clip mic (push-to-talk), independent of the camera's stream,
 * so opening/closing it never disturbs the camera. RECORD_AUDIO is already
 * granted for the AI camera, so no new native permission is needed.
 */
import { useEffect, useRef, useState } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: (text: string) => void;
}

type Phase = 'idle' | 'recording' | 'transcribing' | 'review' | 'saving' | 'done';

function pickAudioMime(): string {
  const MR: any = (typeof window !== 'undefined') && (window as any).MediaRecorder;
  if (!MR?.isTypeSupported) return '';
  const isIOS = typeof navigator !== 'undefined'
    && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1));
  const order = isIOS
    ? ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const m of order) { try { if (MR.isTypeSupported(m)) return m; } catch { /* noop */ } }
  return '';
}
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const r = reader.result as string; const c = r.indexOf(','); resolve(c >= 0 ? r.slice(c + 1) : r); };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function KnowledgeTrainerModal({ open, onClose, onSaved }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [secs, setSecs] = useState(0);

  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const partsRef = useRef<BlobPart[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset everything whenever the modal is (re)opened.
  useEffect(() => {
    if (open) { setPhase('idle'); setText(''); setErr(''); setSecs(0); }
    return () => { cleanupMic(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function cleanupMic() {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    try { if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop(); } catch { /* noop */ }
    recRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function startRecording() {
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickAudioMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recRef.current = rec;
      partsRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) partsRef.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(partsRef.current, { type: rec.mimeType || mime || 'audio/mp4' });
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (blob.size > 1000) void transcribe(blob);
        else { setPhase('idle'); setErr('Didn’t catch that — try again.'); }
      };
      rec.start();
      setSecs(0);
      setPhase('recording');
      tickRef.current = setInterval(() => setSecs((s) => s + 1), 1000);
    } catch (e: any) {
      setErr(e?.name === 'NotAllowedError' ? 'Microphone blocked — allow mic access.' : `Mic error: ${String(e?.message || e).slice(0, 60)}`);
      setPhase('idle');
    }
  }

  function stopRecording() {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    try { if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop(); } catch { /* noop */ }
  }

  async function transcribe(blob: Blob) {
    setPhase('transcribing');
    try {
      const base64 = await blobToBase64(blob);
      const r = await fetch('/api/transcribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mime: (blob.type || 'audio/mp4').split(';')[0] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(`Transcription failed: ${String(d?.error || r.status).slice(0, 80)}`); setPhase('idle'); return; }
      const t = String(d.text || '').trim();
      // Append to any text already captured so a second take adds to the first.
      setText((prev) => (prev ? `${prev} ${t}` : t).trim());
      setPhase('review');
    } catch (e: any) {
      setErr(`Transcription error: ${String(e?.message || e).slice(0, 60)}`);
      setPhase('idle');
    }
  }

  async function submit() {
    const body = text.trim();
    if (!body) return;
    setPhase('saving');
    setErr('');
    try {
      const r = await fetch('/api/ai-knowledge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(String(d?.error || 'Save failed').slice(0, 120)); setPhase('review'); return; }
      setPhase('done');
      onSaved?.(body);
      window.setTimeout(() => onClose(), 1100);
    } catch (e: any) {
      setErr(`Save error: ${String(e?.message || e).slice(0, 60)}`);
      setPhase('review');
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={() => { cleanupMic(); onClose(); }} />
      <div className="relative w-[92vw] max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="bg-brand text-white px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" /></svg>
            <span className="font-heading font-bold text-base">Teach the AI</span>
          </div>
          <button type="button" onClick={() => { cleanupMic(); onClose(); }} aria-label="Close" className="text-white/90 hover:text-white text-2xl leading-none w-7 h-7 flex items-center justify-center">×</button>
        </div>

        <div className="p-4">
          <p className="text-[13px] text-gray-600 mb-3 leading-snug">
            Speak a tip or rule to train the live AI call-outs — e.g. “gutter cleaning is always 100% tenant” or “a broken blind is always a faux wood replacement.” Review the text, then add it to the knowledge base.
          </p>

          {/* Record / Stop */}
          {(phase === 'idle' || phase === 'recording') && (
            <div className="flex flex-col items-center py-4">
              <button
                type="button"
                onClick={phase === 'recording' ? stopRecording : startRecording}
                className={`w-20 h-20 rounded-full flex items-center justify-center shadow-lg transition active:scale-95 ${phase === 'recording' ? 'bg-rose-600 animate-pulse' : 'bg-brand'}`}
                aria-label={phase === 'recording' ? 'Stop recording' : 'Start recording'}
              >
                {phase === 'recording' ? (
                  <span className="w-7 h-7 bg-white rounded-md" />
                ) : (
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" /></svg>
                )}
              </button>
              <div className="mt-3 text-sm font-heading font-semibold text-gray-700">
                {phase === 'recording' ? `Listening… ${secs}s — tap to stop` : (text ? 'Tap to record more' : 'Tap to record')}
              </div>
            </div>
          )}

          {phase === 'transcribing' && (
            <div className="flex items-center justify-center gap-2 py-8 text-gray-600">
              <span className="w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
              <span className="text-sm font-heading">Transcribing…</span>
            </div>
          )}

          {/* Review + edit */}
          {(phase === 'review' || phase === 'saving' || phase === 'done') && (
            <div>
              <label className="block text-xs font-heading font-semibold text-gray-500 mb-1">Knowledge to add</label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                disabled={phase === 'saving' || phase === 'done'}
                className="focus-brand w-full border border-gray-300 rounded-lg p-2.5 text-sm text-ink resize-y disabled:bg-gray-50"
                placeholder="What should the AI learn?"
              />
              <div className="flex items-center justify-between gap-2 mt-3">
                <button
                  type="button"
                  onClick={() => { setPhase('idle'); }}
                  disabled={phase === 'saving' || phase === 'done'}
                  className="text-sm font-heading font-semibold text-gray-600 hover:text-gray-900 disabled:opacity-50"
                >
                  ↺ Re-record
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!text.trim() || phase === 'saving' || phase === 'done'}
                  className="flex-1 max-w-[60%] h-10 rounded-lg bg-emerald-600 text-white font-heading font-bold text-sm hover:bg-emerald-700 disabled:bg-gray-300"
                >
                  {phase === 'done' ? '✓ Added' : phase === 'saving' ? 'Adding…' : 'Add to AI Knowledge'}
                </button>
              </div>
            </div>
          )}

          {err && <div className="mt-3 text-[13px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{err}</div>}
        </div>
      </div>
    </div>
  );
}
