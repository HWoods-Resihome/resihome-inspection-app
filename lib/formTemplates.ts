/**
 * Inspection templates — built-in (in code) + custom (admin-created, stored on
 * the Agent record). Server-only (reads HubSpot); the form builder and the
 * New-Inspection picker consume it via API routes.
 *
 * Custom templates are always question-driven and therefore editable; Scope and
 * Turn Re-Inspect QC are never custom and never editable here.
 */
import { EDITABLE_TEMPLATES, isProtectedTemplate } from '@/lib/formBuilder';
import { readAppTemplates, writeAppTemplates, type AppTemplateRecord } from '@/lib/hubspot';

export interface TemplateInfo { id: string; label: string; custom: boolean; }

let _cache: { list: AppTemplateRecord[]; at: number } | null = null;
const TTL_MS = 60_000;

export async function getCustomTemplates(): Promise<AppTemplateRecord[]> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.list;
  let list: AppTemplateRecord[] = [];
  try { list = await readAppTemplates(); } catch { /* fall back to none */ }
  _cache = { list, at: Date.now() };
  return list;
}
function bustCache() { _cache = null; }

/** Editable templates for the form builder: built-in question-driven + custom. */
export async function getEditableTemplates(): Promise<TemplateInfo[]> {
  const custom = await getCustomTemplates();
  return [
    ...EDITABLE_TEMPLATES.map((e) => ({ id: e.id, label: e.label, custom: false })),
    ...custom.map((c) => ({ id: c.id, label: c.label, custom: true })),
  ];
}

/** Is this template editable in the form builder? (built-in editable OR custom; never protected) */
export async function isEditableTemplateAsync(t: string): Promise<boolean> {
  const id = String(t || '').trim();
  if (!id || isProtectedTemplate(id)) return false;
  if (EDITABLE_TEMPLATES.some((e) => e.id === id)) return true;
  return (await getCustomTemplates()).some((c) => c.id === id);
}

function slugify(label: string): string {
  return String(label).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'template';
}

/** Create a custom template. Returns the new template. */
export async function addCustomTemplate(label: string, byEmail: string): Promise<AppTemplateRecord> {
  const clean = String(label || '').trim();
  if (clean.length < 2) throw new Error('Template name is too short.');
  const list = await readAppTemplates();
  // Avoid duplicate labels (case-insensitive).
  if (list.some((t) => t.label.toLowerCase() === clean.toLowerCase())) throw new Error('A template with that name already exists.');
  const id = `custom_${slugify(clean)}_${Math.random().toString(36).slice(2, 6)}`;
  const rec: AppTemplateRecord = { id, label: clean, createdByEmail: (byEmail || '').toLowerCase(), createdAt: Date.now() };
  list.push(rec);
  await writeAppTemplates(list);
  bustCache();
  return rec;
}

/** Remove a custom template (does NOT delete its questions). */
export async function removeCustomTemplate(id: string): Promise<void> {
  const list = await readAppTemplates();
  await writeAppTemplates(list.filter((t) => t.id !== id));
  bustCache();
}
