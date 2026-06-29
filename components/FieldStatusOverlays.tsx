import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAppUpdate } from '@/lib/useAppUpdate';
import { SESSION_EXPIRED_EVENT } from '@/lib/sessionGuard';

/**
 * App-wide field-reliability overlays, mounted once in _app:
 *   - A slim banner when a newer build has been deployed (one-tap reload).
 *   - A modal when the session has expired, reassuring the inspector that
 *     queued work is safe and prompting a re-login.
 */
export function FieldStatusOverlays() {
  const router = useRouter();
  const { updateReady, reload } = useAppUpdate();
  const [sessionExpired, setSessionExpired] = useState(false);
  // On the login screen the "session expired" prompt is meaningless and traps
  // the user (it covers the sign-in form, and "Sign in again" just reloads
  // /login where the guard re-fires). Suppress it there.
  const onLoginPage = router.pathname === '/login';

  useEffect(() => {
    const onExpired = () => setSessionExpired(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  // AUTO-APPLY a pending update while on the HOME screen — a safe reload point
  // (no open form). ONLINE-ONLY: applying unregisters the SW + clears caches +
  // reloads, which offline would blank the app (no shell to serve). Re-check
  // online at fire time AND fire only on the online event, so a device that went
  // offline mid-inspection and returned home never auto-reloads into a blank
  // page. Other routes show the manual banner. reload() also self-guards offline.
  useEffect(() => {
    if (!(updateReady && router.pathname === '/' && !sessionExpired)) return;
    const tryApply = () => { if (typeof navigator === 'undefined' || navigator.onLine !== false) reload(); };
    const t = setTimeout(tryApply, 1200);
    window.addEventListener('online', tryApply);
    return () => { clearTimeout(t); window.removeEventListener('online', tryApply); };
  }, [updateReady, router.pathname, sessionExpired, reload]);

  return (
    <>
      {updateReady && !sessionExpired && (
        <div className="fixed top-0 inset-x-0 z-[60] bg-brand text-white text-sm px-4 py-2 flex items-center justify-center gap-3 shadow">
          <span className="font-heading font-semibold">A new version of ResiWalk is available.</span>
          <button
            type="button"
            onClick={reload}
            className="px-3 py-1 rounded-md bg-white text-brand font-semibold text-xs hover:bg-gray-100"
          >
            Reload
          </button>
        </div>
      )}

      {sessionExpired && !onLoginPage && (
        <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-6">
          <div className="max-w-sm w-full bg-white rounded-xl shadow-xl p-6 text-center">
            <h2 className="text-lg font-heading font-bold text-gray-900 mb-2">Your session expired</h2>
            <p className="text-sm text-gray-600 mb-5">
              Any changes you’ve made are safely saved on this device and will sync once you sign back in. Sign in again to keep working.
            </p>
            <button
              type="button"
              onClick={() => { window.location.href = '/login'; }}
              className="w-full px-5 py-2.5 text-sm bg-brand text-white font-semibold rounded-lg hover:bg-brand-dark"
            >
              Sign in again
            </button>
          </div>
        </div>
      )}
    </>
  );
}
