/**
 * Slack Notifications manager (admin · /admin/flows, below Approval Routing).
 *
 * One row per registered notification (scope pending, scope approved, 1099
 * listing-price): an ON/OFF toggle, a Sandbox ON/OFF toggle, and a sandbox
 * channel id (default C06CW2VMJNR). When Sandbox is on, that notification posts
 * to the sandbox channel instead of its live destination — so the same admin can
 * test without spamming the real POD channels. Self-contained collapsible card.
 * Backend: /api/admin/slack-notifications.
 */
import { useCallback, useEffect, useState } from 'react';

interface NotifDef { key: string; name: string; defaultSandbox?: boolean; defaultChannel?: string }
interface NotifCfg { enabled: boolean; sandbox: boolean; sandboxChannel: string; channel: string }

function Chevron({ open }: { open: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>;
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? 'bg-brand' : 'bg-gray-300'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

export function SlackNotificationsManager() {
  const [sectionOpen, setSectionOpen] = useState(false);
  const [defs, setDefs] = useState<NotifDef[] | null>(null);
  const [cfg, setCfg] = useState<Record<string, NotifCfg>>({});
  const [defaultSandbox, setDefaultSandbox] = useState('C06CW2VMJNR');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/admin/slack-notifications', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to load'); return; }
      setDefs(d.notifications || []);
      setDefaultSandbox(d.defaultSandbox || 'C06CW2VMJNR');
      const next: Record<string, NotifCfg> = {};
      for (const n of (d.notifications || [])) {
        const saved = (d.config || {})[n.key];
        next[n.key] = {
          enabled: saved ? saved.enabled !== false : true,
          // No saved config → use the registry default (listing-price → sandbox).
          sandbox: saved ? saved.sandbox === true : !!n.defaultSandbox,
          sandboxChannel: String(saved?.sandboxChannel || '').trim() || (d.defaultSandbox || 'C06CW2VMJNR'),
          // Live-channel override; blank means "use the code/env default".
          channel: String(saved?.channel || '').trim(),
        };
      }
      setCfg(next);
    } catch (e: any) { setError(String(e?.message || e)); }
  }, []);

  useEffect(() => { if (sectionOpen && defs === null) void load(); }, [sectionOpen, defs, load]);

  const patch = (key: string, p: Partial<NotifCfg>) => { setCfg((c) => ({ ...c, [key]: { ...c[key], ...p } })); setSaved(false); };

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const r = await fetch('/api/admin/slack-notifications', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: cfg }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Save failed'); return; }
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  }

  return (
    <section className="mt-5 border border-gray-200 rounded-xl bg-white">
      <button type="button" onClick={() => setSectionOpen((o) => !o)} aria-expanded={sectionOpen}
        className="w-full flex items-center justify-between gap-3 p-4 text-left">
        <div>
          <h2 className="font-heading font-bold text-base text-ink">Slack Notifications</h2>
          <p className="text-[12px] text-gray-500 mt-0.5">Turn each ResiWalk Slack notification on/off, and reroute it to a sandbox channel for testing.</p>
        </div>
        <Chevron open={sectionOpen} />
      </button>

      {sectionOpen && (
        <div className="px-4 pb-4">
          {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mb-3">{error}</div>}
          {defs === null ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : (
            <>
              {/* Stacked one-card-per-notification layout — the old 4-column grid
                  (with a fixed-width channel input) overflowed a phone and squeezed
                  the name column to nothing, hiding the label under the toggle. */}
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                {defs.map((n) => {
                  const c = cfg[n.key] || { enabled: true, sandbox: false, sandboxChannel: defaultSandbox, channel: '' };
                  return (
                    <div key={n.key} className="px-3 py-3">
                      <div className="text-sm text-ink font-heading font-semibold">{n.name}</div>
                      <div className="text-[10px] text-gray-400 font-mono">{n.key}{c.sandbox ? ' · SANDBOX' : c.enabled ? '' : ' · OFF'}</div>
                      <div className="mt-2 flex items-center gap-6">
                        <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                          <Toggle on={c.enabled} onClick={() => patch(n.key, { enabled: !c.enabled })} label={`${n.name} on/off`} />
                          <span>On</span>
                        </label>
                        <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                          <Toggle on={c.sandbox} onClick={() => patch(n.key, { sandbox: !c.sandbox })} label={`${n.name} sandbox`} />
                          <span>Sandbox</span>
                        </label>
                      </div>
                      {c.sandbox ? (
                        <div className="mt-2">
                          <label className="block text-[11px] text-gray-500 mb-1">Sandbox channel</label>
                          <input type="text" value={c.sandboxChannel}
                            onChange={(e) => patch(n.key, { sandboxChannel: e.target.value })}
                            placeholder={defaultSandbox}
                            className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm font-mono focus:outline-none focus:border-brand" />
                        </div>
                      ) : n.defaultChannel ? (
                        /* Live-channel override — only for notifications with a fixed
                           destination (scope cards route per-region, so they're omitted).
                           Blank = the code/env default (shown as the placeholder). */
                        <div className="mt-2">
                          <label className="block text-[11px] text-gray-500 mb-1">Live channel <span className="text-gray-400">(blank = default)</span></label>
                          <input type="text" value={c.channel}
                            onChange={(e) => patch(n.key, { channel: e.target.value })}
                            placeholder={n.defaultChannel}
                            className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm font-mono focus:outline-none focus:border-brand" />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-3 mt-4">
                <button type="button" onClick={() => void save()} disabled={busy}
                  className="h-10 px-5 rounded-xl bg-brand text-white font-heading font-bold text-sm hover:opacity-90 disabled:bg-gray-300">
                  {busy ? 'Saving…' : 'Save'}
                </button>
                {saved && <span className="text-emerald-600 text-sm font-heading font-semibold">Saved ✓</span>}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
