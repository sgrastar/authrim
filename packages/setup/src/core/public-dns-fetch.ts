import { Resolver } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const PUBLIC_DNS_SERVERS = ['1.1.1.1', '1.0.0.1'];

export function isDnsResolutionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const directCode = (error as { code?: unknown }).code;
  if (directCode === 'ENOTFOUND' || directCode === 'EAI_AGAIN') return true;
  return isDnsResolutionError((error as { cause?: unknown }).cause);
}

async function resolvePublicAddress(hostname: string): Promise<{
  address: string;
  family: 4 | 6;
}> {
  const resolver = new Resolver({ timeout: 2_000, tries: 2 });
  resolver.setServers(PUBLIC_DNS_SERVERS);

  try {
    const addresses = await resolver.resolve4(hostname);
    const address = addresses.find((candidate) => isIP(candidate) === 4);
    if (address) return { address, family: 4 };
  } catch {
    // Try IPv6 before reporting the public DNS lookup failure.
  }

  const addresses = await resolver.resolve6(hostname);
  const address = addresses.find((candidate) => isIP(candidate) === 6);
  if (!address) throw new Error('public_dns_address_missing');
  return { address, family: 6 };
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

  const resolved = await resolvePublicAddress(url.hostname);
  const requestHeaders = Object.fromEntries(new Headers(init.headers).entries());

  return await new Promise<Response>((resolve, reject) => {
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
        response.resume();
        resolve(
          new Response(null, {
            status: response.statusCode ?? 500,
            statusText: response.statusMessage,
            headers,
          })
        );
      }
    );

    request.setTimeout(timeoutMs, () => request.destroy(new Error('public_dns_fetch_timeout')));
    request.on('error', reject);
    if (init.signal) {
      const abort = () => request.destroy(new Error('public_dns_fetch_aborted'));
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    }
    request.end();
  });
}
