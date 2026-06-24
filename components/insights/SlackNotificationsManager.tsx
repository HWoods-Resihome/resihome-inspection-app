/**
 * Slack Notifications — admin table to turn each ResiWalk Slack notification
 * on/off and route it to a sandbox channel for testing. One row per registered
 * notification (scope pending, scope approved, listing-price). Saving persists to
 * the Agent record; every notification reads this config at send time. Dark theme
 * to match the in-portal admin menu. Backend: /api/insights/slack-notifications.
 */
import { useCallback, useEffect, useState } from 'react';

interface NotifDef { key: string; name: string }
interface NotifCfg { enabled: boolean; sandbox: boolean; sandboxChannel: string }

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? 'bg-[#ff0060]' : 'bg-[#3a3a42]'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

export function SlackNotificationsManager() {
  const [defs, setDefs] = useState<NotifDef[] | null>(null);
  const [cfg, setCfg] = useState<Record<string, NotifCfg>>({});
  const [defaultSandbox, setDefaultSandbox] = useState('C06CW2VMJNR');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/insights/slack-notifications', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to load'); return; }
      setDefs(d.notifications || []);
      setDefaultSandbox(d.defaultSandbox || 'C06CW2VMJNR');
      const next: Record<string, NotifCfg> = {};
      for (const n of (d.notifications || [])) {
        const c = (d.config || {})[n.key] || {};
        next[n.key] = {
          enabled: c.enabled !== false,
          sandbox: c.sandbox === true,
          sandboxChannel: String(c.sandboxChannel || '').trim() || (d.defaultSandbox || 'C06CW2VMJNR'),
        };
      }
      setCfg(next);
    } catch (e: any) { setError(String(e?.message || e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const patch = (key: string, p: Partial<NotifCfg>) => { setCfg((c) => ({ ...c, [key]: { ...c[key], ...p } })); setSaved(false); };

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const r = await fetch('/api/insights/slack-notifications', {
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
    <div className="bg-[#18181c] rounded-2xl border border-white/10 p-5 max-w-3xl">
      <h3 className="font-heading font-bold text-sm text-[#f4f4f5] mb-1">Slack Notifications</h3>
      <p className="text-xs text-[#a1a1aa] mb-4">
        Turn each notification on or off, and route it to a sandbox channel while testing. When Sandbox is on, that notification posts to the sandbox channel instead of its live destination.
      </p>

      {error && <div className="text-sm text-[#ff0060] font-heading font-semibold mb-3">{error}</div>}

      {defs === null ? (
        <div className="text-sm text-[#71717a]">Loading…</div>
      ) : (
        <>
          <div className="border border-white/10 rounded-lg divide-y divide-white/10">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-2 text-[11px] uppercase tracking-wide text-[#71717a] font-heading font-semibold">
              <div>Notification</div><div className="text-center w-14">On</div><div className="text-center w-16">Sandbox</div><div className="w-44">Sandbox channel</div>
            </div>
            {defs.map((n) => {
              const c = cfg[n.key] || { enabled: true, sandbox: false, sandboxChannel: defaultSandbox };
              return (
                <div key={n.key} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-3 items-center">
                  <div className="min-w-0">
                    <div className="text-sm text-[#f4f4f5] truncate">{n.name}</div>
                    <div className="text-[10px] text-[#71717a] font-mono">{n.key}{c.sandbox ? ' · SANDBOX' : c.enabled ? '' : ' · OFF'}</div>
                  </div>
                  <div className="w-14 flex justify-center"><Toggle on={c.enabled} onClick={() => patch(n.key, { enabled: !c.enabled })} label={`${n.name} on/off`} /></div>
                  <div className="w-16 flex justify-center"><Toggle on={c.sandbox} onClick={() => patch(n.key, { sandbox: !c.sandbox })} label={`${n.name} sandbox`} /></div>
                  <div className="w-44">
                    <input type="text" value={c.sandboxChannel} disabled={!c.sandbox}
                      onChange={(e) => patch(n.key, { sandboxChannel: e.target.value })}
                      placeholder={defaultSandbox}
                      className="w-full border border-white/10 bg-[#232329] text-[#f4f4f5] placeholder-[#71717a] rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-[#ff0060] disabled:opacity-40" />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button type="button" onClick={() => void save()} disabled={busy}
              className="bg-[#ff0060] hover:bg-[#cc004d] disabled:opacity-50 text-white font-heading font-semibold rounded-lg px-4 py-2 text-sm">
              {busy ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="text-[#73E3DF] text-sm font-heading font-semibold">Saved ✓</span>}
          </div>
        </>
      )}
    </div>
  );
}
