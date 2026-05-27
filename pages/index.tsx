import Link from 'next/link';
import Head from 'next/head';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

interface MeUser { userId: string; email: string; name: string; }

export default function Home() {
  const router = useRouter();
  const [hasLogo, setHasLogo] = useState(false);
  const [me, setMe] = useState<MeUser | null>(null);

  useEffect(() => {
    const img = new window.Image();
    img.onload = () => setHasLogo(true);
    img.onerror = () => setHasLogo(false);
    img.src = '/logo.png';
  }, []);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) setMe(data.user);
      })
      .catch(() => {});
  }, []);

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    router.replace('/login');
  }

  return (
    <>
      <Head>
        <title>ResiHome Inspection</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </Head>
      <main className="min-h-screen flex flex-col items-center justify-center p-6 bg-white">
        <div className="w-full max-w-md">
          {/* Top-right user info */}
          {me && (
            <div className="flex items-center justify-end gap-3 mb-4 text-sm">
              <div className="text-right">
                <div className="font-heading font-semibold text-ink">{me.name}</div>
                <div className="text-xs text-gray-500">{me.email}</div>
              </div>
              <button
                onClick={handleLogout}
                className="text-xs text-gray-500 hover:text-brand font-heading uppercase tracking-wider"
              >
                Sign out
              </button>
            </div>
          )}

          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            {hasLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src="/logo.png"
                alt="ResiHome"
                className="h-24 w-24 object-contain rounded-2xl mb-4 shadow-lg"
              />
            ) : (
              <div className="h-24 w-24 mb-4 flex items-center justify-center bg-brand text-white rounded-2xl text-3xl font-heading font-extrabold">
                RH
              </div>
            )}
            <h1 className="text-3xl font-heading font-extrabold text-ink tracking-tight">
              RESI<span className="text-brand">HOME</span>
            </h1>
            <p className="text-sm text-gray-500 mt-1 font-heading uppercase tracking-widest">
              Field Inspections
            </p>
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
            <h2 className="text-lg font-heading font-bold mb-2">Start a new inspection</h2>
            <p className="text-sm text-gray-600 mb-6">
              Pick a template and property to begin. Your progress is saved as you go.
            </p>
            <Link
              href="/inspection/new"
              className="block w-full text-center bg-brand hover:bg-brand-dark text-white font-heading font-semibold py-3.5 px-4 rounded-lg transition active:scale-[0.98]"
            >
              Start New Inspection
            </Link>
          </div>

          <p className="text-xs text-gray-400 text-center mt-6">
            Sandbox build &middot; ResiTest Portal 51415639
          </p>
        </div>
      </main>
    </>
  );
}
