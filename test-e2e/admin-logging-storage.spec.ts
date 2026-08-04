import { expect, test } from '@playwright/test';

const now = 1779340000000;

const tenantResponse = {
  tenants: [
    {
      id: 'tenant-a',
      tenant_code: 'tenant-a',
      name: 'Tenant A',
      description: null,
      is_active: true,
      is_default: true,
      created_at: now,
      updated_at: now,
    },
  ],
  total: 1,
};

const sessionResponse = {
  active: true,
  session_id: 'admin-session-1',
  user_id: 'admin-1',
  tenant_id: 'tenant-a',
  email: 'admin@example.com',
  name: 'Platform Admin',
  roles: ['super_admin'],
  admin_scope: 'platform',
  is_platform_admin: true,
  expires_at: now + 3600000,
  created_at: now,
  last_login_at: now,
};

function json(body: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === '/api/admin/me/session') {
      await route.fulfill(json(sessionResponse));
      return;
    }
    if (path === '/api/admin/tenants') {
      await route.fulfill(json(tenantResponse));
      return;
    }
    if (path === '/api/admin/tenants/tenant-a/clients') {
      await route.fulfill(json({ clients: [] }));
      return;
    }
    if (path === '/api/admin/storage-destinations') {
      await route.fulfill(json({ items: [], total: 0 }));
      return;
    }
    if (path === '/api/admin/destinations') {
      await route.fulfill(json({ items: [], total: 0 }));
      return;
    }
    if (path === '/api/admin/logging-policies') {
      await route.fulfill(
        json({
          item: {
            tenant_id: 'tenant-a',
            version: 1,
            assignments: [],
            fallbacks: [],
            snapshots: [],
          },
        })
      );
      return;
    }
    if (path === '/api/admin/logging-policies/delivery-summary') {
      await route.fulfill(
        json({ item: { window_start_at: now - 3600000, window_end_at: now, items: [] } })
      );
      return;
    }
    if (path === '/api/admin/logging-policies/notifications') {
      await route.fulfill(json({ items: [], total: 0 }));
      return;
    }
    if (path === '/api/admin/logging-policies/message-jobs') {
      await route.fulfill(json({ items: [], total: 0 }));
      return;
    }
    if (path === '/api/admin/admin-logging') {
      await route.fulfill(
        json({
          item: {
            tenant_id: 'tenant-a',
            window_start_at: now - 86400000,
            coverage: { covered: 12, gap_detected: 0, acknowledged: 0, ignored: 0 },
            critical_protection: {
              critical_destination_count: 1,
              failing_destination_count: 0,
              critical_assignment_count: 3,
              unprotected_assignment_count: 0,
            },
            sensitive_detail: {
              chunked: true,
              encrypted: true,
              assignment_count: 2,
              policy_count: 2,
              indexed_object_class_count: 3,
              stale_key_count: 0,
            },
            audit: { total: 3, failures: 0, critical: 1 },
            archive: [],
            delivery: [],
            recent_changes: [],
          },
        })
      );
      return;
    }
    if (path.startsWith('/api/admin/admin-logging/')) {
      await route.fulfill(json({ items: [], total: 0, item: null }));
      return;
    }

    await route.fulfill(json({ items: [], total: 0 }));
  });
});

test('renders logging/storage admin control-plane pages with mocked APIs', async ({ page }) => {
  await page.goto('/admin/storage-destinations');
  await expect(page.getByRole('heading', { name: 'Storage Destinations' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Control Plane Destinations' })).toBeVisible();

  await page.goto('/admin/logging-policies');
  await expect(page.getByRole('heading', { name: 'Logging' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delivery Summary' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Operational Alerts' })).toBeVisible();

  await page.goto('/admin/admin-logging');
  await expect(page.getByRole('heading', { name: 'Admin Logging' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Audit Coverage' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sensitive Detail' })).toBeVisible();
});
