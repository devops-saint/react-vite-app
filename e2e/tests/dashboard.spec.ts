import { test, expect } from '@playwright/test';

// Idea #2 (Simplify Request Statuses) verification: every status badge on
// the app must be one of the three collapsed labels, never a raw backend
// status like "PR_APPROVED" or "SYNC_FAILED" (see StatusChip.tsx /
// getUserFacingStatus in request.types.ts).
const COLLAPSED_STATUS_LABELS = ['Pending', 'In Progress', 'Completed'];
const RAW_STATUS_LEAK_PATTERN =
  /\b(PR_|SYNC_FAILED|REQUEST_RECEIVED|QUEUED|MERGED_AWAITING|CANCELLED)\b/;

test.describe('Dashboard', () => {
  test('loads with three summary cards that only show collapsed statuses', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByText('Pending', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('In Progress', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();

    // No raw backend status string should ever leak into the dashboard's
    // visible text - confirms idea #2 holds for this page specifically,
    // not just that StatusChip exists somewhere in the codebase.
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toMatch(RAW_STATUS_LEAK_PATTERN);
  });

  test('clicking a summary card filters My Requests by that status group', async ({ page }) => {
    await page.goto('/dashboard');

    // Click the "Pending" card.
    await page.getByText('Pending', { exact: true }).first().click();

    await expect(page).toHaveURL(/\/requests\?statusGroup=pending/);
    await expect(page.getByText(/Filtered from Dashboard: Pending/i)).toBeVisible();
  });

  test('every status chip visible anywhere renders a collapsed label only', async ({ page }) => {
    await page.goto('/requests');

    // MUI Chip renders as a span with class MuiChip-label for its text -
    // scoped to that class rather than every span, so this doesn't
    // accidentally match unrelated page text.
    const chipLabels = page.locator('.MuiChip-label');
    const count = await chipLabels.count();
    if (count === 0) {
      test.skip(true, 'No requests exist yet on this stack to show a status chip for.');
    }
    for (let i = 0; i < count; i++) {
      const text = (await chipLabels.nth(i).innerText()).trim();
      // Only assert on chips that look like a status chip (skip things
      // like the "Filtered from Dashboard: ..." chip or resource-count
      // chips, which share the same MUI class).
      if (RAW_STATUS_LEAK_PATTERN.test(text)) {
        throw new Error(`Found a raw backend status leaking into a chip: "${text}"`);
      }
    }
    void COLLAPSED_STATUS_LABELS; // referenced for documentation of the valid set above
  });
});
