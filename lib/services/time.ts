// Business-timezone date helpers for Services. All "today" / due / on-time math
// uses Eastern (America/New_York) — the business timezone — so a service due
// "today" doesn't flip to past-due at UTC midnight while it's still the prior day
// on the East Coast. Date ARITHMETIC (addDaysISO) is anchored on a date-only
// string at UTC midnight, which is timezone-neutral (adding N days never shifts
// the calendar date). Use these everywhere in Services instead of raw
// `new Date().toISOString().slice(0,10)`.

/** Today's date (YYYY-MM-DD) in Eastern time — the business timezone. */
export function easternTodayISO(): string {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}

/** Add whole days to a YYYY-MM-DD date, returned as YYYY-MM-DD (timezone-neutral). */
export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
