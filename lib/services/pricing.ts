/**
 * Shared pricing helpers for the Services surface (New Service form + Rules
 * Engine). Values are kept as plain numeric STRINGS (no commas) so they can be
 * typed/cleared freely and parsed for math; commas are added only for display.
 */

// Keep digits + one dot + up to 2 decimals as the user types (strips commas, $, %).
export const sanitizeNum = (v: string): string => {
  const parts = v.replace(/[^\d.]/g, '').split('.');
  const int = parts.shift() ?? '';
  return parts.length ? `${int}.${parts.join('').slice(0, 2)}` : int;
};

// Thousands separators for display, preserving any decimal part / trailing dot.
export const withCommas = (v: string): string => {
  if (v === '') return '';
  const [int, dec] = v.split('.');
  const intFmt = (int || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec !== undefined ? `${intFmt}.${dec}` : intFmt;
};

// Client cost = vendor cost × (1 + markup%). Blank vendor cost → blank.
export const clientFrom = (vc: string, mk: string): string =>
  vc === '' ? '' : (parseFloat(vc || '0') * (1 + parseFloat(mk || '0') / 100)).toFixed(2);
