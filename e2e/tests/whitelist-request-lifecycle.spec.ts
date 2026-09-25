import { test, expect } from '@playwright/test';
import { selectFirstMarket, testKmsArn, TEST_JUSTIFICATION } from './helpers';

// Full lifecycle of a real WHITELIST request against the live stack:
// create it, verify it lands Pending with the right supporting UI (idea
// #9 Agent Role ARN, idea #18 Policy Preview), then cancel it so this
// test doesn't leave an orphaned open PR/branch behind on every run
// (idea: Cancel Request before DEV merge). Single serial test so a
// failure partway through still attempts the cancel cleanup step.
test.describe.serial('Whitelist request: create, verify, cancel', () => {
  let requestId: string;
  const kmsArn = testKmsArn();

  test('create a whitelist request with one staged KMS key', async ({ page }) => {
    await page.goto('/requests/create');

    // Default mode is WHITELIST - Policy Preview must be visible (hidden
    // only for DEWHITELIST, see dewhitelist-mode.spec.ts).
    await expect(page.getByRole('button', { name: 'Preview Policy' })).toBeVisible();

    await selectFirstMarket(page, 'Market');
    await page.getByLabel('Business justification').fill(TEST_JUSTIFICATION);

    // DEV tab is the default active environment - stage the resource
    // there via the KMS Keys card's input, Enter to add (same as
    // clicking Add - see CreateRequestPage's onKeyDown handler).
    const kmsInput = page.getByPlaceholder('arn:aws:kms:region:account:key/id');
    await kmsInput.fill(kmsArn);
    await kmsInput.press('Enter');
    await expect(page.getByText(kmsArn)).toBeVisible();

    // Policy preview should now be enabled and reflect the staged
    // resource.
    await page.getByRole('button', { name: 'Preview Policy' }).click();
    await expect(page.getByText('Cross-Account Policy Preview')).toBeVisible();
    await expect(page.getByText(kmsArn)).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: 'Submit whitelist request' }).click();

    // Navigates to the new request's own details page ~1.2s after a
    // successful submit (see CreateRequestPage.submit's setTimeout).
    await page.waitForURL(/\/requests\/REQ-/, { timeout: 20_000 });
    requestId = page.url().split('/requests/')[1] ?? '';
    expect(requestId).toMatch(/^REQ-/);
  });

  test('request details shows Pending status, Agent Role ARN, and the staged resource', async ({ page }) => {
    test.skip(!requestId, 'Previous step did not produce a request id.');
    await page.goto(`/requests/${requestId}`);

    await expect(page.getByText('Pending', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Agent Role ARN')).toBeVisible();
    await expect(page.getByText(kmsArn)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel Request' })).toBeVisible();
  });

  test('cancel the request and confirm it reaches a terminal state', async ({ page }) => {
    test.skip(!requestId, 'Previous step did not produce a request id.');
    await page.goto(`/requests/${requestId}`);

    await page.getByRole('button', { name: 'Cancel Request' }).click();
    // Dialog title and the confirm button share the text "Cancel Request" -
    // scope to the dialog to click the right one.
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Cancel Request')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel Request' }).click();

    // CANCELLED collapses to the same "Completed" user-facing bucket as
    // any other terminal state (see getUserFacingStatus) - "nothing more
    // will happen here", not "it succeeded".
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    // The Cancel Request button itself should now be gone -
    // isRequestCancellable only allows this pre-merge.
    await expect(page.getByRole('button', { name: 'Cancel Request' })).toHaveCount(0);
  });
});
