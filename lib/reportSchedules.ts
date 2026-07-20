/**
 * lib/reportSchedules.ts — SERVER-ONLY. Scheduled emailed billing reports.
 *
 * A schedule captures: which dataset (inspections/services), the filters
 * (region/portfolio/inspector + a RELATIVE completed-date range that re-resolves
 * each run), recipients, and a cadence (daily / weekly / monthly) at a chosen ET
 * hour. The hourly cron (api/cron/report-schedules) resolves each due schedule to
 * a concrete date range, builds the .xlsx, and emails it from the system mailbox.
 *
 * Stored as one JSON array on the Agent record (report_schedules_json).
 */
import { readReportSchedulesRaw, mutateReportSchedulesRaw } from '@/lib/hubspot';
import { fetchBillingRows } from '@/lib/insightsBilling';
import { buildBillingXlsx, billingFilename } from '@/lib/insightsBillingXlsx';
import { sendNotificationEmail, appBaseUrl } from '@/lib/notifications/send';

export type ReportObject = 'inspections' | 'services';
export type Cadence = 'daily' | 'weekly' | 'monthly';
// Relative completed-date windows re-resolved at send time (ET).
export type RelativeRange =
  | 'today' | 'yesterday' | 'last_7_days' | 'last_30_days'
  | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'this_year' | 'all';

export const RELATIVE_RANGE_LABELS: Record<RelativeRange, string> = {
  today: 'Today', yesterday: 'Yesterday', last_7_days: 'Last 7 days', last_30_days: 'Last 30 days',
  this_week: 'This week', last_week: 'Last week', this_month: 'This month', last_month: 'Last month',
  this_year: 'This year', all: 'All time',
};

export interface ReportSchedule {
  id: string;
  name: string;
  object: ReportObject;
  recipients: string[];
  regions: string[];
  portfolios: string[];
  inspectors: string[];
  types: string[];             // template/service type labels
  range: RelativeRange;        // completed-date window (relative)
  cadence: Cadence;
  hourET: number;              // 0–23, Eastern
  dayOfWeek?: number;          // weekly: 0=Sun … 6=Sat
  dayOfMonth?: number;         // monthly: 1–31 (clamped to month length)
  enabled: boolean;
  createdByEmail?: string;
  createdAt?: string;
  lastRunDate?: string;        // YYYY-MM-DD (ET) of the last successful send — dedup guard
  lastRunAt?: string;          // ISO of the last send attempt
}

// ── ET date helpers (no external tz lib) ────────────────────────────────────
/** Parts of `date` in America/New_York: { y,m,d,hour,dow }. */
export function etParts(date: Date): { y: number; m: number; d: number; hour: number; dow: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    hour: Number(parts.hour) % 24, dow: dowMap[parts.weekday as string] ?? 0,
  };
}
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** Shift a YYYY-MM-DD by n days (UTC-safe date math on the calendar date). */
export function addDaysISO(day: string, n: number): string {
  const dt = new Date(`${day}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Resolve a relative range to { from, to } (inclusive YYYY-MM-DD, ET-anchored). */
export function resolveRange(range: RelativeRange, now: Date = new Date()): { from?: string; to?: string } {
  const p = etParts(now);
  const today = iso(p.y, p.m, p.d);
  switch (range) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = addDaysISO(today, -1); return { from: y, to: y }; }
    case 'last_7_days': return { from: addDaysISO(today, -6), to: today };
    case 'last_30_days': return { from: addDaysISO(today, -29), to: today };
    case 'this_week': { const start = addDaysISO(today, -p.dow); return { from: start, to: today }; }       // Sun-start
    case 'last_week': { const thisStart = addDaysISO(today, -p.dow); return { from: addDaysISO(thisStart, -7), to: addDaysISO(thisStart, -1) }; }
    case 'this_month': return { from: iso(p.y, p.m, 1), to: today };
    case 'last_month': { const lm = p.m === 1 ? 12 : p.m - 1; const ly = p.m === 1 ? p.y - 1 : p.y; const lastDay = new Date(Date.UTC(ly, lm, 0)).getUTCDate(); return { from: iso(ly, lm, 1), to: iso(ly, lm, lastDay) }; }
    case 'this_year': return { from: iso(p.y, 1, 1), to: today };
    case 'all': default: return {};
  }
}

/** Is this schedule due to run at `now` (ET), and not already run today? */
export function isScheduleDue(s: ReportSchedule, now: Date = new Date()): boolean {
  if (!s.enabled || !s.recipients?.length) return false;
  const p = etParts(now);
  if (p.hour !== (s.hourET | 0)) return false;
  const todayET = iso(p.y, p.m, p.d);
  if (s.lastRunDate === todayET) return false;   // already sent this ET day
  if (s.cadence === 'daily') return true;
  if (s.cadence === 'weekly') return p.dow === (s.dayOfWeek ?? 1);
  if (s.cadence === 'monthly') {
    const lastDay = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();
    const target = Math.min(Math.max(1, s.dayOfMonth ?? 1), lastDay);   // clamp (e.g. 31 → Feb 28)
    return p.d === target;
  }
  return false;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const clampHour = (h: unknown) => Math.min(23, Math.max(0, Math.floor(Number(h) || 0)));

/** Normalize/validate a schedule from client input. Throws on invalid. */
export function normalizeSchedule(input: any, byEmail?: string): ReportSchedule {
  const object: ReportObject = input?.object === 'services' ? 'services' : 'inspections';
  const cadence: Cadence = ['daily', 'weekly', 'monthly'].includes(input?.cadence) ? input.cadence : 'weekly';
  const recipients = Array.from(new Set<string>((Array.isArray(input?.recipients) ? input.recipients : [])
    .map((e: any) => String(e || '').trim().toLowerCase()).filter((e: string) => EMAIL_RE.test(e))));
  if (!recipients.length) throw new Error('At least one valid recipient email is required.');
  const range: RelativeRange = (RELATIVE_RANGE_LABELS as any)[input?.range] ? input.range : 'last_7_days';
  const strList = (v: any) => (Array.isArray(v) ? v : []).map((s: any) => String(s)).filter(Boolean);
  return {
    id: String(input?.id || '').trim() || `sch_${Math.random().toString(36).slice(2, 10)}`,
    name: String(input?.name || '').trim().slice(0, 120) || `${object === 'services' ? 'Services' : 'Inspections'} Billing`,
    object, recipients,
    regions: strList(input?.regions),
    portfolios: strList(input?.portfolios),
    inspectors: strList(input?.inspectors),
    types: strList(input?.types),
    range, cadence,
    hourET: clampHour(input?.hourET),
    dayOfWeek: cadence === 'weekly' ? Math.min(6, Math.max(0, Math.floor(Number(input?.dayOfWeek) || 0))) : undefined,
    dayOfMonth: cadence === 'monthly' ? Math.min(31, Math.max(1, Math.floor(Number(input?.dayOfMonth) || 1))) : undefined,
    enabled: input?.enabled !== false,
    createdByEmail: byEmail || input?.createdByEmail || undefined,
    createdAt: input?.createdAt || new Date().toISOString(),
    lastRunDate: input?.lastRunDate || undefined,
    lastRunAt: input?.lastRunAt || undefined,
  };
}

// ── Store CRUD ───────────────────────────────────────────────────────────────
export async function listSchedules(): Promise<ReportSchedule[]> {
  const raw = await readReportSchedulesRaw<ReportSchedule[]>().catch(() => null);
  return Array.isArray(raw) ? raw : [];
}
export async function upsertSchedule(s: ReportSchedule): Promise<boolean> {
  return mutateReportSchedulesRaw<ReportSchedule[]>((cur) => {
    const list = Array.isArray(cur) ? cur.slice() : [];
    const i = list.findIndex((x) => x.id === s.id);
    if (i >= 0) list[i] = s; else list.push(s);
    return list;
  });
}
export async function deleteSchedule(id: string): Promise<boolean> {
  return mutateReportSchedulesRaw<ReportSchedule[]>((cur) => (Array.isArray(cur) ? cur.filter((x) => x.id !== id) : []));
}
export async function markScheduleRun(id: string, dateET: string): Promise<void> {
  await mutateReportSchedulesRaw<ReportSchedule[]>((cur) =>
    (Array.isArray(cur) ? cur : []).map((x) => (x.id === id ? { ...x, lastRunDate: dateET, lastRunAt: new Date().toISOString() } : x)),
  ).catch(() => {});
}

/** Build + email a schedule's report right now (used by the cron and the
 *  "Send test" button). Resolves the relative range, builds the .xlsx, and
 *  emails it to every recipient from the system mailbox. Returns rows sent. */
/** YYYY-MM-DD → MM-DD-YY (e.g. 2026-07-20 → 07-20-26). */
export function mmddyy(day?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
  return m ? `${m[2]}-${m[3]}-${m[1].slice(2)}` : '';
}
/** Title Case a report name ("inspections billing" → "Inspections Billing"). */
function titleCase(s: string): string {
  return String(s || '').replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export async function sendScheduleNow(s: ReportSchedule, req?: { headers: Record<string, any> } | null, now: Date = new Date()): Promise<{ sent: boolean; rows: number; error?: string }> {
  const { from, to } = resolveRange(s.range, now);
  const rows = await fetchBillingRows(s.object, { regions: s.regions, portfolios: s.portfolios, inspectors: s.inspectors, types: s.types, from, to });
  const buf = await buildBillingXlsx(s.object, rows);
  const [to0, ...alsoTo] = s.recipients;
  const objLabel = s.object === 'services' ? 'Services' : 'Inspections';
  // MM-DD-YY -> MM-DD-YY (or "All Time"), used identically in title + body.
  const period = (from || to) ? `${mmddyy(from) || '…'} -> ${mmddyy(to) || '…'}` : 'All Time';
  const title = titleCase(s.name || `${objLabel} Billing`);
  const r = await sendNotificationEmail({
    to: to0,
    alsoTo,
    subject: `${title} — ${period}`,
    heading: title,
    intro: `${title} — ${period}. ${rows.length} row${rows.length === 1 ? '' : 's'} attached.`,
    rows: [
      ['Report', title],
      ['Date Range', period],
      ['Filters', [s.regions.length ? `${s.regions.length} region(s)` : '', s.portfolios.length ? `${s.portfolios.length} portfolio(s)` : '', s.inspectors.length ? `${s.inspectors.length} ${s.object === 'services' ? 'vendor' : 'inspector'}(s)` : '', s.types?.length ? `${s.types.length} type(s)` : ''].filter(Boolean).join(' · ') || 'None'],
    ],
    linkUrl: `${appBaseUrl(req)}/insights${s.object === 'services' ? '?tab=services' : ''}`,
    linkLabel: 'Open Insights',
    attachment: { filename: billingFilename(s.object, (to || from || new Date().toISOString().slice(0, 10))), content: buf, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  });
  return { sent: r.sent, rows: rows.length, error: r.error };
}
