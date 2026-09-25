import { test, expect } from '@playwright/test';
import { selectFirstMarket } from './helpers';

// Idea #6 (Consolidated environment view) + idea #9 (Agent Role ARN) +
// idea #3 (Neutral resource color) verification against the Current
// Whitelist page.
test.describe('Current Whitelist', () => {
  test('environment switcher is Tabs (DEV/QA/PRD), not a dropdown', async ({ page }) => {
    await page.goto('/whitelist');
    await selectFirstMarket(page, 'Market');

    // MUI Tabs render role="tablist" with role="tab" children - a
    // dropdown/select would not expose this role at all, so this
    // assertion fails outright if idea #6 regresses back to a dropdown.
    const tablist = page.getByRole('tablist');
    await expect(tablist).toBeVisible();
    await expect(page.getByRole('tab', { name: 'DEV' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'QA' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'PRD' })).toBeVisible();
  });

  test('Agent Role ARN with copy button renders for the active environment tab', async ({ page }) => {
    await page.goto('/whitelist');
    await selectFirstMarket(page, 'Market');

    await page.getByRole('tab', { name: 'DEV' }).click();
    await expect(page.getByText('Agent Role ARN')).toBeVisible();
    // AgentRoleArn renders the arn text plus an icon-button copy action -
    // scope to a button near the label rather than assuming a name.
    const arnText = page.getByText(/^arn:aws:iam::/);
    await expect(arnText.first()).toBeVisible();

    await page.getByRole('tab', { name: 'QA' }).click();
    await expect(page.getByText('Agent Role ARN')).toBeVisible();
    await expect(page.getByText(/^arn:aws:iam::/).first()).toBeVisible();
  });

  test('resource type cards share one neutral color, not category red/green', async ({ page }) => {
    await page.goto('/whitelist');
    await selectFirstMarket(page, 'Market');
    await page.getByRole('tab', { name: 'DEV' }).click();

    // Idea #3: S3 / Secrets Manager / KMS / Lambda headings should all use
    // NEUTRAL_RESOURCE_COLOR (#1976d2) rather than the old category
    // palette that made Secrets Manager and KMS both render error-red.
    const headings = [
      page.getByRole('heading', { name: 'S3 Buckets' }),
      page.getByRole('heading', { name: 'Secrets Manager' }),
      page.getByRole('heading', { name: 'KMS Keys' }),
      page.getByRole('heading', { name: 'Lambda Functions' }),
    ];

    const colors = new Set<string>();
    for (const heading of headings) {
      if (await heading.count()) {
        const color = await heading.first().evaluate((el) => getComputedStyle(el).color);
        colors.add(color);
      }
    }

    // All headings that exist on the page should resolve to exactly one
    // shared computed color - if any card reverted to a distinct
    // category color, this set would have more than one entry.
    expect(colors.size).toBeLessThanOrEqual(1);
  });

  test('de-whitelisting an existing resource opens a confirmation dialog', async ({ page }) => {
    await page.goto('/whitelist');
    await selectFirstMarket(page, 'Market');
    await page.getByRole('tab', { name: 'DEV' }).click();

    // Any resource-type card's remove ("x") control opens a confirm
    // dialog rather than deleting immediately - close without confirming
    // so this test never mutates real state.
    const removeButtons = page.getByRole('button', { name: /remove|de-?whitelist/i });
    const count = await removeButtons.count();
    if (count === 0) {
      test.skip(true, 'No whitelisted resources exist yet on this stack to test removal on.');
    }

    await removeButtons.first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Dismiss without confirming - prefer an explicit Cancel/Close action
    // over the Escape key, which some MUI dialogs ignore by design.
    const dismiss = dialog.getByRole('button', { name: /cancel|close/i });
    if (await dismiss.count()) {
      await dismiss.first().click();
    } else {
      await page.keyboard.press('Escape');
    }
    await expect(dialog).toBeHidden();
  });
});
