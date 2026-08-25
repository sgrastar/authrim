import { Resolver } from 'node:dns/promises';
import { Blob } from 'node:buffer';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { URLSearchParams } from 'node:url';

const PUBLIC_DNS_SERVERS = ['1.1.1.1', '1.0.0.1'];
const MAX_PUBLIC_DNS_RESPONSE_BYTES = 1024 * 1024;

export function isDnsResolutionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const directCode = (error as { code?: unknown }).code;
  if (directCode === 'ENOTFOUND' || directCode === 'EAI_AGAIN') return true;
  return isDnsResolutionError((error as { cause?: unknown }).cause);
}

async function resolvePublicAddress(
  hostname: string,
  signal?: AbortSignal
): Promise<{
  address: string;
  family: 4 | 6;
}> {
  if (signal?.aborted) throw new Error('public_dns_fetch_aborted');
  const resolver = new Resolver({ timeout: 2_000, tries: 2 });
  resolver.setServers(PUBLIC_DNS_SERVERS);
  const abort = () => resolver.cancel();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    try {
      const addresses = await resolver.resolve4(hostname);
      const address = addresses.find((candidate) => isIP(candidate) === 4);
      if (address) return { address, family: 4 };
    } catch {
      if (signal?.aborted) throw new Error('public_dns_fetch_aborted');
      // Try IPv6 before reporting the public DNS lookup failure.
    }

    const addresses = await resolver.resolve6(hostname);
    const address = addresses.find((candidate) => isIP(candidate) === 6);
    if (!address) throw new Error('public_dns_address_missing');
    return { address, family: 6 };
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function serializeRequestBody(
  body: globalThis.RequestInit['body']
): Promise<string | Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof globalThis.ArrayBuffer) return new Uint8Array(body);
  if (globalThis.ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new Error('public_dns_fallback_unsupported_request_body');
}

/**
 * Retry an HTTPS readiness request through a public DNS answer while preserving hostname-based
 * certificate validation and SNI. This is used only after the system resolver reports a temporary
 * DNS miss immediately after a Cloudflare Worker custom domain is created.
 */
export async function fetchWithPublicDns(
  input: string | URL,
  init: globalThis.RequestInit = {},
  timeoutMs = 10_000
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== 'https:') throw new Error('public_dns_fallback_requires_https');

  const resolved = await resolvePublicAddress(url.hostname, init.signal ?? undefined);
  const requestHeaders: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    requestHeaders[name] = value;
  });
  const requestBody = await serializeRequestBody(init.body);

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let abort: (() => void) | undefined;
    const cleanup = () => {
      if (abort && init.signal) init.signal.removeEventListener('abort', abort);
    };
    const resolveOnce = (response: Response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const request = httpsRequest(
      url,
      {
        method: init.method ?? 'GET',
        headers: requestHeaders,
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [resolved]);
          } else {
            callback(null, resolved.address, resolved.family);
          }
        },
      },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item);
          } else if (value !== undefined) {
            headers.set(name, value);
          }
        }
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        response.on('data', (chunk: Buffer) => {
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_PUBLIC_DNS_RESPONSE_BYTES) {
            response.destroy(new Error('public_dns_response_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const status = response.statusCode ?? 500;
          const body =
            status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
          resolveOnce(
            new Response(body, {
              status,
              statusText: response.statusMessage,
              headers,
            })
          );
        });
        response.on('error', rejectOnce);
      }
    );

    request.setTimeout(timeoutMs, () => request.destroy(new Error('public_dns_fetch_timeout')));
    request.on('error', rejectOnce);
    if (init.signal) {
      abort = () => request.destroy(new Error('public_dns_fetch_aborted'));
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    }
    request.end(requestBody);
  });
}
