// components/VoiceLineAssistant.tsx
//
// Per-section conversational assistant for adding Scope rate-card lines by voice.
// Online-only. Uses the browser Web Speech API for input (Decision 3-A) and the
// /api/rate-card/voice-assist agent (Claude tool-calling + Voyage matching).
//
// It NEVER saves directly: when the agent returns a complete line proposal, this
// shows it as a draft the inspector confirms; on confirm it calls onAddLine(),
// which routes through RateCardForm's existing save path (server-authoritative
// math + natural-key upsert). Reject discards it.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RateCardLineInput, RateCardLineItem } from '@/lib/types';

interface Props {
  section: string;        // base section name (e.g. "Yard / Exterior")
  location: string;       // location label (e.g. "Bedroom 1" or "")
  region: string;         // inspection region snapshot (for context only)
  // Called when the inspector confirms a proposed line (new OR edited). Reuses
  // RateCardForm's handleSaveLineForSection, which upserts by externalId — so
  // passing an existing line's externalId edits it in place.
  onAddLine: (line: RateCardLineInput) => void;
  // The lines already in this section (so the agent can edit them by voice).
  currentLines?: RateCardLineInput[];
  // Catalog for resolving codes -> descriptions in edit summaries.
  catalog?: RateCardLineItem[];
  disabled?: boolean;
}

type ChatMsg = { role: 'user' | 'assistant'; content: string };

type Pending = { line: RateCardLineInput; summary: string; action: 'add' | 'edit' };

// Affirmatives that commit a pending proposal when spoken.
const AFFIRMATIVE = /^(yes|yep|yeah|yup|sure|ok|okay|correct|add it|add|do it|confirm|that'?s right|looks good|perfect|go ahead)\b/i;

// Minimal typing for the vendor-prefixed SpeechRecognition (webkit on most
// mobile webviews). We feature-detect at runtime.
function getRecognition(): any | null {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) return null;
  const r = new Ctor();
  r.lang = 'en-US';
  r.interimResults = true;   // needed so we can detect ongoing speech across pauses
  r.maxAlternatives = 1;
  r.continuous = true;       // keep listening through natural pauses; we end it ourselves
  return r;
}

// How long to wait after the inspector stops talking before finalizing the
// utterance. Browser SpeechRecognition has no native silence-timeout knob, so
// we run our own timer and only submit once speech has paused this long.
const SILENCE_MS = 1500;

// Speak text aloud via the browser's built-in speechSynthesis (free, no API,
// works in the mobile webview). Calls onDone when finished (or immediately if
// TTS is unavailable) so the caller can chain the mic auto-restart.
function speak(text: string, onDone: () => void) {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) {
      onDone();
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.3;
    u.onend = () => onDone();
    u.onerror = () => onDone();
    window.speechSynthesis.speak(u);
  } catch {
    onDone();
  }
}

export function VoiceLineAssistant({ section, location, region, onAddLine, currentLines, catalog, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [warming, setWarming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [typed, setTyped] = useState('');
  const recogRef = useRef<any>(null);
  // Synchronous guards (state updates are async, so we can't rely on `listening`
  // inside the start handler to prevent double-starts).
  const startingRef = useRef(false);
  const listeningRef = useRef(false);
  // Silence timer + accumulated final transcript across pauses.
  const silenceTimerRef = useRef<any>(null);
  const finalTranscriptRef = useRef('');
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  // Holds the latest startListening so TTS-onend can trigger it without stale closures.
  const startListeningRef = useRef<() => void>(() => {});
  // Synchronous access to the pending proposal (for the affirmative intercept).
  const pendingRef = useRef<Pending | null>(null);
  const commitPendingRef = useRef<() => void>(() => {});
  // When true, start listening as soon as warm-up completes (set on panel open).
  const wantAutoStartRef = useRef(false);

  useEffect(() => {
    setSupported(getRecognition() !== null);
  }, []);

  // Warm-up: when the panel opens, ping the endpoint (GET) so the catalog +
  // embeddings cold-start work happens BEFORE the first spoken line. We surface
  // a "getting ready" state on the mic so the inspector knows it's priming.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setWarming(true);
    (async () => {
      try {
        await fetch('/api/rate-card/voice-assist', { method: 'GET' });
      } catch { /* non-fatal */ }
      if (!cancelled) {
        setWarming(false);
        // If the panel was just opened, start listening now that we're primed.
        if (wantAutoStartRef.current) {
          wantAutoStartRef.current = false;
          setTimeout(() => { startListeningRef.current(); }, 0);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const sendToAgent = useCallback(
    async (history: ChatMsg[]) => {
      setBusy(true);
      setError(null);
      setStreamingText('');
      let accumulated = '';
      try {
        const r = await fetch('/api/rate-card/voice-assist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: history,
            section,
            location,
            region,
            currentLines: (currentLines || []).map((l) => ({
              externalId: l.externalId,
              lineItemCode: l.lineItemCode,
              quantity: l.quantity,
              assignedTo: l.assignedTo,
              tenantBillBackPercent: l.tenantBillBackPercent,
            })),
          }),
        });
        if (!r.ok || !r.body) {
          // Try to read a JSON error (non-stream failure path).
          let msg = `HTTP ${r.status}`;
          try { const j = await r.json(); msg = j.error || msg; } catch { /* noop */ }
          throw new Error(msg);
        }

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalType: string | null = null;
        let finalData: any = null;

        // Parse the SSE event stream.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() || '';
          for (const chunk of chunks) {
            const lines = chunk.split('\n');
            let ev = 'message';
            let dataStr = '';
            for (const l of lines) {
              if (l.startsWith('event:')) ev = l.slice(6).trim();
              else if (l.startsWith('data:')) dataStr += l.slice(5).trim();
            }
            if (!dataStr) continue;
            let data: any;
            try { data = JSON.parse(dataStr); } catch { continue; }

            if (ev === 'delta') {
              accumulated += data.text || '';
              setStreamingText(accumulated);
            } else if (ev === 'question' || ev === 'proposal' || ev === 'message' || ev === 'error') {
              finalType = ev;
              finalData = data;
            } else if (ev === 'done') {
              // terminal
            }
          }
        }

        // Finalize based on the last terminal event.
        setStreamingText('');
        if (finalType === 'error') {
          setError(finalData?.error || 'Something went wrong.');
        } else if (finalType === 'proposal') {
          // Hold the proposal as PENDING — preview it, ask for confirmation, and
          // wait for a spoken "yes" / change, or a button tap. Nothing saves yet.
          const line: RateCardLineInput = finalData.line;
          setPending({ line, summary: finalData.summary, action: finalData.action === 'edit' ? 'edit' : 'add' });
          const verb = finalData.action === 'edit' ? 'Change to' : 'Add this';
          const prompt = `${verb}: ${finalData.summary}. Is this what you want, or any changes?`;
          setMessages((m) => [...m, { role: 'assistant', content: prompt }]);
          // Speak the prompt, then reopen the mic to catch "yes" or a change.
          speak(prompt, () => { startListeningRef.current(); });
        } else {
          // question or message — the text already streamed; finalize it.
          const text = finalData?.text || accumulated;
          setMessages((m) => [...m, { role: 'assistant', content: text }]);
          speak(text, () => {
            if (finalData?.awaitingReply) startListeningRef.current();
          });
        }
      } catch (e: any) {
        setStreamingText('');
        setError(String(e?.message || e));
      } finally {
        setBusy(false);
      }
    },
    [section, location, region, currentLines, onAddLine]
  );

  const submitUtterance = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      // If a proposal is pending and the inspector just said "yes"/"add it",
      // commit it directly rather than round-tripping the agent.
      if (pendingRef.current && AFFIRMATIVE.test(t)) {
        setMessages((m) => [...m, { role: 'user', content: t }]);
        commitPendingRef.current();
        return;
      }
      const next: ChatMsg[] = [...messages, { role: 'user', content: t }];
      setMessages(next);
      void sendToAgent(next);
    },
    [messages, sendToAgent]
  );

  const startListening = useCallback(() => {
    setError(null);
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }

    // Guard: if we're already listening (or a recognition is mid-start), don't
    // start a second one — calling start() on an active recognizer throws and
    // surfaces a spurious "aborted" error.
    if (startingRef.current || listeningRef.current) return;

    const recog = getRecognition();
    if (!recog) { setSupported(false); return; }

    // Tear down any previous instance cleanly first.
    if (recogRef.current) {
      try {
        recogRef.current.onresult = null;
        recogRef.current.onerror = null;
        recogRef.current.onend = null;
        recogRef.current.abort?.();
      } catch { /* noop */ }
    }
    recogRef.current = recog;
    startingRef.current = true;
    finalTranscriptRef.current = '';

    const clearSilence = () => {
      if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    };
    const finalize = () => {
      clearSilence();
      const text = finalTranscriptRef.current.trim();
      finalTranscriptRef.current = '';
      try { recog.stop(); } catch { /* noop */ }
      listeningRef.current = false;
      setListening(false);
      if (text) submitUtterance(text);
    };

    recog.onresult = (ev: any) => {
      // Accumulate finalized chunks; any result (interim or final) means the
      // inspector is still talking, so reset the silence countdown.
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalTranscriptRef.current += (finalTranscriptRef.current ? ' ' : '') + (r[0]?.transcript || '').trim();
      }
      clearSilence();
      // Wait for a longer pause before deciding the inspector is done.
      silenceTimerRef.current = setTimeout(finalize, SILENCE_MS);
    };
    recog.onerror = (ev: any) => {
      startingRef.current = false;
      listeningRef.current = false;
      clearSilence();
      setListening(false);
      const code = ev?.error;
      // 'aborted' (we stopped/superseded it) and 'no-speech' (silence timeout)
      // are benign — don't show them as errors.
      if (code === 'aborted' || code === 'no-speech') return;
      setError(code === 'not-allowed'
        ? 'Microphone permission denied.'
        : `Couldn't hear that (${code || 'error'}). Try again or type below.`);
    };
    recog.onstart = () => {
      startingRef.current = false;
      listeningRef.current = true;
      setListening(true);
    };
    recog.onend = () => {
      startingRef.current = false;
      listeningRef.current = false;
      // If recognition ended on its own (e.g. mobile hard cap) but we captured
      // speech, submit what we have rather than dropping it.
      const captured = finalTranscriptRef.current.trim();
      if (captured && !silenceTimerRef.current) {
        finalTranscriptRef.current = '';
        setListening(false);
        submitUtterance(captured);
        return;
      }
      setListening(false);
    };

    try {
      recog.start();
    } catch {
      startingRef.current = false;
      listeningRef.current = false;
      setListening(false);
    }
  }, [submitUtterance]);

  const stopListening = useCallback(() => {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    try { recogRef.current?.stop(); } catch { /* noop */ }
    startingRef.current = false;
    listeningRef.current = false;
    setListening(false);
    // If the inspector tapped stop after speaking, submit what we captured.
    const captured = finalTranscriptRef.current.trim();
    finalTranscriptRef.current = '';
    if (captured) submitUtterance(captured);
  }, [submitUtterance]);

  // Keep the ref pointing at the latest startListening so TTS-onend (which
  // captures an older closure) always calls the current one.
  useEffect(() => { startListeningRef.current = startListening; }, [startListening]);

  // Commit the pending proposal: save it (the CLIENT announces success only
  // after the save), then prompt for the next line and reopen the mic.
  const commitPending = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    setPending(null);
    const verb = p.action === 'edit' ? 'Updated' : 'Added';
    try {
      onAddLine(p.line);
      const confirm = `${verb}: ${p.summary}. Anything else for this area?`;
      setMessages((m) => [...m, { role: 'assistant', content: confirm }]);
      speak(confirm, () => { startListeningRef.current(); });
    } catch (e: any) {
      const msg = `I couldn't save that line (${String(e?.message || e)}). Try again or add it manually.`;
      setMessages((m) => [...m, { role: 'assistant', content: msg }]);
      speak(msg, () => { /* no restart on failure */ });
    }
  }, [onAddLine]);

  // Keep synchronous refs current for the affirmative intercept.
  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => { commitPendingRef.current = commitPending; }, [commitPending]);

  // Auto-scroll the transcript to the newest message / streaming text.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, pending]);

  // Stop any in-progress speech if the panel unmounts.
  useEffect(() => () => {
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
  }, []);

  function reset() {
    stopListening();
    setMessages([]);
    setPending(null);
    setError(null);
    setTyped('');
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          // Auto-start the mic once warm-up finishes (so the icon shows
          // "Getting ready…" then "Listening"). The warm-up effect triggers it.
          wantAutoStartRef.current = true;
        }}
        disabled={disabled}
        aria-label="Add line items by voice"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-brand text-brand rounded hover:bg-brand/5 disabled:opacity-50"
      >
        <MicIcon className="w-4 h-4" />
        Voice add
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-brand/30 bg-brand/5 p-3 mt-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-heading font-semibold text-brand">Voice Assistant — {location || section}</span>
        <button type="button" onClick={() => { reset(); setOpen(false); }} className="text-xs text-gray-500 hover:text-gray-700">
          Close
        </button>
      </div>

      {!supported && (
        <p className="text-xs text-amber-700 mb-2">
          Voice input isn&apos;t available in this browser. You can still type a request below.
        </p>
      )}

      {/* Transcript */}
      {(messages.length > 0 || streamingText) && (
        <div ref={transcriptRef} className="max-h-56 overflow-y-auto mb-2">
          <div className="space-y-1.5">
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
                <span className={
                  'inline-block px-2.5 py-1 rounded-lg text-sm ' +
                  (m.role === 'user' ? 'bg-brand text-white' : 'bg-white border border-gray-200 text-ink')
                }>
                  {m.content}
                </span>
              </div>
            ))}
            {/* Live streaming reply (tokens as they generate) */}
            {streamingText && (
              <div className="text-left">
                <span className="inline-block px-2.5 py-1 rounded-lg text-sm bg-white border border-gray-200 text-ink">
                  {streamingText}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Pending proposal preview — confirm by voice ("yes") or button. */}
      {pending && (
        <div className="rounded-md border border-teal-300 bg-teal-50 p-2.5 mb-2">
          <div className="text-xs font-heading font-semibold text-teal-800 mb-1">
            {pending.action === 'edit' ? 'Apply this change?' : 'Add this line?'}
          </div>
          <div className="text-sm text-ink mb-2">{pending.summary}</div>
          <div className="flex gap-2">
            <button type="button" onClick={() => { stopListening(); commitPending(); }}
              className="px-3 py-1 text-sm bg-teal-600 text-white rounded hover:bg-teal-700">
              {pending.action === 'edit' ? 'Apply' : 'Add it'}
            </button>
            <button type="button" onClick={() => { setPending(null); startListening(); }}
              className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100">
              Change
            </button>
          </div>
          <div className="text-[11px] text-gray-500 mt-1.5">…or just say “yes” to add, or tell me what to change.</div>
        </div>
      )}

      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      {/* Controls */}
      <div className="flex items-center gap-2">
        {supported && (
          <button
            type="button"
            onClick={listening ? stopListening : startListening}
            disabled={busy || warming || disabled}
            className={
              'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded disabled:opacity-60 ' +
              (listening ? 'bg-red-600 text-white animate-pulse' : 'bg-brand text-white hover:bg-brand-dark')
            }
          >
            {warming || busy
              ? <SpinnerIcon className="w-4 h-4 animate-spin" />
              : <MicIcon className="w-4 h-4" />}
            {warming ? 'Getting ready…' : listening ? 'Listening… tap to stop' : busy ? 'Thinking…' : 'Speak'}
          </button>
        )}
        {/* Typed fallback (also handy when STT mishears) */}
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { submitUtterance(typed); setTyped(''); } }}
          placeholder="…or type a request"
          disabled={busy || disabled}
          className="flex-1 min-w-0 text-sm border border-gray-300 rounded px-2 py-1.5 bg-white"
        />
      </div>

      {messages.length > 0 && (
        <button type="button" onClick={reset} className="mt-2 text-xs text-gray-500 hover:text-gray-700">
          Start over
        </button>
      )}
    </div>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}
