import { useState } from 'react';
import { thumbImageSrc, displayImageSrc } from '@/lib/photoDisplay';

/**
 * A small photo tile that SELF-HEALS a failed thumbnail instead of leaving the
 * browser's broken-image glyph on screen (the "blue question mark" iOS shows).
 *
 * Why this exists: grid/strip thumbnails are served small through
 * /api/photo-proxy (?w=) to keep iOS WebKit from OOM-decoding dozens of full-res
 * images. But a freshly-synced HubSpot photo can momentarily fail that proxied
 * fetch (CDN propagation right after upload, a transient 5xx, a sharp decode
 * miss) — and with a bare <img> that leaves a PERMANENT broken tile even though
 * the photo is fine (tapping it opens the full-size viewer, which loads the
 * direct URL). This was the iOS "thumbnail shows a ? but the photo opens" bug.
 *
 * Fallback chain on error:
 *   0) proxied small thumbnail (thumbImageSrc)
 *   1) the direct/full-size url (displayImageSrc) — same source the working
 *      lightbox uses, so if the photo opens, this renders
 *   2) give up and show a neutral placeholder box (no broken glyph, no layout jump)
 *
 * Drop-in for `<img src={thumbImageSrc(url)} … />` in the inspection photo grids.
 */
interface PhotoThumbProps {
  url: string;
  /** Proxy thumbnail width (px). Matches thumbImageSrc's default. */
  width?: number;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  loading?: 'lazy' | 'eager';
  decoding?: 'async' | 'sync' | 'auto';
  onClick?: () => void;
}

export function PhotoThumb({
  url, width = 400, alt = '', className, style, title, loading, decoding, onClick,
}: PhotoThumbProps) {
  const [stage, setStage] = useState(0);
  // Reset the fallback chain if this slot is reused for a different photo (e.g.
  // the offline draft url swapped for the real HubSpot url after it syncs).
  const [seenUrl, setSeenUrl] = useState(url);
  if (url !== seenUrl) { setSeenUrl(url); setStage(0); }

  if (stage >= 2) {
    // Exhausted both sources — keep the tile's box (no layout shift) but show a
    // neutral placeholder rather than the broken-image glyph.
    return <span aria-hidden className={className} style={{ ...style, backgroundColor: '#f3f4f6', display: 'inline-block' }} onClick={onClick} />;
  }

  const src = stage === 0 ? thumbImageSrc(url, width) : displayImageSrc(url);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      title={title}
      loading={loading}
      decoding={decoding}
      onClick={onClick}
      onError={() => setStage((s) => s + 1)}
      className={className}
      style={style}
    />
  );
}

/**
 * Self-healing tile driven by EXPLICIT primary/fallback urls (not the
 * thumbImageSrc/displayImageSrc derivation PhotoThumb does). Used by the
 * in-camera capture strip, whose primary is sometimes a local data-URL thumb
 * (always renders) and sometimes a proxied server thumbnail (can transiently
 * fail right after sync). On the primary failing it tries the fallback (the full
 * image), then a neutral box — never the broken-image glyph.
 */
export function SelfHealingImg({
  primary, fallback, alt = '', className, style, title, decoding, onClick,
}: {
  primary: string;
  fallback?: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  decoding?: 'async' | 'sync' | 'auto';
  onClick?: () => void;
}) {
  const [stage, setStage] = useState(0);
  const [seen, setSeen] = useState(primary);
  if (primary !== seen) { setSeen(primary); setStage(0); }

  const src = stage === 0 ? primary : fallback;
  if (!src || stage >= 2) {
    return <span aria-hidden className={className} style={{ ...style, backgroundColor: '#1f2937', display: 'inline-block' }} onClick={onClick} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      title={title}
      decoding={decoding}
      onClick={onClick}
      onError={() => setStage((s) => s + 1)}
      className={className}
      style={style}
    />
  );
}
