/**
 * Shared section utilities used by both RateCardForm and QuestionForm.
 *
 * A SectionInstance is one row in the form's section list. It has:
 *  - id            stable React key + lookup id (unique per inspection)
 *  - key           "kind" of section (yard_exterior, bedroom, custom, ...)
 *  - label         current display label (renamed by user, or default)
 *  - location      IMMUTABLE — written onto saved answer records. Renames do
 *                  NOT change this. Empty for non-repeating sections.
 *  - displayName   shown in the UI header; for repeating sections this also
 *                  includes the location ("Bedroom 1") and optional suffix
 *                  like "(Main)". For renamed sections, displayName === label.
 *  - isCustom      true for sections added by the inspector (not a default)
 *  - photoOptional true for sections where photos aren't required
 *
 * Persistence: when the inspector edits the section list, the runtime computes
 * a JSON array of {id, label, location, key, isCustom, photoOptional} and
 * stores it on inspection.section_list_json. On load, this overrides the
 * auto-derived defaults from bedrooms/bathrooms.
 *
 * Default section changes for v0.19 (Phase 4.5):
 *   - REMOVED:  Bonus Room, Basement
 *   - MERGED:   Hallway + Stairs -> "Hallway / Stairs"
 */

export interface SectionInstance {
  id: string;
  key: string;
  label: string;
  location: string;
  displayName: string;
  isCustom?: boolean;
  photoOptional?: boolean;
}

type SectionDef =
  | { type: 'static'; key: string; label: string; photoOptional?: boolean }
  | { type: 'bed_bath_block' }
  | { type: 'half_bath' };

// The default static section order. Repeating sections (bedroom/bathroom)
// expand inline.
const SECTION_ORDER: SectionDef[] = [
  { type: 'static',         key: 'yard_exterior',       label: 'Yard / Exterior' },
  { type: 'static',         key: 'entry_foyer',         label: 'Entry / Foyer' },
  { type: 'static',         key: 'family_living_room',  label: 'Family / Living Room' },
  { type: 'static',         key: 'dining_room',         label: 'Dining Room' },
  { type: 'static',         key: 'kitchen',             label: 'Kitchen' },
  { type: 'static',         key: 'hallway_stairs',      label: 'Hallway / Stairs' },
  { type: 'bed_bath_block' },
  { type: 'half_bath' },
  { type: 'static',         key: 'laundry_room',        label: 'Laundry Room' },
  { type: 'static',         key: 'garage',              label: 'Garage' },
  { type: 'static',         key: 'whole_house',         label: 'Whole House' },
  { type: 'static',         key: 'mechanicals_hvac',    label: 'HVAC / Mechanicals' },
  { type: 'static',         key: 'smart_home_locks',    label: 'Smart Home / Locks', photoOptional: true },
];

/**
 * Expand the default section list given bedroom + bathroom counts.
 * No customization applied yet — this is the seed used when the inspection
 * has no stored section_list_json.
 */
export function deriveDefaultSections(bedrooms: number, bathrooms: number): SectionInstance[] {
  const wholeBaths = Math.floor(bathrooms);
  const hasHalfBath = bathrooms - wholeBaths >= 0.5;

  const out: SectionInstance[] = [];
  for (const def of SECTION_ORDER) {
    if (def.type === 'static') {
      out.push({
        id: def.key,
        key: def.key,
        label: def.label,
        location: '',
        displayName: def.label,
        photoOptional: def.photoOptional,
      });
    } else if (def.type === 'bed_bath_block') {
      // Interleave: Bedroom 1, Bathroom 1, Bedroom 2, Bathroom 2, ...
      // Continue past either count if the other is longer. For example
      // 3 bed / 1 bath produces:
      //   Bedroom 1 (Main), Bathroom 1 (Main), Bedroom 2, Bedroom 3
      const maxCount = Math.max(bedrooms, wholeBaths);
      for (let i = 1; i <= maxCount; i++) {
        if (i <= bedrooms) {
          const loc = `Bedroom ${i}`;
          const displayName = i === 1 ? `${loc} (Main)` : loc;
          out.push({ id: `bedroom__${i}`, key: 'bedroom', label: 'Bedroom', location: loc, displayName });
        }
        if (i <= wholeBaths) {
          const loc = `Bathroom ${i}`;
          const displayName = i === 1 ? `${loc} (Main)` : loc;
          out.push({ id: `bathroom__${i}`, key: 'bathroom', label: 'Bathroom', location: loc, displayName });
        }
      }
    } else if (def.type === 'half_bath') {
      if (hasHalfBath) {
        out.push({
          id: 'bathroom__half',
          key: 'bathroom',
          label: 'Bathroom',
          location: 'Half Bath',
          displayName: 'Half Bath',
        });
      }
    }
  }
  return out;
}

/**
 * Parse the stored section_list_json into SectionInstance[]. Returns null
 * if the JSON is invalid or missing, in which case the caller should fall
 * back to deriveDefaultSections().
 *
 * Forward-compat: unknown fields on a descriptor are ignored. Missing fields
 * default to sane values so old/partial JSON doesn't break.
 */
export function parseSectionListJson(json: string | null | undefined): SectionInstance[] | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return null;
    const out: SectionInstance[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || '');
      if (!id) continue;   // an id is required
      const label = String(item.label || id);
      const location = String(item.location || '');
      // displayName isn't always stored — fall back to label, plus location
      // suffix for repeating sections (when location differs from label).
      const displayName = item.displayName != null
        ? String(item.displayName)
        : (location && location !== label ? `${label} — ${location}` : label);
      out.push({
        id,
        key: String(item.key || id),
        label,
        location,
        displayName,
        isCustom: !!item.isCustom,
        photoOptional: !!item.photoOptional,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Serialize a SectionInstance[] back to JSON for storage on the Inspection.
 * Only stores fields that aren't derivable; displayName is derivable from
 * label+location so we omit it (and re-compute on parse) to keep the JSON
 * compact.
 */
export function serializeSectionList(sections: SectionInstance[]): string {
  return JSON.stringify(sections.map((s) => ({
    id: s.id,
    key: s.key,
    label: s.label,
    location: s.location,
    isCustom: s.isCustom || undefined,
    photoOptional: s.photoOptional || undefined,
  })));
}

/**
 * Title-case a free-form section name. "sun room" -> "Sun Room", "ADU"
 * stays "ADU" (all-caps acronyms stay upper). Strips leading/trailing
 * whitespace and collapses internal runs of whitespace.
 */
export function titleCaseSectionName(input: string): string {
  const trimmed = input.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  return trimmed.split(' ').map((word) => {
    // Preserve all-caps words 2+ chars (likely acronyms: ADU, HVAC, etc.)
    if (word.length >= 2 && word === word.toUpperCase() && /^[A-Z]+$/.test(word)) {
      return word;
    }
    // Otherwise: first letter upper, rest lower
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}

/**
 * Generate a stable id for a new custom section based on its label. Falls
 * back to a timestamp suffix when a collision exists in existingIds.
 */
export function makeCustomSectionId(label: string, existingIds: Set<string>): string {
  const base = `custom__${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'section'}`;
  if (!existingIds.has(base)) return base;
  let i = 2;
  while (existingIds.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/**
 * Build the section list for the form: parse stored JSON if present,
 * else fall back to defaults derived from bedrooms/bathrooms.
 */
export function resolveSections(
  sectionListJson: string | null | undefined,
  bedrooms: number,
  bathrooms: number,
): SectionInstance[] {
  const parsed = parseSectionListJson(sectionListJson);
  if (parsed && parsed.length > 0) return parsed;
  return deriveDefaultSections(bedrooms, bathrooms);
}
