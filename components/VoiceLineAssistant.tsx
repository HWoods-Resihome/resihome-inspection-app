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
import type { RateCardLineInput } from '@/lib/types';

interface Props {
  section: string;        // base section name (e.g. "Yard / Exterior")
  location: string;       // location label (e.g. "Bedroom 1" or "")
  region: string;         // inspection region snapshot (for context only)
  // Called when the inspector confirms a proposed line. Reuses RateCardForm's
  // handleSaveLineForSection so the save path is identical to a manual add.
  onAddLine: (line: RateCardLineInput) => void;
  disabled?: boolean;
}

type ChatMsg = { role: 'user' | 'assistant'; content: string };

type Proposal = { line: RateCardLineInput; summary: string };

// Minimal typing for the vendor-prefixed SpeechRecognition (webkit on most
// mobile webviews). We feature-detect at runtime.
function getRecognition(): any | null {
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
    u.rate = 1.05;
    u.onend = () => onDone();
    u.onerror = () => onDone();
    window.speechSynthesis.speak(u);
  } catch {
    onDone();
  }
}

export function VoiceLineAssistant({ section, location, region, onAddLine, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const recogRef = useRef<any>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  // Holds the latest startListening so TTS-onend can trigger it without stale closures.
  const startListeningRef = useRef<() => void>(() => {});

  useEffect(() => {
    setSupported(getRecognition() !== null);
  }, []);

  const sendToAgent = useCallback(
    async (history: ChatMsg[]) => {
      setBusy(true);
      setError(null);
      try {
        const r = await fetch('/api/rate-card/voice-assist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history, section, location, region }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

        if (data.type === 'proposal') {
          setProposal({ line: data.line, summary: data.summary });
          // Surface + speak any assistant preamble. A proposal does NOT
          // auto-restart the mic (inspector confirms first).
          const say = data.assistantText || data.summary;
          if (data.assistantText) {
            setMessages((m) => [...m, { role: 'assistant', content: data.assistantText }]);
          }
          speak(say, () => { /* no auto-restart on a proposal */ });
        } else {
          // 'question' or 'message' — show + speak it.
          const text = data.text || '';
          setMessages((m) => [...m, { role: 'assistant', content: text }]);
          speak(text, () => {
            // Auto-restart the mic only when the AI asked a question and is
            // waiting on the inspector (less clicks, hands-free).
            if (data.awaitingReply) startListeningRef.current();
          });
        }
      } catch (e: any) {
        setError(String(e?.message || e));
      } finally {
        setBusy(false);
      }
    },
    [section, location, region]
  );

  const submitUtterance = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      setProposal(null);
      const next: ChatMsg[] = [...messages, { role: 'user', content: t }];
      setMessages(next);
      void sendToAgent(next);
    },
    [messages, sendToAgent]
  );

  const startListening = useCallback(() => {
    setError(null);
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    const recog = getRecognition();
    if (!recog) { setSupported(false); return; }
    recogRef.current = recog;
    recog.onresult = (ev: any) => {
      const text = ev.results?.[0]?.[0]?.transcript || '';
      setListening(false);
      submitUtterance(text);
    };
    recog.onerror = (ev: any) => {
      setListening(false);
      setError(ev?.error === 'not-allowed'
        ? 'Microphone permission denied.'
        : `Couldn't hear that (${ev?.error || 'error'}). Try again or type below.`);
    };
    recog.onend = () => setListening(false);
    try {
      recog.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }, [submitUtterance]);

  const stopListening = useCallback(() => {
    try { recogRef.current?.stop(); } catch { /* noop */ }
    setListening(false);
  }, []);

  // Keep the ref pointing at the latest startListening so TTS-onend (which
  // captures an older closure) always calls the current one.
  useEffect(() => { startListeningRef.current = startListening; }, [startListening]);

  // Auto-scroll the transcript to the newest message / proposal.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, proposal]);

  // Stop any in-progress speech if the panel unmounts.
  useEffect(() => () => { try { window.speechSynthesis?.cancel(); } catch { /* noop */ } }, []);

  function confirmProposal() {
    if (!proposal) return;
    onAddLine(proposal.line);
    setMessages((m) => [...m, { role: 'assistant', content: `Added: ${proposal.summary}. Anything else for this area?` }]);
    setProposal(null);
  }

  function rejectProposal() {
    setProposal(null);
    setMessages((m) => [...m, { role: 'assistant', content: 'Okay, discarded. Tell me what you need instead.' }]);
  }

  function reset() {
    stopListening();
    setMessages([]);
    setProposal(null);
    setError(null);
    setTyped('');
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
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
        <span className="text-sm font-heading font-semibold text-brand">Voice assistant — {location || section}</span>
        <button type="button" onClick={() => { reset(); setOpen(false); }} className="text-xs text-gray-500 hover:text-gray-700">
          Close
        </button>
      </div>

      {!supported && (
        <p className="text-xs text-amber-700 mb-2">
          Voice input isn&apos;t available in this browser. You can still type a request below.
        </p>
      )}

      {/* Transcript + draft proposal share one scroll region so auto-scroll
          reaches whichever is newest. */}
      {(messages.length > 0 || proposal) && (
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
          </div>

          {/* Draft proposal — confirm before saving */}
          {proposal && (
            <div className="rounded-md border border-teal-300 bg-teal-50 p-2.5 mt-2">
              <div className="text-xs font-heading font-semibold text-teal-800 mb-1">Add this line?</div>
              <div className="text-sm text-ink mb-2">{proposal.summary}</div>
              <div className="flex gap-2">
                <button type="button" onClick={confirmProposal}
                  className="px-3 py-1 text-sm bg-teal-600 text-white rounded hover:bg-teal-700">
                  Add it
                </button>
                <button type="button" onClick={rejectProposal}
                  className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100">
                  No
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      {/* Controls */}
      <div className="flex items-center gap-2">
        {supported && (
          <button
            type="button"
            onClick={listening ? stopListening : startListening}
            disabled={busy || disabled}
            className={
              'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded disabled:opacity-50 ' +
              (listening ? 'bg-red-600 text-white animate-pulse' : 'bg-brand text-white hover:bg-brand-dark')
            }
          >
            <MicIcon className="w-4 h-4" />
            {listening ? 'Listening… tap to stop' : busy ? 'Thinking…' : 'Speak'}
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
