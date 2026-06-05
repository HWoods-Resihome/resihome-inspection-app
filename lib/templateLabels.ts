/**
 * Canonical, human-readable template names — the SHORT names exactly as they
 * appear in the new-inspection selector, with NO "(PM)/(QC)/(1099)" prefix or
 * other parenthetical. Used everywhere a template is shown OR saved (card
 * kickers, the inspection header, and the generated PDFs attached to HubSpot)
 * so the name is consistent across the app and in HubSpot.
 *
 * Keep this in sync with TEMPLATE_OPTIONS in pages/inspection/new.tsx.
 */
const TEMPLATE_LABELS: Record<string, string> = {
  pm_scope_rate_card: 'Scope Rate Card',
  pm_turn_reinspect_qc: 'Turn Re-Inspect QC',
  pm_community_inspection: 'Community / Visit Inspection',
  pm_vacancy_occupancy_check: 'Vacancy / Occupancy Check',
  leasing_agent_1099_property_inspection: 'Leasing Agent Inspection',
  qc_new_construction_rrqc: 'New Construction RRQC',
  // Legacy template types — retired from new inspections but kept so historical
  // records still show a clean label.
  pm_scope_inspection: 'Scope',
  pm_turn_inspection: 'Turn',
  pm_property_visit_inspection: 'Property Visit',
  qc_completed_unit_inspection: 'QC Completed Unit',
  preleasing_property_inspection: 'Pre-leasing Property',
};

const ACRONYMS = new Set(['QC', 'PM', 'RRQC', '1099']);

/** The clean short template name for a given internal template type. */
export function templateLabel(t: string): string {
  if (!t) return '';
  if (TEMPLATE_LABELS[t]) return TEMPLATE_LABELS[t];
  // Fallback: prettify an unknown internal key (no parenthetical prefixes).
  return t
    .replace(/^pm_/, '')
    .replace(/^qc_/, 'QC ')
    .replace(/_inspection$/, '')
    .replace(/_/g, ' ')
    .split(' ')
    .map((w) => {
      const up = w.toUpperCase();
      if (ACRONYMS.has(up)) return up;
      return w.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('-');
    })
    .join(' ')
    .trim();
}
