import { defineConfig } from 'vitest/config';
import path from 'path';

// Eval suites run against LIVE services (Voyage + HubSpot) and are a quality
// GATE, not a unit test — kept out of the default `npm test` (see
// vitest.config.ts include) and run explicitly via `npm run eval`. They skip
// gracefully when the required keys are absent.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  test: { environment: 'node', include: ['tests/eval/**/*.eval.ts'] },
});
