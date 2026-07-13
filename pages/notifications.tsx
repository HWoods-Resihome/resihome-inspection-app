import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { PageHeader } from '@/components/PageHeader';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { getNotificationPrefs } from '@/lib/notifications/prefs';
import { NOTIFICATIONS, type NotificationKey } from '@/lib/notifications/catalog';

interface Access { inspections: boolean; services: boolean }
interface TestRecord { id: string; label: string; status: string }

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  if (!session?.email) return { redirect: { destination: '/login', permanent: false } };
  const [prefs, services, admin] = await Promise.all([
    getNotificationPrefs(session.email),
    servicesEnabled(session.email).catch(() => false),
    isAppAdmin(session.email).catch(() => false),
  ]);
  return { props: { initialPrefs: prefs, access: { inspections: true, services }, isAdmin: admin, email: session.email } };
};

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={onClick}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${on ? 'bg-brand' : 'bg-gray-300'} ${disabled ? 'opacity-50' : ''}`}>
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}

export default function NotificationSettings({ initialPrefs, access, isAdmin, email }: {
  initialPrefs: Record<NotificationKey, boolean>; access: Access; isAdmin: boolean; email: string;
}) {
  const router = useRouter();
  const [prefs, setPrefs] = useState(initialPrefs);
  const [saving, setSaving] = useState<NotificationKey | null>(null);
  const [err, setErr] = useState('');

  const objects: Array<{ id: 'inspections' | 'services'; label: string }> = [];
  if (access.inspections) objects.push({ id: 'inspections', label: 'Inspections' });
  if (access.services) objects.push({ id: 'services', label: 'Services' });

  const toggle = async (key: NotificationKey) => {
    const next = !prefs[key];
    setPrefs((p) => ({ ...p, [key]: next }));   // optimistic
    setSaving(key); setErr('');
    try {
      const r = await fetch('/api/notifications/prefs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefs: { [key]: next } }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setErr(d.error || 'Could not save.'); setPrefs((p) => ({ ...p, [key]: !next })); }
    } catch { setErr('Couldn’t reach the server. Try again.'); setPrefs((p) => ({ ...p, [key]: !next })); }
    finally { setSaving(null); }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <PageHeader title="Notification Settings" onBack={() => router.back()} homeHref="/" />
      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        <p className="text-[13px] text-gray-500">
          Emails are sent to <b className="text-ink">{email}</b>. Turn any of these off and you won’t receive them.
        </p>
        {objects.map((obj) => (
          <section key={obj.id} className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
            <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 font-heading font-bold text-[15px] text-ink">{obj.label}</div>
            <ul className="divide-y divide-gray-100">
              {NOTIFICATIONS.filter((n) => n.object === obj.id).map((n) => (
                <li key={n.key} className="flex items-start gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-heading font-semibold text-ink">{n.label}</div>
                    <div className="text-[12px] text-gray-500 mt-0.5">{n.description}</div>
                  </div>
                  <Toggle on={prefs[n.key]} disabled={saving === n.key} onClick={() => toggle(n.key)} />
                </li>
              ))}
            </ul>
          </section>
        ))}
        {err && <p className="text-[12px] text-red-600">{err}</p>}
        {isAdmin && <TestSend email={email} access={access} />}
      </main>
    </div>
  );
}

// Admin-only: send any of the notification emails to yourself, built from a real
// record you pick (search a live inspection/service). Bypasses toggles (it's a test).
function TestSend({ email, access }: { email: string; access: Access }) {
  const options = NOTIFICATIONS.filter((n) => (n.object === 'inspections' ? access.inspections : access.services));
  const [key, setKey] = useState<NotificationKey>(options[0]?.key || 'inspection_completed');
  const def = NOTIFICATIONS.find((n) => n.key === key)!;
  const [byObj, setByObj] = useState<Record<string, TestRecord[]>>({});
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [recordId, setRecordId] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const obj = def.object;
    if (byObj[obj]) return;
    setLoading(true);
    fetch(`/api/notifications/test-records?object=${obj}`)
      .then((r) => r.json())
      .then((d) => setByObj((prev) => ({ ...prev, [obj]: Array.isArray(d.records) ? d.records : [] })))
      .catch(() => setByObj((prev) => ({ ...prev, [obj]: [] })))
      .finally(() => setLoading(false));
  }, [def.object, byObj]);

  const records = byObj[def.object] || [];
  const selected = records.find((r) => r.id === recordId) || null;
  const filtered = records.filter((r) => !q.trim() || r.label.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 25);

  const send = async () => {
    if (!recordId) return;
    setSending(true); setMsg(null);
    try {
      const r = await fetch('/api/notifications/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, recordId }),
      });
      const d = await r.json();
      setMsg(r.ok ? { ok: true, text: `Test “${def.label}” sent to ${email}.` } : { ok: false, text: d.error || 'Failed to send.' });
    } catch { setMsg({ ok: false, text: 'Couldn’t reach the server. Try again.' }); }
    finally { setSending(false); }
  };

  const inp = 'w-full text-[13px] px-2.5 py-2 border border-gray-300 rounded-lg bg-white text-ink focus:outline-none focus:border-brand';

  return (
    <section className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
        <div className="font-heading font-bold text-[15px] text-ink">Test send <span className="text-[11px] font-normal text-gray-400 uppercase tracking-wide">Admin</span></div>
        <p className="text-[12px] text-gray-500 mt-0.5">Send any notification to yourself ({email}) using a real record.</p>
      </div>
      <div className="p-4 space-y-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Notification</div>
          <select value={key} onChange={(e) => { setKey(e.target.value as NotificationKey); setRecordId(''); setQ(''); setMsg(null); }} className={inp}>
            {options.map((n) => <option key={n.key} value={n.key}>{n.label} ({n.object})</option>)}
          </select>
        </div>
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Sample {def.object === 'inspections' ? 'inspection' : 'service'}</div>
          {selected ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-[13px] text-ink border border-gray-200 rounded-lg px-2.5 py-2 bg-gray-50">{selected.label}</span>
              <button type="button" onClick={() => { setRecordId(''); setQ(''); }} className="text-[12px] font-semibold text-gray-500 px-1">Change</button>
            </div>
          ) : (
            <>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={loading ? 'Loading…' : 'Search by address or type…'} className={inp} />
              {q.trim() && (
                <div className="mt-1 max-h-52 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {filtered.map((r) => (
                    <button key={r.id} type="button" onClick={() => { setRecordId(r.id); }} className="w-full text-left px-3 py-2 text-[13px] hover:bg-gray-50">
                      <span className="text-ink">{r.label}</span>{r.status ? <span className="text-[11px] text-gray-400"> · {r.status}</span> : ''}
                    </button>
                  ))}
                  {!filtered.length && <div className="px-3 py-3 text-center text-[12px] text-gray-400">No matches.</div>}
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={send} disabled={!recordId || sending}
            className="text-[13px] font-heading font-bold text-white bg-brand rounded-lg px-4 py-2 disabled:opacity-50">{sending ? 'Sending…' : 'Send test to me'}</button>
          {msg && <span className={`text-[12px] ${msg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{msg.text}</span>}
        </div>
      </div>
    </section>
  );
}
