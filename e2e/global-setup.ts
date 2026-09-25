import fs from 'node:fs';
import { AUTH_FILE } from '../playwright.config';

/**
 * Runs once before the whole test run. The portal only supports real
 * Azure AD (MSAL) login - there's no test bypass in the app - so instead
 * of every spec failing individually at the login redirect with a
 * confusing timeout, this fails the whole run up front with one clear
 * instruction if the one-time manual login session hasn't been captured
 * yet (see e2e/login.mjs / `npm run e2e:login`).
 */
export default function globalSetup(): void {
  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error(
      `\n\nNo saved login session found at ${AUTH_FILE}.\n` +
        `Run "npm run e2e:login" first - it opens a real browser, you sign in\n` +
        `with your Microsoft account by hand (this only needs to be done once,\n` +
        `and again whenever the session eventually expires), and it saves that\n` +
        `session for every test run after that.\n`
    );
  }
}
