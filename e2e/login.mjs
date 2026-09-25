// One-time (or occasional, whenever the saved session expires) manual
// login capture for the E2E suite. The portal only supports real Azure AD
// (MSAL) login - there is no test bypass in the app - so this opens a
// real, visible browser, lets you sign in exactly as you normally would
// (including any MFA prompt), and then saves that logged-in session to
// disk so every subsequent `npm run e2e` run can reuse it without
// re-authenticating.
//
// Run with: npm run e2e:login
// Re-run whenever `npm run e2e` starts failing at the login screen again
// (the saved session/token has expired).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const authDir = path.join(__dirname, '.auth');
const authFile = path.join(authDir, 'user.json');
const loginPath = process.env.E2E_LOGIN_PATH || '/login';

const FIVE_MINUTES = 5 * 60 * 1000;

async function main() {
  fs.mkdirSync(authDir, { recursive: true });

  console.log(`\nOpening ${baseURL}${loginPath} in a real browser window...`);
  console.log('Sign in with your Microsoft account as you normally would.');
  console.log(`Waiting up to ${FIVE_MINUTES / 60000} minutes for you to finish...\n`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${baseURL}${loginPath}`);

  // Once signed in, LoginPage's own useEffect redirects away from /login
  // (see src/pages/LoginPage.tsx) - waiting for that is more robust than
  // guessing the exact dashboard path, which is configurable via
  // VITE_ROUTE_DASHBOARD.
  await page.waitForURL((url) => !url.pathname.includes('login'), {
    timeout: FIVE_MINUTES,
  });

  // Give the app a moment to finish its own post-login state settling
  // (AuthProvider mapping the MSAL account, initial data fetches) before
  // snapshotting storage - avoids saving a state mid-transition.
  await page.waitForTimeout(2000);

  await context.storageState({ path: authFile });
  await browser.close();

  console.log(`\nLogin session saved to ${authFile}.`);
  console.log('You can now run: npm run e2e\n');
}

main().catch((error) => {
  console.error('\nLogin capture failed or timed out:', error.message || error);
  console.error('Run "npm run e2e:login" again to retry.\n');
  process.exit(1);
});
