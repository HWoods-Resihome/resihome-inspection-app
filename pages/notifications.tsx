import { useState } from 'react';
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
        {isAdmin && (
          <p className="text-[12px] text-gray-400">Admin test-send controls are coming to this screen.</p>
        )}
      </main>
    </div>
  );
}
