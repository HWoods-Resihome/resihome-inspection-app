import { useEffect, useState } from 'react';
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
  // Default to lazy + async decoding so off-screen tiles in long photo grids
  // don't all decode their bitmaps up front (and can be reclaimed under memory
  // pressure) — the iOS WebKit OOM that jettisons the renderer ("a problem
  // repeatedly occurred" + white screen) on photo-heavy inspections.
  url, width = 400, alt = '', className, style, title, loading = 'lazy', decoding = 'async', onClick,
}: PhotoThumbProps) {
  const [stage, setStage] = useState(0);
  const [loaded, setLoaded] = useState(false);
  // Reset the fallback chain if this slot is reused for a different photo (e.g.
  // the offline draft url swapped for the real HubSpot url after it syncs).
  const [seenUrl, setSeenUrl] = useState(url);
  if (url !== seenUrl) { setSeenUrl(url); setStage(0); setLoaded(false); }

  const src = stage >= 2 ? '' : (stage === 0 ? thumbImageSrc(url, width) : displayImageSrc(url));

  // Self-heal a STALL: the proxied thumbnail resize (sharp) can hang on a cold
  // instance / large original, and a bare <img> that never fires load OR error
  // leaves a permanent grey box. If the current source hasn't loaded within a few
  // seconds, advance the fallback chain (proxy → direct url) so a real pixel
  // arrives instead of staying stuck.
  useEffect(() => {
    if (loaded || stage >= 2 || !src) return;
    const t = setTimeout(() => setStage((s) => s + 1), stage === 0 ? 4000 : 8000);
    return () => clearTimeout(t);
  }, [src, stage, loaded]);
  // The wrapper IS the tile (carries the caller's size/border/rounded classes)
  // and shows a neutral fill. The <img> sits on top but stays INVISIBLE until it
  // actually loads — so a still-loading OR failed source never paints the
  // browser's broken-image "?" glyph; you just see the blank box until a real
  // pixel arrives. On error we advance to the next source (and reset visibility).
  return (
    <span
      aria-hidden
      className={className}
      onClick={onClick}
      style={{ ...style, backgroundColor: '#f3f4f6', display: 'inline-block', overflow: 'hidden', position: 'relative' }}
    >
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          title={title}
          loading={loading}
          decoding={decoding}
          onLoad={() => setLoaded(true)}
          onError={() => { setLoaded(false); setStage((s) => s + 1); }}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', opacity: loaded ? 1 : 0, transition: 'opacity 120ms' }}
        />
      )}
    </span>
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
