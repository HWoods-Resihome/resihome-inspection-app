import { Html, Head, Main, NextScript } from 'next/document';

// Document-level <head>. The viewport meta lives in _app.tsx (once, globally).
export default function Document() {
  return (
    <Html lang="en">
      <Head />
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
