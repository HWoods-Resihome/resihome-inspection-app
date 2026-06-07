/**
 * Admin-only bar to change which form (template) an inspection uses. Renders
 * nothing unless the viewer is an app admin AND the current template is an
 * editable (question-driven) one — Scope/QC inspections are never reassignable.
 * Self-contained: fetches its own admin flag + template list, so it can be
 * dropped into a page with no extra wiring.
 */
import { useEffect, useState } from 'react';

interface TemplateInfo { id: string; label: string; custom: boolean; }

export function ReassignFormBar({ inspectionId, templateType }: { inspectionId: string; templateType: string }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => setIsAdmin(!!d?.isAdmin)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!isAdmin) return;
    fetch('/api/admin/templates').then((r) => r.json()).then((d) => setTemplates(d?.templates || [])).catch(() => {});
  }, [isAdmin]);

  // Only show for admins, and only when the CURRENT template is editable (the
  // server enforces this too — Scope/QC can't be reassigned).
  const currentEditable = templates.some((t) => t.id === templateType);
  if (!isAdmin || templates.length === 0 || !currentEditable) return null;

  async function reassign() {
    if (!target || target === templateType) { setOpen(false); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/admin/inspections/${inspectionId}/template`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateType: target }),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(d.error || 'Could not change the form.'); return; }
      setMsg('Form changed — reloading…');
      setTimeout(() => window.location.reload(), 600);
    } finally { setBusy(false); }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 mt-3">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-heading font-bold uppercase tracking-wide text-amber-700">Admin</span>
        {!open ? (
          <button type="button" onClick={() => { setOpen(true); setTarget(templateType); }}
            className="text-xs font-heading font-semibold text-amber-800 hover:underline">Change form</button>
        ) : (
          <>
            <select value={target} onChange={(e) => setTarget(e.target.value)}
              className="text-xs border border-amber-300 rounded px-2 py-1 bg-white">
              {templates.map((t) => <option key={t.id} value={t.id}>{t.label}{t.custom ? ' (custom)' : ''}</option>)}
            </select>
            <button type="button" onClick={reassign} disabled={busy || target === templateType}
              className="text-xs font-heading font-bold text-white bg-amber-600 hover:bg-amber-700 rounded px-2.5 py-1 disabled:opacity-50">Save</button>
            <button type="button" onClick={() => setOpen(false)} className="text-xs font-heading font-semibold text-gray-600">Cancel</button>
          </>
        )}
        {msg && <span className="text-[11px] text-amber-800">{msg}</span>}
      </div>
    </div>
  );
}
