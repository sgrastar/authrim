import { getRequiredQueues, listQueues } from './cloudflare.js';
import {
  loadProvisioningIntent,
  recordProvisioningResourceCreateRejected,
} from './provisioning-intent.js';

const MINIMUM_CREATE_SETTLE_MS = 5 * 60_000;
const INVENTORY_RECHECK_DELAY_MS = process.env.NODE_ENV === 'test' ? 5 : 5_000;

/**
 * Explicitly release an interrupted Queue create only after the pinned account's complete REST
 * inventory reports the Queue absent twice. This never adopts a same-name Queue or mutates
 * Cloudflare; the next normal setup run performs a new create with a fresh strict absence check.
 */
export async function recoverAbsentQueueCreate(input: {
  baseDir: string;
  environment: string;
  binding: string;
}): Promise<{ name: string }> {
  const definition = getRequiredQueues(input.environment).find(
    (candidate) => candidate.binding === input.binding
  );
  if (!definition) throw new Error(`Unknown Queue binding: ${input.binding}`);

  const intent = await loadProvisioningIntent({
    baseDir: input.baseDir,
    environment: input.environment,
  });
  if (!intent) throw new Error('No interrupted provisioning attempt exists for this environment');
  const checkpoint = intent.resources[`queue:${input.binding}`];
  if (
    !checkpoint ||
    checkpoint.kind !== 'queue' ||
    checkpoint.name !== definition.name ||
    checkpoint.state !== 'create_issued' ||
    checkpoint.id
  ) {
    throw new Error(`Queue ${definition.name} has no ambiguous create checkpoint to recover`);
  }
  if (Date.now() - Date.parse(intent.updatedAt) < MINIMUM_CREATE_SETTLE_MS) {
    throw new Error(`Queue ${definition.name} create is too recent to verify absence safely`);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const queues = await listQueues({
      strictOutput: true,
      requireIds: true,
      accountId: intent.accountId,
    });
    if (queues.some((queue) => queue.name === definition.name)) {
      throw new Error(
        `Queue ${definition.name} exists in the pinned Cloudflare account; its ownership ` +
          'cannot be inferred from its name'
      );
    }
    if (attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, INVENTORY_RECHECK_DELAY_MS));
    }
  }

  await recordProvisioningResourceCreateRejected({
    baseDir: input.baseDir,
    environment: input.environment,
    expectedIntentId: intent.id,
    resource: { kind: 'queue', binding: input.binding, name: definition.name },
  });
  return { name: definition.name };
}
