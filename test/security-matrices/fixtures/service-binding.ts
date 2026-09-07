import type { CallLedger } from './call-ledger';

export interface ServiceBindingHandler {
  route: (input: Request) => Promise<Response>;
}

/**
 * In-memory Fetcher/service-binding fake. Routes requests to a handler function and records
 * the call in the ledger. This provides transport/request-shape evidence only.
 */
export class MemoryFetcher {
  constructor(
    private readonly handler: ServiceBindingHandler,
    private readonly ledger?: CallLedger,
    private readonly label = 'service-binding'
  ) {}

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    this.ledger?.record('do.fetch', `${this.label}:${request.method} ${request.url}`);
    return this.handler.route(request);
  }
}

export interface MemoryRpcService<
  TRpc extends Record<string, (...args: unknown[]) => Promise<unknown>>,
> {
  stub: TRpc;
  calls: Array<{ method: string; args: unknown[] }>;
}

/**
 * In-memory RPC service-binding fake used for service-to-worker RPC contracts.
 */
export function createMemoryRpcService<
  TRpc extends Record<string, (...args: unknown[]) => Promise<unknown>>,
>(
  ledger: CallLedger | undefined,
  label: string,
  handlers: {
    [K in keyof TRpc]: (...args: Parameters<TRpc[K]>) => Promise<Awaited<ReturnType<TRpc[K]>>>;
  }
): MemoryRpcService<TRpc> {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const stub = {} as TRpc;
  for (const method of Object.keys(handlers)) {
    (stub as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      ledger?.record('do.rpc', `${label}:${method}`);
      calls.push({ method, args });
      const handler = (handlers as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
      return handler(...args);
    };
  }
  return { stub, calls };
}
