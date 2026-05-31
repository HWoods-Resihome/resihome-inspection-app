import { useEffect, useState } from 'react';
import { useAppUpdate } from '@/lib/useAppUpdate';
import { SESSION_EXPIRED_EVENT } from '@/lib/sessionGuard';

/**
 * App-wide field-reliability overlays, mounted once in _app:
 *   - A slim banner when a newer build has been deployed (one-tap reload).
 *   - A modal when the session has expired, reassuring the inspector that
 *     queued work is safe and prompting a re-login.
 */
export function FieldStatusOverlays() {
  const { updateReady, reload } = useAppUpdate();
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    const onExpired = () => setSessionExpired(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

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

      {sessionExpired && (
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
