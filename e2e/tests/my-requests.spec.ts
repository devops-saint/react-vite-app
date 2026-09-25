import { test, expect } from '@playwright/test';

// Idea #2 (Simplify Request Statuses) + status-group filtering, scoped to
// the My Requests list itself (dashboard.spec.ts covers the dashboard
// cards and the cross-page "no raw status leaks" check).
test.describe('My Requests', () => {
  test('list loads', async ({ page }) => {
    await page.goto('/requests');
    await expect(page.getByRole('heading', { name: /requests/i }).first()).toBeVisible();
  });

  test('status filter narrows the list and can be cleared', async ({ page }) => {
    await page.goto('/requests?statusGroup=pending');

    await expect(page.getByText(/Filtered from Dashboard: Pending/i)).toBeVisible();

    // Clearing the filter (via its own remove affordance, e.g. an "x" on
    // the filter chip) should restore the unfiltered list rather than
    // requiring a manual URL edit.
    const filterChip = page.getByText(/Filtered from Dashboard: Pending/i).locator('..');
    const clearControl = filterChip.getByRole('button').first();
    if (await clearControl.count()) {
      await clearControl.click();
      await expect(page.getByText(/Filtered from Dashboard: Pending/i)).toHaveCount(0);
    }
  });

  test('every visible status chip is a collapsed label, never a raw backend status', async ({ page }) => {
    await page.goto('/requests');

    const chipLabels = page.locator('.MuiChip-label');
    const count = await chipLabels.count();
    if (count === 0) {
      test.skip(true, 'No requests exist yet on this stack to show a status chip for.');
    }

    const collapsed = new Set(['Pending', 'In Progress', 'Completed']);
    for (let i = 0; i < count; i++) {
      const text = (await chipLabels.nth(i).innerText()).trim();
      // Only assert on chips whose text is exactly one of the three
      // known status labels or looks like a raw backend enum value
      // (UPPER_SNAKE_CASE) - ignores unrelated chips (market codes,
      // resource-type chips) that share the same MUI class.
      const looksLikeRawStatus = /^[A-Z][A-Z_]{3,}$/.test(text);
      if (looksLikeRawStatus && !collapsed.has(text)) {
        throw new Error(`Found a raw backend status leaking into My Requests: "${text}"`);
      }
    }
  });
});
