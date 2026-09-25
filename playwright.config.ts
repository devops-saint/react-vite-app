import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The real, deployed portal to run against (your personal/test stack's
// frontend URL) - e.g. http://localhost:5173 for `npm run dev:personal`,
// or a deployed CloudFront/S3 URL if you host the built frontend
// somewhere. Never defaults to a production/org URL.
const baseURL = process.env['E2E_BASE_URL'] || 'http://localhost:5173';

// Where the one-time manual Azure AD login session is saved (see
// e2e/login.mjs and e2e/README.md). Never committed - see .gitignore.
export const AUTH_FILE = path.join(__dirname, 'e2e/.auth/user.json');

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: false,
  // These tests hit a real deployed backend and real per-market locking
  // (MARKETLOCK#<MARKET_CODE> - see lambda/handler.py), so two tests
  // racing to submit/cancel for the same market could interfere with each
  // other. Single worker, no retries: a retry after a partial real-world
  // side effect (a request half-submitted, a cancel half-applied) would
  // just compound the problem rather than fixing a flaky assertion.
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env['CI'],
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Fails fast with a clear message (instead of every test individually
  // failing at the login redirect) if the one-time manual login hasn't
  // been captured yet.
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL,
    storageState: AUTH_FILE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
