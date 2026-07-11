import { sanitizeNum, withCommas } from '@/lib/services/pricing';

/**
 * A compact money/percent field with the adornment ($ or %) INSIDE the box, a
 * centered value, and thousands separators. Shared by the New Service form and
 * the Rules Engine so both look identical. Value is a plain numeric string
 * (no commas); onChange receives the sanitized string.
 */
export function PriceField({
  label, value, onChange, adorn, side = 'left', highlight, readOnly, colClass = 'flex-1 min-w-0',
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  adorn: string;                 // '$' or '%'
  side?: 'left' | 'right';       // which side of the value the adornment sits
  highlight?: boolean;           // emerald styling (client cost)
  readOnly?: boolean;            // render the value as text (derived field)
  colClass?: string;             // outer column sizing ('flex-1' fills; 'shrink-0 w-24' fixed)
}) {
  const tone = highlight ? 'text-emerald-700' : 'text-gray-400';
  const box = `flex items-center gap-1 w-full border rounded-lg px-2.5 py-2 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-300 bg-white'} ${readOnly ? '' : 'focus-within:border-brand'}`;
  const val = `flex-1 min-w-0 text-sm text-center tabular-nums ${highlight ? 'text-emerald-700 font-bold' : 'text-ink'}`;
  return (
    <div className={`flex flex-col ${colClass}`}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5 text-center">{label}</label>
      <div className={box}>
        {side === 'left' && <span className={`text-sm ${tone}`}>{adorn}</span>}
        {readOnly ? (
          <span className={val}>{withCommas(value) || '0'}</span>
        ) : (
          <input value={withCommas(value)} inputMode="decimal" placeholder="0"
            onChange={(e) => onChange?.(sanitizeNum(e.target.value))}
            className={`${val} bg-transparent border-0 p-0 focus:outline-none`} />
        )}
        {side === 'right' && <span className={`text-sm ${tone}`}>{adorn}</span>}
      </div>
    </div>
  );
}
