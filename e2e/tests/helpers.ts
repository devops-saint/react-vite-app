import type { Page } from '@playwright/test';

/** A KMS ARN is used as the test resource because it's the most
 * self-evidently fake/synthetic ARN shape to a human reviewing test
 * data (a resource type nobody stages a random one-off key for), passes
 * CreateRequestPage's own validation regex, and is easy to grep out of
 * DynamoDB later if ever needed. The account id is a well-known
 * "example" placeholder (never a real AWS account), and the key id is a
 * recognizable all-1s/2s UUID so it's obviously synthetic at a glance. */
export function testKmsArn(region = 'eu-west-1'): string {
  const suffix = Date.now().toString(16).padStart(12, '0').slice(-12);
  return `arn:aws:kms:${region}:111111111111:key/aaaaaaaa-bbbb-cccc-dddd-${suffix}`;
}

export const TEST_JUSTIFICATION =
  'Automated Playwright E2E test run - created and cancelled automatically, safe to ignore.';

/** Opens the Market select on Create Request / Current Whitelist and
 * picks whichever market happens to be first in the list, rather than
 * hardcoding a market code this suite can't know ahead of time (markets
 * are environment-configured via VITE_AVAILABLE_MARKETS and differ
 * between the org and personal/test stacks). Returns the market code it
 * picked. */
export async function selectFirstMarket(page: Page, selectLabel: string | RegExp): Promise<string> {
  const select = page.getByLabel(selectLabel);
  await select.click();
  const firstOption = page.getByRole('option').first();
  const code = (await firstOption.innerText()).trim();
  await firstOption.click();
  return code;
}
