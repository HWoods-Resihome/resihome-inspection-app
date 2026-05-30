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
  // Remove a line by externalId (for "undo that" / "remove the last line").
  onRemoveLine?: (externalId: string) => void;
  // The lines already in this section (so the agent can edit them by voice).
  currentLines?: RateCardLineInput[];
  // Catalog for resolving codes -> descriptions in edit summaries.
  catalog?: RateCardLineItem[];
  disabled?: boolean;
}

type ChatMsg = { role: 'user' | 'assistant'; content: string };

type Pending = { line: RateCardLineInput; summary: string; spoken: string; action: 'add' | 'edit' };

// Affirmatives that commit a pending proposal when spoken. A leading
// yes/yeah/sure/ok/etc (optionally followed by a short tail) confirms. A bare
// "add <noun>" is a NEW request, so "add" only counts alone or as "add it/that".
const AFFIRMATIVE = /^((yes|yep|yeah|yup|sure|okay|ok|correct|confirm|perfect|go ahead|looks good|that'?s right|do it)\b|add(\s+(it|that))?\s*$)/i;

// Undo phrases that remove the most recently added line.
const UNDO = /\b(undo|scratch that|(remove|delete|cancel|drop)\b.{0,12}\b(line|one|item|that|last)|take that (off|out)|never ?mind that)\b/i;

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

// Make text read more naturally when spoken: expand unit abbreviations and
// currency so TTS says "square feet" not "ess eff", "dollars" not "dollar sign".
function naturalizeForSpeech(text: string): string {
  let t = text;
  // Currency: "$1,278.34" -> "1278 dollars and 34 cents" (approx, spoken-friendly)
  t = t.replace(/\$([\d,]+)(?:\.(\d{2}))?/g, (_m, whole, cents) => {
    const dollars = whole.replace(/,/g, '');
    const c = cents && cents !== '00' ? ` and ${Number(cents)} cents` : '';
    return `${Number(dollars).toLocaleString('en-US')} dollars${c}`;
  });
  // Units as standalone tokens (avoid touching words). Order matters.
  t = t
    .replace(/\bSF\b/g, 'square feet')
    .replace(/\bLF\b/g, 'linear feet')
    .replace(/\bEA\b/g, 'each')
    .replace(/\bHR\b/g, 'hours')
    .replace(/\bSY\b/g, 'square yards');
  return t;
}

// Speak text aloud via the browser's built-in speechSynthesis (free, no API,
// works in the mobile webview). Calls onDone when finished. If earlyMs > 0, we
// fire onDone that many ms BEFORE speech is estimated to end, so the mic can
// open early. To prevent echo (the mic transcribing the AI's own voice), the
// caller is told when speech actually STARTS and ENDS via onSpeakingChange, and
// the recognizer ignores any results received while speaking is true.
function speak(
  text: string,
  onDone: () => void,
  earlyMs = 0,
  onSpeakingChange?: (speaking: boolean) => void
) {
  let done = false;
  const finish = () => { if (done) return; done = true; onDone(); };
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) {
      onSpeakingChange?.(false);
      finish();
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(naturalizeForSpeech(text));
    u.rate = 1.3;
    u.onstart = () => { onSpeakingChange?.(true); };
    u.onend = () => {
      finish();
      // Speaker audio can lag slightly; keep the echo guard up a touch longer
      // so trailing echo after TTS ends isn't captured as input.
      setTimeout(() => onSpeakingChange?.(false), 400);
    };
    u.onerror = () => { onSpeakingChange?.(false); finish(); };
    onSpeakingChange?.(true);
    window.speechSynthesis.speak(u);

    if (earlyMs > 0) {
      // Estimate speech duration: ~13 chars/sec at rate 1, scaled by rate.
      const estMs = (text.length / 13) * 1000 / 1.3;
      const fireAt = Math.max(600, estMs - earlyMs);
      setTimeout(finish, fireAt);
    }
  } catch {
    finish();
  }
}

export function VoiceLineAssistant({ section, location, region, onAddLine, onRemoveLine, currentLines, catalog, disabled }: Props) {
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
  // In-flight agent request, so the inspector can cancel a stuck call.
  const abortRef = useRef<AbortController | null>(null);
  // True while TTS is actively speaking — used to ignore echo (the recognizer
  // hearing the AI's own voice through the speaker).
  const speakingRef = useRef(false);
  // externalId + short label of the most recent voice-added line, for "undo".
  const lastAddedRef = useRef<{ externalId: string; label: string } | null>(null);

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
      if (!cancelled) setWarming(false);
    })();
    return () => { cancelled = true; };
  }, [open]);

  const sendToAgent = useCallback(
    async (history: ChatMsg[]) => {
      setBusy(true);
      setError(null);
      setStreamingText('');
      let accumulated = '';
      // Abort if the request stalls (flaky field LTE) so the panel never hangs
      // in "Thinking…" with no way out.
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const timeout = setTimeout(() => ctrl.abort(), 25000);
      try {
        const r = await fetch('/api/rate-card/voice-assist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctrl.signal,
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
          // The agent only proposes when the match is confident, so AUTO-ADD it
          // (no confirm step) and announce it. The line is saved here, and the
          // CLIENT speaks success only after the save actually happens.
          const line: RateCardLineInput = finalData.line;
          const action = finalData.action === 'edit' ? 'edit' : 'add';
          const spokenLabel = finalData.spokenSummary || finalData.summary;
          const verb = action === 'edit' ? 'Updated' : 'Added';
          try {
            onAddLine(line); // upserts by externalId (new or existing)
            if (action === 'add') lastAddedRef.current = { externalId: line.externalId, label: spokenLabel };
            // On screen: full detail. Spoken: short label only.
            const onScreen = `${verb}: ${finalData.summary}. Any changes or additional items?`;
            const spoken = `${verb} ${spokenLabel}. Any changes, or additional items?`;
            setMessages((m) => [...m, { role: 'assistant', content: onScreen }]);
            speakThenListenRef.current(spoken);
          } catch (e: any) {
            const msg = `I couldn't save that line (${String(e?.message || e)}). Try again or add it manually.`;
            setMessages((m) => [...m, { role: 'assistant', content: msg }]);
            speak(msg, () => { /* no restart */ }, 0, (sp) => { speakingRef.current = sp; });
          }
        } else {
          // question or message — the text already streamed; finalize it.
          const text = finalData?.text || accumulated;
          setMessages((m) => [...m, { role: 'assistant', content: text }]);
          if (finalData?.awaitingReply) {
            speakThenListenRef.current(text);
          } else {
            speak(text, () => { /* no restart */ }, 0, (sp) => { speakingRef.current = sp; });
          }
        }
      } catch (e: any) {
        setStreamingText('');
        if (e?.name === 'AbortError') {
          setError('That took too long — check your connection and try again, or add the line manually.');
        } else {
          setError(String(e?.message || e));
        }
      } finally {
        clearTimeout(timeout);
        abortRef.current = null;
        setBusy(false);
      }
    },
    [section, location, region, currentLines, onAddLine]
  );

  const submitUtterance = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      // "Undo" / "remove that last line" — remove the most recent voice-added
      // line without round-tripping the agent.
      if (UNDO.test(t) && lastAddedRef.current && onRemoveLine) {
        const removed = lastAddedRef.current;
        lastAddedRef.current = null;
        setMessages((m) => [...m, { role: 'user', content: t }]);
        try {
          onRemoveLine(removed.externalId);
          const msg = `Removed ${removed.label}. Anything else?`;
          setMessages((m) => [...m, { role: 'assistant', content: msg }]);
          speakThenListenRef.current(msg);
        } catch {
          const msg = `I couldn't remove that — you can delete it from the list. Anything else?`;
          setMessages((m) => [...m, { role: 'assistant', content: msg }]);
          speakThenListenRef.current(msg);
        }
        return;
      }
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
    [messages, sendToAgent, onRemoveLine]
  );

  const startListening = useCallback(() => {
    setError(null);
    // NOTE: do NOT cancel speech here. Opening the mic early shouldn't cut off
    // the assistant's reply — only the inspector actually speaking should
    // interrupt it (handled via onspeechstart below).

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
      // Echo guard: while the assistant is still speaking, any result is almost
      // certainly the mic picking up the AI's own voice — discard it entirely.
      if (speakingRef.current) return;
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
    // Fires when the recognizer detects speech. If WE'RE still speaking, it's
    // almost certainly echo — ignore it. Otherwise it's the inspector, so stop
    // any remaining TTS so they're not talked over.
    recog.onspeechstart = () => {
      if (speakingRef.current) return;
      try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
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

  // Speak a reply, then open the mic once speech has FULLY finished. We no
  // longer open early — it caused echo and timing issues. The speaking-state
  // callback still drives the echo guard during playback.
  const speakThenListen = useCallback((text: string) => {
    speak(text, () => { startListeningRef.current(); }, 0, (sp) => { speakingRef.current = sp; });
  }, []);
  const speakThenListenRef = useRef(speakThenListen);
  useEffect(() => { speakThenListenRef.current = speakThenListen; }, [speakThenListen]);

  // Commit the pending proposal: save it (the CLIENT announces success only
  // after the save), then prompt for the next line and reopen the mic.
  const commitPending = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    setPending(null);
    const verb = p.action === 'edit' ? 'Updated' : 'Added';
    try {
      onAddLine(p.line);
      // Remember adds (not edits) so "undo" can remove the last one.
      if (p.action === 'add') lastAddedRef.current = { externalId: p.line.externalId, label: p.spoken };
      // On screen: full detail. Spoken: short — "Added [short]. Anything else?"
      const onScreen = `${verb}: ${p.summary}. Anything else for this area?`;
      const spoken = `${verb} ${p.spoken}. Anything else?`;
      setMessages((m) => [...m, { role: 'assistant', content: onScreen }]);
      speakThenListenRef.current(spoken);
    } catch (e: any) {
      const msg = `I couldn't save that line (${String(e?.message || e)}). Try again or add it manually.`;
      setMessages((m) => [...m, { role: 'assistant', content: msg }]);
      speak(msg, () => { /* no restart on failure */ }, 0, (sp) => { speakingRef.current = sp; });
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
          // Start listening immediately — warm-up runs silently in the
          // background. Defer one tick so the panel mounts and the ref is live.
          setTimeout(() => { startListeningRef.current(); }, 0);
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
            disabled={(busy || warming) && !listening ? true : disabled}
            className={
              'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded disabled:opacity-60 ' +
              (listening ? 'bg-red-600 text-white animate-pulse' : 'bg-brand text-white hover:bg-brand-dark')
            }
          >
            {listening
              ? <MicIcon className="w-4 h-4" />
              : (warming || busy)
                ? <SpinnerIcon className="w-4 h-4 animate-spin" />
                : <MicIcon className="w-4 h-4" />}
            {listening ? 'Listening… tap to stop' : warming ? 'Getting ready…' : busy ? 'Thinking…' : 'Speak'}
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
        {busy && (
          <button
            type="button"
            onClick={() => { try { abortRef.current?.abort(); } catch { /* noop */ } }}
            className="px-2.5 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-100 shrink-0"
          >
            Cancel
          </button>
        )}
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
