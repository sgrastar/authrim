import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listQueuesMock = vi.hoisted(() => vi.fn());
vi.mock('../core/cloudflare.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/cloudflare.js')>()),
  listQueues: listQueuesMock,
}));

import {
  beginOrResumeProvisioningIntent,
  loadProvisioningIntent,
  recordProvisioningResourceCreateIssued,
} from '../core/provisioning-intent.js';
import { recoverAbsentQueueCreate } from '../core/queue-create-recovery.js';
import { getEnvironmentPaths } from '../core/paths.js';

describe('interrupted Queue create recovery', () => {
  let baseDir: string;
  const accountId = '0123456789abcdef0123456789abcdef';
  const binding = 'LOGGING_DELIVERY_BULK_QUEUE';
  const name = 'test-logging-delivery-bulk-queue';

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'authrim-queue-recovery-'));
    listQueuesMock.mockReset();
    const attempt = await beginOrResumeProvisioningIntent({
      baseDir,
      environment: 'test',
      accountId,
      resourceSpec: { queues: true },
    });
    await recordProvisioningResourceCreateIssued({
      baseDir,
      environment: 'test',
      expectedIntentId: attempt.intent.id,
      resource: { kind: 'queue', binding, name },
    });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function ageCheckpoint(): Promise<void> {
    const path = getEnvironmentPaths({ baseDir, env: 'test' }).provisioningIntent;
    const intent = JSON.parse(await readFile(path, 'utf8'));
    intent.updatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await writeFile(path, `${JSON.stringify(intent)}\n`);
  }

  it('releases only the absent Queue checkpoint after two pinned-account inventory reads', async () => {
    await ageCheckpoint();
    listQueuesMock.mockResolvedValue([]);

    await expect(
      recoverAbsentQueueCreate({ baseDir, environment: 'test', binding })
    ).resolves.toEqual({
      name,
    });
    expect(listQueuesMock).toHaveBeenCalledTimes(2);
    expect(listQueuesMock).toHaveBeenCalledWith({
      strictOutput: true,
      requireIds: true,
      accountId,
    });
    const intent = await loadProvisioningIntent({ baseDir, environment: 'test' });
    expect(intent?.resources[`queue:${binding}`]?.state).toBe('create_rejected');
  });

  it('preserves the ambiguous checkpoint when the Queue appears on the second read', async () => {
    await ageCheckpoint();
    listQueuesMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ name, id: 'queue-id' }]);

    await expect(
      recoverAbsentQueueCreate({ baseDir, environment: 'test', binding })
    ).rejects.toThrow('exists in the pinned Cloudflare account');
    const intent = await loadProvisioningIntent({ baseDir, environment: 'test' });
    expect(intent?.resources[`queue:${binding}`]?.state).toBe('create_issued');
  });

  it('does not inspect Cloudflare while the ambiguous create may still be settling', async () => {
    await expect(
      recoverAbsentQueueCreate({ baseDir, environment: 'test', binding })
    ).rejects.toThrow('too recent to verify absence safely');
    expect(listQueuesMock).not.toHaveBeenCalled();
  });
});
