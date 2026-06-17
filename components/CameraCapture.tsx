import { CameraCaptureModern } from '@/components/CameraCaptureModern';
import { CameraCaptureLegacy } from '@/components/CameraCaptureLegacy';

/**
 * Camera entry point — picks the right implementation per platform so each one
 * uses the version that's PROVEN to work there:
 *
 *  • iOS / iPadOS (WebKit) → CameraCaptureLegacy: the last-known-good 6/13
 *    build (commit 026c935). Simple rapid-digital live-frame capture, pure
 *    digital zoom, NO device-camera/ImageCapture, NO freeze-frame, NO lens
 *    switching, NO re-acquire machinery — the setup iPhone users confirmed
 *    worked reliably, before the overhaul + recovery patching regressed it.
 *
 *  • Everything else (Android, desktop Chrome/Edge/Firefox) → CameraCaptureModern:
 *    the newer build that those platforms were happy with — full-resolution
 *    ImageCapture stills (sharp photos + crisp burned-in timestamps), the manual
 *    lens selector, etc. Reverting that to 6/13 needlessly downgraded a camera
 *    that wasn't broken there.
 *
 * Both implementations share the exact same Props, so this just forwards them.
 * AI assist defaults OFF in both.
 */

// iOS/iPadOS WebKit (incl. Chrome on iOS, which is WebKit under the hood). iPadOS
// reports as "Macintosh" but exposes multi-touch, so detect that too.
const IS_IOS = typeof navigator !== 'undefined'
  && (/iP(hone|ad|od)/i.test(navigator.userAgent || '')
    || (/Macintosh/.test(navigator.userAgent || '') && ((navigator as any).maxTouchPoints || 0) > 1));

export function CameraCapture(props: React.ComponentProps<typeof CameraCaptureModern>) {
  return IS_IOS
    ? <CameraCaptureLegacy {...props} />
    : <CameraCaptureModern {...props} />;
}
