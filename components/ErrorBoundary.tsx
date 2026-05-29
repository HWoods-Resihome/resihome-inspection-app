import React from 'react';

interface State {
  hasError: boolean;
  message: string;
}

/**
 * Catches render-time errors anywhere in the tree and shows a friendly
 * recovery screen instead of a white screen. Wraps the whole app in _app.tsx.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message || 'Something went wrong' };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log for diagnostics; in production this surfaces in the browser console
    // and (if wired) any error reporting.
    console.error('[ErrorBoundary] caught:', error, info?.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, message: '' });
    if (typeof window !== 'undefined') window.location.reload();
  };

  handleHome = () => {
    if (typeof window !== 'undefined') window.location.href = '/';
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-gray-50 text-center">
        <div className="max-w-md">
          <h1 className="text-xl font-bold text-gray-900 mb-2">Something went wrong</h1>
          <p className="text-sm text-gray-600 mb-6">
            The page hit an unexpected error. Your saved work is not affected — try reloading.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={this.handleReload}
              className="px-5 py-2 text-sm bg-brand text-white font-semibold rounded-lg hover:bg-brand-dark"
            >
              Reload
            </button>
            <button
              onClick={this.handleHome}
              className="px-5 py-2 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100"
            >
              Go to Home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
