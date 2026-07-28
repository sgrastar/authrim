import { WorkerEntrypoint } from 'cloudflare:workers';
import { D1ControlRepository } from './repository';
import { ControlService } from './service';
import type { ControlEnv } from './types';

function service(env: ControlEnv): ControlService {
  return new ControlService({
    repository: new D1ControlRepository(env.CONTROL_DB),
    env,
    now: () => Math.floor(Date.now() / 1000),
  });
}

const EXPOSED_RPC_ERROR =
  /^(invalid_[a-z0-9_]+|control_(environment_not_found|residency_partition_not_found|resource_policy_not_found|d1_resource_limit|operation_idempotency_conflict))$/u;

async function rpcResult<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && EXPOSED_RPC_ERROR.test(error.message)) {
      throw new Error(error.message);
    }
    throw new Error('control_internal_error');
  }
}

export default class ControlWorker extends WorkerEntrypoint<ControlEnv> {
  async fetch(): Promise<Response> {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  requestTenantShard(input: unknown) {
    return rpcResult(() => service(this.env).requestTenantShard(input));
  }

  getOperationStatus(operationId: unknown) {
    return rpcResult(() => service(this.env).getOperation(operationId));
  }

  reconcilePending() {
    return rpcResult(() => service(this.env).reconcilePending());
  }

  replenishLowWatermark() {
    return rpcResult(() => service(this.env).replenishLowWatermark());
  }

  async scheduled(): Promise<void> {
    const control = service(this.env);
    const results = await Promise.allSettled([
      control.reconcilePending(),
      control.replenishLowWatermark(),
    ]);
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('control_scheduled_reconciliation_failed');
    }
  }
}

export { ControlService } from './service';
export { D1ControlRepository } from './repository';
export type * from './types';
