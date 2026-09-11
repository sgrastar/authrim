import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// UI-only dev mock supplies the admin session. All group responses are local deterministic fixtures.
test('edits conditions and group references, previews and explains membership', async ({
  page,
}) => {
  const groups = [
    {
      id: 'verified',
      tenantId: 'default',
      key: 'verified',
      displayName: 'Verified email',
      description: '',
      enabled: true,
      condition: null,
    },
  ];
  let saved: Record<string, unknown> | null = null;
  const catalog = () => ({
    revision: saved ? 2 : 1,
    groups: saved ? [...groups, saved] : groups,
    dependencies: {},
    fields: {
      country: { type: 'string', normalize: 'country' },
      email_domain: { type: 'string', normalize: 'domain' },
    },
    scans: [],
  });
  await page.route('**/api/admin/service-groups**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/validate')) {
      const body = request.postDataJSON();
      expect(body.condition).toEqual({
        op: 'all',
        args: [
          { op: 'attribute', field: 'country', compare: 'in', value: ['JP', 'US'] },
          { op: 'member', groupId: 'verified' },
        ],
      });
      return route.fulfill({
        json: {
          valid: true,
          evaluation: {
            groups: { japan: { member: true, dynamic: true, sources: ['dynamic'] } },
            nodes: {},
            evaluatedNodes: 1,
          },
        },
      });
    }
    if (path.endsWith('/subjects/user-a'))
      return route.fulfill({
        json: {
          tenantId: 'default',
          userId: 'user-a',
          freshness: 'fresh',
          ruleVersion: 2,
          generation: 1,
          inputVersion: { core: 1, pii: 1, metadata: 1, epoch: 1 },
          evaluation: {
            groups: { japan: { member: true, dynamic: true, sources: ['dynamic', 'manual'] } },
            nodes: {},
          },
          explanation: [
            {
              node: 'n0',
              operator: 'attribute',
              field: 'country',
              compare: 'eq',
              expected: 'JP',
              result: true,
            },
          ],
          error: null,
        },
      });
    if (request.method() === 'POST') {
      saved = { ...request.postDataJSON(), id: 'japan', tenantId: 'default' };
      return route.fulfill({ json: catalog() });
    }
    return route.fulfill({ json: catalog() });
  });
  await page.goto(
    `${process.env.ADMIN_UI_TEST_ORIGIN ?? 'http://127.0.0.1:4175'}/admin/service-groups`
  );
  await expect(page.getByRole('heading', { name: 'Service groups', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Verified email verified', exact: true })
  ).toBeVisible();
  await page.getByLabel('Identifier', { exact: true }).fill('japan');
  await page.getByLabel('Display name', { exact: true }).fill('Japan customers');
  await page
    .getByRole('combobox', { name: 'Membership condition', exact: true })
    .first()
    .selectOption('all');
  // Switching AND/OR preserves the same children instead of wrapping another layer.
  const operators = page.getByRole('combobox', { name: 'Membership condition', exact: true });
  await expect(operators).toHaveCount(2);
  await operators.first().selectOption('any');
  await expect(operators).toHaveCount(2);
  await operators.first().selectOption('all');
  await page.getByRole('button', { name: 'Add condition', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Membership condition', exact: true })
    .last()
    .selectOption('member');
  await page.getByRole('combobox', { name: 'Group', exact: true }).selectOption('verified');
  await page.getByRole('combobox', { name: 'Comparison', exact: true }).selectOption('in');
  await page.getByRole('textbox', { name: 'Value', exact: true }).fill('JP\nUS');
  await page.getByRole('button', { name: 'Validate / preview', exact: true }).click();
  await expect(page.getByText('Valid', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Japan customers japan' })).toBeVisible();
  await expect(page.getByText(/could not be cloned/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Verified email verified' }).click();
  await page.getByRole('button', { name: 'Japan customers japan' }).click();
  await expect(page.getByRole('combobox', { name: 'Group', exact: true })).toHaveValue('verified');
  await page.getByLabel('User ID for preview / explanation').fill('user-a');
  await page.getByRole('button', { name: 'Published result', exact: true }).click();
  await expect(
    page.getByRole('cell', { name: 'Dynamic condition, Manual', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Country code is equal to "JP"', exact: true })
  ).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include('.admin-page-shell').analyze();
  expect(
    accessibility.violations.filter((v) => ['critical', 'serious'].includes(v.impact ?? ''))
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/authrim-service-groups-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect
    .poll(() => page.locator('.nav-floating').evaluate((el) => el.getBoundingClientRect().right))
    .toBeLessThanOrEqual(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/authrim-service-groups-mobile.png', fullPage: true });
});
