/** Provider-independent control transport. Credentials are scoped to one caller by the server. */
export const REPLICATION_RPC_PATH = '/replication/v1/rpc';
export const REPLICATION_RPC_MAX_BYTES = 64 * 1024;
export const REPLICATION_RPC_MAX_CLOCK_SKEW_MS = 60_000;

export interface ReplicationRpcEnvelope {
  version: 1;
  credentialId: string;
  timestamp: number;
  requestId: string;
  action: string;
  payload: unknown;
}

function invalid(): never {
  throw new Error('replication_transport_invalid');
}

export function replicationCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(replicationCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${replicationCanonicalJson(Reflect.get(value, key))}`)
      .join(',')}}`;
  return invalid();
}

export function assertReplicationIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) invalid();
}

export function assertReplicationSecret(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid();
}

export function replicationEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== REPLICATION_RPC_PATH ||
    url.href !== value
  )
    invalid();
  return url.href;
}

async function key(secret: string) {
  assertReplicationSecret(secret);
  return crypto.subtle.importKey(
    'raw',
    Uint8Array.from(secret.match(/../gu)!, (byte) => parseInt(byte, 16)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function signingInput(body: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(`POST\n${REPLICATION_RPC_PATH}\n${body}`));
}

export async function signReplicationRpc(body: string, secret: string): Promise<string> {
  const signed = await crypto.subtle.sign('HMAC', await key(secret), signingInput(body));
  return [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyReplicationRpc(
  body: string,
  signature: string,
  secret: string
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/u.test(signature)) return false;
  return crypto.subtle.verify(
    'HMAC',
    await key(secret),
    Uint8Array.from(signature.match(/../gu)!, (byte) => parseInt(byte, 16)).buffer,
    signingInput(body)
  );
}

export function parseReplicationRpc(body: string, now: number): ReplicationRpcEnvelope {
  if (new TextEncoder().encode(body).byteLength > REPLICATION_RPC_MAX_BYTES) invalid();
  const value = JSON.parse(body) as ReplicationRpcEnvelope;
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'action,credentialId,payload,requestId,timestamp,version' ||
    replicationCanonicalJson(value) !== body ||
    value.version !== 1 ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(value.timestamp) ||
    value.timestamp < 0 ||
    Math.abs(now - value.timestamp) > REPLICATION_RPC_MAX_CLOCK_SKEW_MS
  )
    invalid();
  for (const id of [value.credentialId, value.requestId, value.action])
    assertReplicationIdentifier(id);
  return value;
}

/** No redirect following, credential forwarding, implicit retries, or cached authorization. */
export function createReplicationRpcClient(input: {
  endpoint: string;
  credentialId: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const endpoint = replicationEndpoint(input.endpoint);
  assertReplicationIdentifier(input.credentialId);
  assertReplicationSecret(input.secret);
  const transport = input.fetch ?? fetch;
  return async (action: string, payload: unknown): Promise<unknown> => {
    try {
      assertReplicationIdentifier(action);
      const body = replicationCanonicalJson({
        version: 1,
        credentialId: input.credentialId,
        timestamp: (input.now ?? Date.now)(),
        requestId: crypto.randomUUID(),
        action,
        payload,
      });
      if (new TextEncoder().encode(body).byteLength > REPLICATION_RPC_MAX_BYTES) invalid();
      const response = await transport(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Authrim-Replication-Signature': await signReplicationRpc(body, input.secret),
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        invalid();
      }
      const reader = response.body.getReader();
      const pieces: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (!(part.value instanceof Uint8Array)) invalid();
          bytes += part.value.byteLength;
          if (bytes > REPLICATION_RPC_MAX_BYTES) invalid();
          pieces.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const result = new Uint8Array(bytes);
      let offset = 0;
      for (const part of pieces) {
        result.set(part, offset);
        offset += part.byteLength;
      }
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(result)
      ) as unknown;
    } catch {
      // Neither remote diagnostics nor credentials/tenant data escape a runtime admission failure.
      throw new Error('replication_authority_unavailable');
    }
  };
}
