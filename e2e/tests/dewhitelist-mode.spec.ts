import { test, expect } from '@playwright/test';
import { selectFirstMarket, TEST_JUSTIFICATION } from './helpers';

test.describe('Create Request: De-whitelist mode', () => {
  test('switching to De-whitelist mode hides Policy Preview and updates copy/labels', async ({ page }) => {
    await page.goto('/requests/create');

    await page.getByRole('button', { name: 'De-whitelist resources' }).click();

    // Idea: "the preview policy is not required for de-whitelisting
    // requests" - must not render at all in this mode, not merely be
    // disabled (see RequestDetailsPage/CreateRequestPage's
    // requestType/requestMode !== 'DEWHITELIST' gating).
    await expect(page.getByRole('button', { name: 'Preview Policy' })).toHaveCount(0);

    await expect(
      page.getByRole('button', { name: 'Submit de-whitelist request' })
    ).toBeVisible();

    await selectFirstMarket(page, 'Market');

    // With no market-specific data loaded yet for a resource type, the
    // helper text should explain there's either nothing to remove yet or
    // prompt picking one - never the WHITELIST-mode copy.
    await expect(
      page.getByText(/Nothing whitelisted in Development for this market yet\.|Pick one currently whitelisted in Development to remove it\./)
    ).toBeVisible();

    // Switching back to WHITELIST should bring Preview Policy back and
    // clear whatever was staged in DEWHITELIST mode (mode switch resets
    // staged resources - see CreateRequestPage's ToggleButtonGroup
    // onChange).
    await page.getByRole('button', { name: 'Whitelist resources' }).click();
    await expect(page.getByRole('button', { name: 'Preview Policy' })).toBeVisible();
  });

  test('de-whitelisting an existing resource: full create-and-cancel cycle', async ({ page }) => {
    // This only runs meaningfully if the selected market already has at
    // least one live KMS key in DEV to pick from (Current Whitelist is a
    // live read of the source-controlled values.dev.yaml - nothing gets
    // whitelisted there just by this suite running, since every WHITELIST
    // request this suite creates is cancelled pre-merge). Skips cleanly
    // with a clear reason on a stack where nothing has ever been merged.
    await page.goto('/whitelist');
    const marketCode = await selectFirstMarket(page, 'Market');
    await page.getByRole('tab', { name: 'DEV' }).click();

    const kmsHeading = page.getByRole('heading', { name: 'KMS Keys' });
    const kmsCard = kmsHeading.locator('xpath=ancestor::*[contains(@class,"MuiPaper-root")][1]');
    const existingEntries = kmsCard.locator('[title], p').filter({ hasText: /^arn:aws:kms:/ });

    if ((await existingEntries.count()) === 0) {
      test.skip(true, `No existing KMS key whitelisted in DEV for market ${marketCode} - nothing to de-whitelist yet on this stack.`);
    }

    const resourceValue = (await existingEntries.first().innerText()).trim();

    await page.goto('/requests/create');
    await page.getByRole('button', { name: 'De-whitelist resources' }).click();
    await selectFirstMarket(page, 'Market');
    await page.getByLabel('Business justification').fill(TEST_JUSTIFICATION);

    const autocomplete = page.getByRole('combobox').first();
    await autocomplete.fill(resourceValue);
    await page.getByRole('option', { name: resourceValue }).click();
    await expect(page.getByText(resourceValue)).toBeVisible();

    await page.getByRole('button', { name: 'Submit de-whitelist request' }).click();
    await page.waitForURL(/\/requests\/REQ-/, { timeout: 20_000 });
    const requestId = page.url().split('/requests/')[1] ?? '';
    expect(requestId).toMatch(/^REQ-/);

    // Cleanup: cancel it so this doesn't leave a real open PR behind.
    await page.getByRole('button', { name: 'Cancel Request' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Cancel Request' }).click();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  });
});
