// components/VoiceLineAssistant.tsx
//
// Roaming conversational Voice Assistant for the Scope rate card.
// Online-only. ONE floating panel travels across rooms: it always shows the
// room it's working on, lets the inspector change rooms manually (dropdown) or
// by voice ("close this out, go to Bedroom 2"), scrolls the form to that room,
// and routes all line adds/edits/undo to the current room.
//
// Uses the browser Web Speech API for input and the /api/rate-card/voice-assist
// agent (Claude tool-calling + Voyage matching). It NEVER saves directly: line
// adds go through onAddLine (RateCardForm's server-authoritative upsert path).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RateCardLineInput, RateCardLineItem } from '@/lib/types';

// A room the assistant can work on / navigate to.
export interface AssistantSection {
  id: string;
  label: string;        // base section name (e.g. "Yard / Exterior")
  location: string;     // location label (e.g. "Bedroom 1" or "")
  displayName: string;  // UI label shown to the inspector (e.g. "Bedroom 1")
}

interface Props {
  sections: AssistantSection[];   // all rooms, for display + navigation
  currentSectionId: string;       // the room currently being worked on
  onNavigate: (sectionId: string) => void; // switch room (parent scrolls/expands)
  region: string;                 // inspection region snapshot (context only)
  // Called when a line is added (new OR edited) — upserts by externalId, routed
  // by the parent to the CURRENT room. Resolves once the SAVE round-trip is done
  // so the assistant only claims "Added" for lines that actually persisted.
  onAddLine: (line: RateCardLineInput) => Promise<SaveResult> | void;
  // Remove a line by externalId (for "undo that" / "remove the last line").
  onRemoveLine?: (externalId: string) => void;
  // Section-targeted variants — used when a single voice turn switches rooms and
  // THEN adds/edits a line, so the line lands in the room active at that moment
  // (not whatever the panel shows when the stream finishes).
  onAddLineTo?: (sectionId: string, line: RateCardLineInput) => Promise<SaveResult> | void;
  onRemoveLineFrom?: (sectionId: string, externalId: string) => void;
  // Lines per section, so edits/undo after a mid-turn room switch can resolve
  // existing lines in the room the agent is now working on.
  linesBySection?: Record<string, RateCardLineInput[]>;
  // Lines already in the CURRENT room (parent supplies based on currentSectionId).
  currentLines?: RateCardLineInput[];
  // Catalog for resolving codes -> descriptions in edit summaries.
  catalog?: RateCardLineItem[];
  disabled?: boolean;
  // Reports when the conversation panel opens/closes (engaged) so the parent can
  // keep the mic visible over other screens only while a conversation is active.
  onEngagedChange?: (engaged: boolean) => void;
}

type ChatMsg = { role: 'user' | 'assistant'; content: string };

// Result of a line save round-trip, so the assistant can report the truth
// (and the actual error) instead of optimistically claiming success. The
// routing/record fields let the assistant flag the rare "saved but didn't show
// where expected" case with concrete facts instead of a vague claim.
export type SaveResult = {
  ok: boolean;
  error?: string;
  requested?: string;   // section id the assistant asked for
  routedTo?: string;    // section id the line actually landed in
  reRouted?: boolean;   // true if requested !== routedTo
  recordId?: string;    // HubSpot record id (present only once persisted)
  skippedSave?: boolean; // true if the network save was skipped (e.g. still loading)
};

type Pending = { line: RateCardLineInput; summary: string; spoken: string; action: 'add' | 'edit' };

// Affirmatives that commit a pending proposal when spoken. A leading
// yes/yeah/sure/ok/etc (optionally followed by a short tail) confirms. A bare
// "add <noun>" is a NEW request, so "add" only counts alone or as "add it/that".
const AFFIRMATIVE = /^((yes|yep|yeah|yup|sure|okay|ok|correct|confirm|perfect|go ahead|looks good|that'?s right|do it)\b|add(\s+(it|that))?\s*$)/i;

// Undo phrases that remove the most recently added line.
const UNDO = /\b(undo|scratch that|(remove|delete|cancel|drop)\b.{0,12}\b(line|one|item|that|last)|take that (off|out)|never ?mind that)\b/i;

// "I'm done" phrases — close the loop: stop listening, don't call the agent,
// don't reply. Covers a bare "no", "nope", "that's it", "I'm done", "close",
// "stop", "nothing", "all set", etc. Kept tight so it doesn't swallow real
// requests (e.g. "no, make it 50 percent" still goes to the agent).
const DONE = /^(no|nope|nah|no thanks?|that'?s (it|all)|i'?m (done|good|all set)|all set|all done|done|close|stop|cancel|nothing( else)?|that'?ll do|we'?re good|good for now)[.!]?$/i;

// Minimal typing for the vendor-prefixed SpeechRecognition (webkit on most
// mobile webviews). We feature-detect at runtime.
function getRecognition(): any | null {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) return null;
  const r = new Ctor();
  r.lang = 'en-US';
  // IMPORTANT: interimResults + continuous cause severe transcript duplication
  // on Android WebView (it re-reports cumulative results marked final, so a
  // growing utterance gets concatenated: "change… change to… change to the…").
  // Disabling both gives ONE clean final transcript per utterance. We handle
  // multi-pause speech by restarting recognition on `onend` if the inspector
  // hasn't been silent long enough yet.
  r.interimResults = false;
  r.maxAlternatives = 1;
  r.continuous = false;
  return r;
}

// Defensive de-duplication for misbehaving speech engines (some Android
// WebViews stream a GROWING transcript and re-report it, producing
// "change change to change to the change to the exterior…"). This collapses
// that pattern down to the final clean sentence.
//
// Strategy: walk word by word; only append a word if it actually extends the
// sentence (i.e. the running result is a prefix of what we'd get by appending).
// In practice the duplicated stream is a sequence of ever-growing prefixes of
// the final utterance, so the LAST maximal prefix is the answer — which equals
// "drop any word that just re-states a prefix we already have". The simplest
// robust form: split on whitespace and remove any span that is an exact repeat
// of the immediately preceding span of the same length, repeatedly.
function dedupeTranscript(raw: string): string {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return '';
  const words = text.split(' ');
  // If there's no duplication, this is cheap and returns the same thing.
  // Collapse the "growing prefix" pattern: the correct sentence is the longest
  // run with no immediate word-level repetition of an earlier prefix. We detect
  // it by collapsing consecutive duplicate subsequences.
  // 1) Collapse immediate single-word repeats ("change change" -> "change").
  const noWordRepeat: string[] = [];
  for (const w of words) {
    if (noWordRepeat.length === 0 || noWordRepeat[noWordRepeat.length - 1].toLowerCase() !== w.toLowerCase()) {
      noWordRepeat.push(w);
    }
  }
  // 2) Collapse repeated multi-word phrases where a phrase is immediately
  // followed by the same phrase plus one more word (the growing-prefix shape).
  // We do this by scanning for the longest result: repeatedly remove any prefix
  // that is duplicated right after itself.
  let arr = noWordRepeat;
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (let len = Math.floor(arr.length / 2); len >= 1; len--) {
      let collapsed = false;
      for (let i = 0; i + 2 * len <= arr.length; i++) {
        const a = arr.slice(i, i + len).join(' ').toLowerCase();
        const b = arr.slice(i + len, i + 2 * len).join(' ').toLowerCase();
        if (a === b) {
          arr = [...arr.slice(0, i + len), ...arr.slice(i + 2 * len)];
          collapsed = true;
          changed = true;
          break;
        }
      }
      if (collapsed) break;
    }
  }
  return arr.join(' ');
}

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
  // Strip UI glyphs that screen readers/TTS verbalize awkwardly. The "→ Room"
  // navigation marker must never be read as "right arrow" — turn it into a
  // natural phrase, and drop any other stray arrows/symbols.
  t = t
    .replace(/^\s*→\s*/, 'Navigating to ')   // leading marker → spoken phrase
    .replace(/[→←↑↓➜▶►•·]/g, ' ')            // any remaining arrows/bullets
    .replace(/\s{2,}/g, ' ')
    .trim();
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
    // Mobile TTS voices read faster at the same rate value than desktop voices,
    // so use a gentler 1.2x on mobile and 1.3x on desktop.
    const isMobileUA = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    u.rate = isMobileUA ? 1.15 : 1.3;
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

export function VoiceLineAssistant({ sections, currentSectionId, onNavigate, region, onAddLine, onRemoveLine, onAddLineTo, onRemoveLineFrom, linesBySection, currentLines, catalog, disabled, onEngagedChange }: Props) {
  // The room the assistant is working on right now.
  const currentSection = useMemo(
    () => sections.find((s) => s.id === currentSectionId) || sections[0],
    [sections, currentSectionId]
  );
  const section = currentSection?.label || '';
  const location = currentSection?.location || '';
  const currentRoomName = currentSection?.displayName || currentSection?.label || 'this room';

  const [open, setOpen] = useState(false);
  const onEngagedRef = useRef(onEngagedChange);
  onEngagedRef.current = onEngagedChange;
  useEffect(() => { onEngagedRef.current?.(open); }, [open]);
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
  const stopListeningRef = useRef<() => void>(() => {});
  // Synchronous access to the pending proposal (for the affirmative intercept).
  const pendingRef = useRef<Pending | null>(null);
  const commitPendingRef = useRef<() => void>(() => {});
  // In-flight agent request, so the inspector can cancel a stuck call.
  const abortRef = useRef<AbortController | null>(null);
  // Push-to-talk audio capture (fallback for browsers w/o the Web Speech API,
  // e.g. iOS Safari): record a clip → POST to /api/transcribe → submit the text.
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioMimeRef = useRef<string>('audio/mp4');
  const [recordingAudio, setRecordingAudio] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Release the mic if we unmount mid-recording.
  useEffect(() => () => {
    try { audioRecorderRef.current?.state !== 'inactive' && audioRecorderRef.current?.stop(); } catch { /* noop */ }
    audioStreamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);
  // True while TTS is actively speaking — used to ignore echo (the recognizer
  // hearing the AI's own voice through the speaker).
  const speakingRef = useRef(false);
  // externalId + short label of the most recent voice-added line, for "undo".
  const lastAddedRef = useRef<{ externalId: string; label: string } | null>(null);
  // The section the agent is working on DURING the current stream. Starts at the
  // panel's current room and is updated by navigate events mid-stream so a line
  // proposed after a room switch is saved to the new room.
  const streamSectionRef = useRef<string>(currentSectionId);

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
      // Reset the stream-local room to whatever the panel currently shows; a
      // navigate event mid-stream will update it so later proposals route right.
      streamSectionRef.current = currentSectionId;
      let addedThisTurn = 0;
      const addedRoomIds = new Set<string>();
      // Save round-trips kicked off by proposals this turn. We await ALL of them
      // before composing the closing line, so we report what actually persisted
      // (and surface any save error) rather than optimistically claiming success.
      const savePromises: Promise<SaveResult>[] = [];
      // Abort if the request stalls (flaky field LTE) so the panel never hangs
      // in "Thinking…" with no way out.
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      // Generous: compound requests ("X and Y") run multiple tool rounds; keep
      // just under the server's maxDuration (60s) so the server can finish.
      const timeout = setTimeout(() => ctrl.abort(), 55000);
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
            // Room context so the agent can navigate ("go to Bedroom 2").
            currentRoom: currentRoomName,
            rooms: sections.map((s) => ({ id: s.id, name: s.displayName || s.label })),
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
            const dataParts: string[] = [];
            for (const l of lines) {
              if (l.startsWith(':')) continue; // SSE comment / heartbeat
              if (l.startsWith('event:')) ev = l.slice(6).trim();
              // Per the SSE spec, multiple data: lines join with a newline and
              // only ONE leading space is stripped — don't trim() (it would
              // corrupt multi-line payloads and any meaningful whitespace).
              else if (l.startsWith('data:')) dataParts.push(l.slice(5).replace(/^ /, ''));
            }
            const dataStr = dataParts.join('\n');
            if (!dataStr) continue;
            let data: any;
            try { data = JSON.parse(dataStr); } catch { continue; }

            if (ev === 'delta') {
              accumulated += data.text || '';
              setStreamingText(accumulated);
            } else if (ev === 'navigate') {
              // Switch rooms mid-stream. Update the stream-local target so any
              // line proposed AFTER this lands in the new room, then move the UI.
              const target = sections.find((s) => s.id === data.sectionId)
                || sections.find((s) => (s.displayName || s.label).toLowerCase() === String(data.roomName || '').toLowerCase());
              if (target) {
                streamSectionRef.current = target.id;
                onNavigate(target.id);
                // Brief on-screen note; only SPEAK if nothing else follows (the
                // closing message will speak otherwise). Keep it quiet inline.
                setMessages((m) => [...m, { role: 'assistant', content: `→ ${target.displayName || target.label}` }]);
              }
            } else if (ev === 'proposal') {
              // A line matched. AUTO-ADD it to the stream-local room (which a
              // prior navigate may have changed) and announce briefly. Multiple
              // proposals can arrive in one turn.
              const line: RateCardLineInput = data.line;
              const action = data.action === 'edit' ? 'edit' : 'add';
              const spokenLabel = data.spokenSummary || data.summary;
              const verb = action === 'edit' ? 'Updated' : 'Added';
              // Route to the stream's current room — but guard against a stale/empty
              // ref by falling back to the focused section so a line is never lost
              // to a non-existent group.
              const refId = streamSectionRef.current;
              const targetId = (refId && sections.some((s) => s.id === refId)) ? refId : currentSectionId;
              try {
                const ret = onAddLineTo ? onAddLineTo(targetId, line) : onAddLine(line);
                // The parent now returns a promise that resolves once the SAVE
                // round-trip finishes. Collect it so the closing line reflects
                // what truly persisted. (Tolerate a void return for safety.)
                const p: Promise<SaveResult> = ret && typeof (ret as any).then === 'function'
                  ? (ret as Promise<SaveResult>)
                  : Promise.resolve({ ok: true } as SaveResult);
                savePromises.push(p.then((r) => r || { ok: true }).catch((e) => ({ ok: false, error: String(e?.message || e) })));
                if (action === 'add') lastAddedRef.current = { externalId: line.externalId, label: spokenLabel };
                addedThisTurn++;
                if (targetId) addedRoomIds.add(targetId);
                setMessages((m) => [...m, { role: 'assistant', content: `${verb}: ${data.summary}` }]);
              } catch (e: any) {
                savePromises.push(Promise.resolve({ ok: false, error: String(e?.message || e) }));
                setMessages((m) => [...m, { role: 'assistant', content: `Couldn't save ${spokenLabel}.` }]);
              }
            } else if (ev === 'question' || ev === 'message' || ev === 'error') {
              finalType = ev;
              finalData = data;
            } else if (ev === 'done') {
              // terminal
            }
          }
        }

        // Finalize: navigate + proposals were applied inline as they streamed.
        // Now produce ONE spoken closing line.
        setStreamingText('');
        if (finalType === 'error') {
          setError(finalData?.error || 'Something went wrong.');
        } else if (addedThisTurn > 0) {
          // Wait for the save round-trips to finish so we report the TRUTH, not
          // an optimistic guess. If any failed, say so (and show the error) —
          // never claim "Added" for a line that didn't persist.
          const results = await Promise.all(savePromises);
          const failed = results.filter((r) => !r.ok);
          const savedCount = addedThisTurn - failed.length;
          // Surface a concise diagnostic ONLY when something looks off — a save
          // was skipped, the line got re-routed to a different section, or it
          // persisted without a record id. In the clean case this stays silent.
          const odd = results.filter((r) => r.skippedSave || r.reRouted || (r.ok && !r.recordId && !r.skippedSave));
          if (odd.length > 0) {
            const diag = odd.map((r) => {
              const route = r.reRouted ? `${r.requested}→${r.routedTo}` : (r.routedTo || r.requested || '?');
              const flags = [r.skippedSave ? 'not-saved(loading)' : '', r.reRouted ? 're-routed' : '', (r.ok && !r.recordId && !r.skippedSave) ? 'no-record-id' : '']
                .filter(Boolean).join(',');
              return `${route}${flags ? ` [${flags}]` : ''}`;
            }).join('; ');
            setMessages((m) => [...m, { role: 'assistant', content: `diag: ${diag}` }]);
          }
          // Name the room(s) the lines ACTUALLY landed in (from the stream), not
          // React state, which lags during the stream and would name the wrong room.
          const roomNames = Array.from(addedRoomIds)
            .map((id) => {
              const s = sections.find((x) => x.id === id);
              return s ? (s.displayName || s.label) : null;
            })
            .filter(Boolean) as string[];
          let where: string;
          if (roomNames.length === 1) where = ` in ${roomNames[0]}`;
          else if (roomNames.length > 1) where = ` across ${roomNames.length} rooms`;
          else where = '';
          if (failed.length === 0) {
            // Speak ONLY a short one-sentence summary — never read each line's
            // full detail aloud (those are shown on screen, not spoken).
            const spoken = `Added ${savedCount} item${savedCount === 1 ? '' : 's'}${where}. Anything else?`;
            setMessages((m) => [...m, { role: 'assistant', content: spoken }]);
            speakThenListenRef.current(spoken);
          } else {
            // Some (or all) saves failed. Be honest and surface the error on
            // screen so the cause is visible; speak a short recoverable message.
            const detail = failed[0].error ? ` (${failed[0].error})` : '';
            const spoken = savedCount > 0
              ? `Saved ${savedCount}, but ${failed.length} didn't save. Please try those again.`
              : `That didn't save — please try again or check your connection.`;
            setMessages((m) => [...m, { role: 'assistant', content: `${spoken}${detail}` }]);
            speakThenListenRef.current(spoken);
          }
        } else if (finalType === 'question') {
          // The agent needs more info (e.g. ambiguous item, missing quantity).
          const text = finalData?.text || accumulated || 'Could you clarify that?';
          setMessages((m) => [...m, { role: 'assistant', content: text }]);
          speakThenListenRef.current(text);
        } else if (finalType === 'message') {
          // An explicit closing message from the agent (no actions this turn).
          const text = finalData?.text || accumulated;
          setMessages((m) => [...m, { role: 'assistant', content: text }]);
          if (finalData?.awaitingReply) speakThenListenRef.current(text);
          else speak(text, () => { /* no restart */ }, 0, (sp) => { speakingRef.current = sp; });
        } else {
          // Nothing actionable came back (e.g. a bare navigate). Prompt for next.
          const roomName = currentSection?.displayName || currentSection?.label || 'this room';
          const spoken = `Okay — ${roomName}. What do you need here?`;
          setMessages((m) => [...m, { role: 'assistant', content: spoken }]);
          speakThenListenRef.current(spoken);
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
    [section, location, region, currentLines, onAddLine, onAddLineTo, sections, onNavigate, currentRoomName, currentSection, currentSectionId]
  );

  const submitUtterance = useCallback(
    (text: string) => {
      // Collapse any growing-prefix duplication some speech engines emit
      // ("change change to change to the…") before doing anything with it.
      const t = dedupeTranscript(text);
      if (!t) return;
      // "No" / "close" / "that's it" / "stop" — the inspector is done. Stop
      // listening, acknowledge briefly, and DON'T call the agent (so it can't
      // get confused trying to interpret "no" as a request). Checked first so a
      // bare "no" closes out; compound replies like "no, make it 50%" don't
      // match this anchored pattern and still go to the agent.
      if (DONE.test(t)) {
        stopListeningRef.current();
        setMessages((m) => [...m, { role: 'user', content: t }]);
        // A short, final acknowledgment. No mic restart.
        const msg = 'Okay.';
        setMessages((m) => [...m, { role: 'assistant', content: msg }]);
        speak(msg, () => { /* no restart — we're done */ }, 0, (sp) => { speakingRef.current = sp; });
        return;
      }
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
    // Optimistically reflect the listening state so the UI ("Listening…" + the
    // pulsing mic) updates the instant the inspector taps, rather than waiting
    // for the engine's onstart, which can lag noticeably on mobile.
    listeningRef.current = true;
    setListening(true);

    const clearSilence = () => {
      if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    };

    recog.onresult = (ev: any) => {
      // Echo guard: while the assistant is still speaking, any result is almost
      // certainly the mic picking up the AI's own voice — discard it.
      if (speakingRef.current) return;
      // With interimResults=false + continuous=false, the engine delivers the
      // final transcript for this utterance. Take the LAST result's transcript
      // (the complete utterance); do not concatenate, which is what caused the
      // Android duplication. onend will submit it.
      const last = ev.results[ev.results.length - 1];
      const text = (last && last[0]?.transcript ? String(last[0].transcript) : '').trim();
      if (text) finalTranscriptRef.current = text;
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
      setListening(false);
      clearSilence();
      // The recognizer ended (utterance complete, since continuous=false).
      // Submit whatever we captured.
      const captured = finalTranscriptRef.current.trim();
      finalTranscriptRef.current = '';
      if (captured) submitUtterance(captured);
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
  useEffect(() => { stopListeningRef.current = stopListening; }, [stopListening]);

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

  // Stop any in-progress speech, recognition, and network on unmount so a
  // navigation away mid-conversation never leaves the mic hot (Android Web
  // Speech) or an SSE fetch dangling.
  useEffect(() => () => {
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    try {
      if (recogRef.current) {
        recogRef.current.onresult = null;
        recogRef.current.onerror = null;
        recogRef.current.onend = null;
        recogRef.current.abort?.();
      }
    } catch { /* noop */ }
    try { abortRef.current?.abort(); } catch { /* noop */ }
  }, []);

  function reset() {
    stopListening();
    setMessages([]);
    setPending(null);
    setError(null);
    setTyped('');
  }

  // ---- Push-to-talk audio capture (browsers without the Web Speech API) -----
  const pushToTalk = !supported;

  // Bias Whisper toward inspection/construction vocabulary so domain terms
  // (e.g. "mist match") aren't "corrected" to plausible everyday words.
  function buildVocabPrompt(): string {
    const base = 'Property inspection scope notes. Construction terms: mist match, LVP, vinyl plank, '
      + 'linear feet, square feet, drywall, baseboard, casing, J-channel, GFCI, caulk, grout, fascia, soffit.';
    const extras = (catalog || []).slice(0, 40).map((c) => c.laborShortDescription).filter(Boolean).join(', ');
    return (extras ? `${base} Catalog items: ${extras}` : base).slice(0, 780);
  }

  async function startAudioCapture() {
    if (recordingAudio || transcribing || disabled) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;
      const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        .find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) || '';
      audioMimeRef.current = mime || 'audio/mp4';
      let rec: MediaRecorder;
      try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch { rec = new MediaRecorder(stream); }
      audioChunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) audioChunksRef.current.push(e.data); };
      rec.onstop = () => { void transcribeAndSubmit(); };
      audioRecorderRef.current = rec;
      setError(null);
      rec.start();
      setRecordingAudio(true);
    } catch {
      setError('Microphone access is needed. Allow it in Safari settings and try again.');
    }
  }

  function stopAudioCapture() {
    const rec = audioRecorderRef.current;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* noop */ } }
    setRecordingAudio(false);
  }

  async function transcribeAndSubmit() {
    const chunks = audioChunksRef.current; audioChunksRef.current = [];
    const stream = audioStreamRef.current;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); audioStreamRef.current = null; }
    audioRecorderRef.current = null;
    if (!chunks.length) return;
    const type = (audioMimeRef.current || 'audio/mp4').split(';')[0];
    const blob = new Blob(chunks, { type });
    if (blob.size < 1200) return; // ignore accidental taps
    setTranscribing(true);
    try {
      const base64 = await blobToBase64(blob);
      const r = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mime: type, prompt: buildVocabPrompt() }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) { setError(d?.error || 'Transcription failed.'); return; }
      const text = String(d?.text || '').trim();
      if (!text) { setError('Didn’t catch that — try again.'); return; }
      submitUtterance(text);
    } catch {
      setError('Couldn’t transcribe — check your connection and try again.');
    } finally {
      setTranscribing(false);
    }
  }

  // Collapsed: just a mic icon that lives inside the footer. Pressing it opens
  // the conversation panel above and (where supported) starts listening.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          if (!pushToTalk) setTimeout(() => { startListeningRef.current(); }, 0);
        }}
        disabled={disabled}
        aria-label="Talk to the Voice Assistant"
        className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-brand text-white hover:bg-brand-dark disabled:opacity-50 shadow"
      >
        <MicIcon className="w-5 h-5" />
      </button>
    );
  }

  // Open: the mic stays in the footer; the conversation panel floats just above
  // it. The active room is shown by the pink border on the section itself (and
  // it auto-expands), so there's no room label/picker here.
  return (
    <>
      <div className="absolute left-0 right-0 bottom-full mb-2 px-3 sm:px-4 z-40 pointer-events-none">
        <div className="max-w-7xl mx-auto flex justify-center">
          <div className="pointer-events-auto w-full sm:w-[440px] rounded-lg border border-brand/30 bg-white shadow-xl p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm font-heading font-semibold text-brand">Voice Assistant</span>
              <button type="button" onClick={() => { reset(); setOpen(false); }} className="text-xs text-gray-500 hover:text-gray-700 shrink-0">
                Close
              </button>
            </div>

      {pushToTalk && (
        <p className="text-xs text-gray-500 mb-2">
          {recordingAudio
            ? 'Listening… release the mic when you’re done.'
            : transcribing
              ? 'Transcribing…'
              : 'Tap and hold the mic below to talk (or type a request).'}
        </p>
      )}

      {/* Transcript */}
      {(messages.length > 0 || streamingText) && (
        <div ref={transcriptRef} className="max-h-28 overflow-y-auto mb-2">
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

      {/* Controls — status only (the mic action is the bottom footer button).
          A typed fallback stays for when speech mishears or isn't available. */}
      <div className="flex items-center gap-2">
        {supported && (
          <div
            className={
              'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded shrink-0 ' +
              (listening ? 'bg-red-600 text-white animate-pulse' : 'bg-gray-100 text-gray-600')
            }
            aria-live="polite"
          >
            {listening
              ? <MicIcon className="w-4 h-4" />
              : (warming || busy)
                ? <SpinnerIcon className="w-4 h-4 animate-spin" />
                : <MicIcon className="w-4 h-4" />}
            {listening ? 'Listening…' : warming ? 'Getting ready…' : busy ? 'Thinking…' : 'Tap the mic below'}
          </div>
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
        </div>
      </div>
      {/* The mic stays in the footer slot while open. Tapping it starts (or
          re-opens) listening so the inspector can talk again — it does NOT
          close the panel. Closing is only via the Close button in the panel. */}
      <span className="relative inline-flex shrink-0">
        {/* Expanding ring while live (speech recognition OR push-to-talk). */}
        {(listening || recordingAudio) && (
          <span className="absolute inset-0 rounded-full bg-red-500/60 animate-ping" />
        )}
        {pushToTalk ? (
          // iOS Safari (no Web Speech API): press-and-hold to record, release to
          // transcribe via /api/transcribe, then run the normal line flow.
          <button
            type="button"
            onPointerDown={(e) => { e.preventDefault(); try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* noop */ } void startAudioCapture(); }}
            onPointerUp={(e) => { e.preventDefault(); stopAudioCapture(); }}
            onPointerCancel={() => stopAudioCapture()}
            onContextMenu={(e) => e.preventDefault()}
            disabled={transcribing || disabled}
            style={{ touchAction: 'none' }}
            aria-label={recordingAudio ? 'Release to send' : 'Hold to talk'}
            className={`relative inline-flex items-center justify-center w-11 h-11 rounded-full text-white shadow disabled:opacity-50 transition-transform select-none ${recordingAudio ? 'bg-red-600 scale-110' : 'bg-brand hover:bg-brand-dark ring-2 ring-brand/40'}`}
          >
            {transcribing ? <SpinnerIcon className="w-5 h-5 animate-spin" /> : <MicIcon className="w-5 h-5" />}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (listening) { stopListening(); return; }
              // Barge-in: cut off any ongoing TTS so the inspector can speak now.
              try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
              speakingRef.current = false;
              startListeningRef.current();
            }}
            disabled={(busy || warming) && !listening ? true : disabled}
            aria-label={listening ? 'Stop listening' : 'Talk to the Voice Assistant'}
            className={`relative inline-flex items-center justify-center w-11 h-11 rounded-full text-white shadow disabled:opacity-50 transition-transform ${listening ? 'bg-red-600 scale-110 animate-pulse' : 'bg-brand hover:bg-brand-dark ring-2 ring-brand/40'}`}
          >
            <MicIcon className="w-5 h-5" />
          </button>
        )}
      </span>
    </>
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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
