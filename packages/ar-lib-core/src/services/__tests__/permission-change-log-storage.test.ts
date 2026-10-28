import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logProducerFixture } from './log-iceberg-producer-fixture';
import { createPermissionChangeNotifier } from '../permission-change-notifier';

describe.each(['scheduled', 'pipeline'] as const)('permission change log storage (%s)', (mode) => {
  let f: Awaited<ReturnType<typeof logProducerFixture>>;
  beforeEach(async () => {
    f = await logProducerFixture(mode);
  });
  afterEach(() => f.db.close());
  it('publishes one new encrypted event with the existing millisecond event timestamp and second row creation time', async () => {
    const event = {
      tenant_id: 'tenant-a',
      event: 'grant' as const,
      subject_id: 'user-1',
      resource: 'document:1',
      permission: 'read',
      timestamp: f.now - 5000,
    };
    expect(await createPermissionChangeNotifier({ env: f.env }).publish(event)).toMatchObject({
      auditLogged: true,
    });
    const rows = await f.rows('core.permission_change_audit');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: 'tenant-a',
      event_type: 'grant',
      timestamp: event.timestamp,
    });
    expect(Number(rows[0].created_at)).toBeLessThan(100_000_000_000);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM permission_change_audit').get()?.n).toBe(0);
    expect(f.queueMessages.length).toBe(mode === 'pipeline' ? 1 : 0);
  });
});
