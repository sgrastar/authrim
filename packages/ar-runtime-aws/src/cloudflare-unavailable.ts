/**
 * AWS build guard for declarations exported by shared Cloudflare modules.
 * It deliberately provides no state, RPC, storage, or execution implementation.
 */
export class DurableObject {
  constructor() {
    throw new Error('Cloudflare Durable Objects cannot be instantiated by the AWS runtime');
  }
}

export class WorkerEntrypoint {
  constructor() {
    throw new Error('Cloudflare Worker entrypoints cannot be instantiated by the AWS runtime');
  }
}
