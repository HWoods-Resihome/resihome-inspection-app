/**
 * Parse a HubSpot write error to find which property names it rejected — either
 * an unknown property (PROPERTY_DOESNT_EXIST) or an invalid enum value
 * (INVALID_OPTION / "was not one of the allowed options"). Callers strip the
 * named props and retry so a not-yet-provisioned field, or a NEW enum/answer
 * value, can never 400 an older record's write.
 *
 * NOTE: HubSpot nests the validation detail as a JSON-ESCAPED string
 * (`...\"name\":\"review_decision\"...`), so we de-escape backslashes before
 * matching — otherwise the name never matches and nothing gets stripped.
 */
export function rejectedPropNames(e: any): string[] {
  const blob = `${String(e?.detail || '')} ${String(e?.message || '')}`.replace(/\\/g, '');
  const out = new Set<string>();
  const add = (re: RegExp) => { let m: RegExpExecArray | null; while ((m = re.exec(blob))) { const n = m[1] || m[2]; if (n) out.add(n); } };
  if (/PROPERTY_DOESNT_EXIST|does not exist/i.test(blob)) {
    add(/"([a-z0-9_]+)"\s*does not exist|Property\s+"?([a-z0-9_]+)"?\s+does not exist/gi);
  }
  if (/were not valid|INVALID_OPTION|not one of the allowed/i.test(blob)) {
    add(/"name"\s*:\s*"([a-z0-9_]+)"/gi);            // {"name":"review_decision",...}
    add(/Property\s+"?([a-z0-9_]+)"?\s+was not/gi);   // 'Property "review_decision" was not...'
    add(/\b([a-z0-9_]+)\s+was not one of the allowed/gi);
  }
  return [...out];
}
