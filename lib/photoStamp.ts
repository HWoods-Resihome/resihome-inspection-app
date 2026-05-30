/**
 * Burn a short line-item label onto a photo (bottom-right, mirroring the
 * capture-time evidence stamp that sits bottom-left).
 *
 * This is applied ONCE, at finalize (Scope) / submit (Reinspect), to photos that
 * the inspector tagged to a line. During editing, tagging stays non-destructive
 * (so it's untaggable); the burn happens only at the terminal step so the
 * vendor PDF (which shows section photos) carries the line label — no PDF
 * changes needed.
 *
 * The uploaded file is named `tagged_…` so re-finalize can detect an
 * already-stamped photo and skip it (idempotent).
 */
import { uploadPhoto } from '@/lib/photoUpload';
import { isVideoEntry, getPosterUrl, getVideoUrl, makeVideoEntry } from '@/lib/media';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

function drawLabel(ctx: CanvasRenderingContext2D, w: number, h: number, label: string) {
  const text = label.trim();
  if (!text) return;
  const pad = Math.round(w * 0.014);
  const fontSize = Math.max(16, Math.round(w / 54));
  ctx.save();
  ctx.font = `600 ${fontSize}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const metrics = ctx.measureText(text);
  const boxPadX = Math.round(fontSize * 0.5);
  const boxPadY = Math.round(fontSize * 0.34);
  const boxW = Math.min(w - pad * 2, metrics.width + boxPadX * 2);
  const boxH = fontSize + boxPadY * 2;
  const x = w - pad - boxW;
  const y = h - pad - boxH;
  const r = Math.round(boxH * 0.28);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + boxW, y, x + boxW, y + boxH, r);
  ctx.arcTo(x + boxW, y + boxH, x, y + boxH, r);
  ctx.arcTo(x, y + boxH, x, y, r);
  ctx.arcTo(x, y, x + boxW, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.rect(x + boxPadX, y, boxW - boxPadX * 2, boxH);
  ctx.clip();
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = Math.round(fontSize * 0.3);
  ctx.fillText(text, x + boxPadX, y + boxPadY + fontSize * 0.82);
  ctx.restore();
}

async function stampImageUrl(url: string, label: string): Promise<string> {
  const src = /^(blob:|data:)/.test(url) ? url : `/api/photo-proxy?url=${encodeURIComponent(url)}`;
  const img = await loadImage(src);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('bad image dimensions');
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(img, 0, 0, w, h);
  drawLabel(ctx, w, h, label);
  const blob: Blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/jpeg', 0.9)
  );
  const file = new File([blob], `tagged_${Date.now()}.jpg`, { type: 'image/jpeg' });
  return uploadPhoto(file);
}

/** True if an entry has already been label-stamped (so we don't double-stamp). */
export function isStamped(entry: string): boolean {
  return getPosterUrl(entry || '').includes('tagged_');
}

/**
 * Stamp `label` onto the photo (or a video's poster) and return the new entry.
 * Throws on failure — callers should catch and keep the original.
 */
export async function stampEntryWithLabel(entry: string, label: string): Promise<string> {
  if (isVideoEntry(entry)) {
    const newPoster = await stampImageUrl(getPosterUrl(entry), label);
    return makeVideoEntry(newPoster, getVideoUrl(entry));
  }
  return stampImageUrl(entry, label);
}
