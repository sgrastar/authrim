import type { JsonObject, JsonValue } from '../../core';
import type {
  AgentConfigurationOperationRequest,
  AgentConfigurationOperationResult,
  AgentRuntimeDiagnosticsPort,
} from '../ports';
import type { CloudflareFetcherBinding } from './service-binding';

function object(value: JsonValue): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

const MAX_DIAGNOSTIC_JSON_BYTES = 256 * 1024;

async function boundedJson(response: Response): Promise<JsonValue> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_DIAGNOSTIC_JSON_BYTES) {
    throw new RangeError('Diagnostic response too large');
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_DIAGNOSTIC_JSON_BYTES) {
    throw new RangeError('Diagnostic response too large');
  }
  return JSON.parse(text) as JsonValue;
}

function issuer(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError('Invalid issuer origin');
  }
  return parsed;
}

function publicKeyMetadata(value: JsonValue): JsonObject[] {
  const document = object(value);
  const keys = Array.isArray(document?.keys) ? document.keys : [];
  return keys.slice(0, 20).flatMap((candidate) => {
    const key = object(candidate);
    if (!key) return [];
    return [
      Object.fromEntries(
        ['kid', 'kty', 'alg', 'use', 'crv']
          .filter((name) => typeof key[name] === 'string')
          .map((name) => [name, key[name]])
      ) as JsonObject,
    ];
  });
}

/** Cloudflare service-binding implementation; protocol and core know only the diagnostics port. */
export class CloudflareAgentRuntimeDiagnostics implements AgentRuntimeDiagnosticsPort {
  constructor(
    private readonly discovery: CloudflareFetcherBinding,
    private readonly management: CloudflareFetcherBinding
  ) {}

  async inspect(
    request: AgentConfigurationOperationRequest
  ): Promise<AgentConfigurationOperationResult> {
    let publicIssuer: URL;
    try {
      publicIssuer = issuer(request.issuerOrigin);
    } catch {
      return { status: 400, body: { error: 'AGENT_RUNTIME_ISSUER_INVALID' } };
    }
    const headers = {
      'x-authrim-forwarded-host': publicIssuer.host,
      'x-correlation-id': request.correlationId,
    };
    try {
      const [discoveryResponse, jwksResponse, healthResponse] = await Promise.all([
        this.discovery.fetch(
          new Request('https://ar-discovery.internal/.well-known/openid-configuration', { headers })
        ),
        this.discovery.fetch(
          new Request('https://ar-discovery.internal/.well-known/jwks.json', { headers })
        ),
        this.management.fetch(
          new Request('https://ar-management.internal/api/health', { headers })
        ),
      ]);
      const discoveryBody = discoveryResponse.ok
        ? object(await boundedJson(discoveryResponse))
        : null;
      const jwksBody = jwksResponse.ok ? await boundedJson(jwksResponse) : null;
      const reportedIssuer =
        typeof discoveryBody?.issuer === 'string' ? discoveryBody.issuer : undefined;
      return {
        status: 200,
        body: {
          snapshot: {
            issuer: request.issuerOrigin,
            discovery_status: discoveryResponse.status,
            issuer_matches: reportedIssuer === request.issuerOrigin,
            reported_issuer: reportedIssuer ?? null,
            jwks_status: jwksResponse.status,
            signing_keys: jwksBody ? publicKeyMetadata(jwksBody) : [],
            management_health_status: healthResponse.status,
            healthy:
              discoveryResponse.ok &&
              jwksResponse.ok &&
              healthResponse.ok &&
              reportedIssuer === request.issuerOrigin,
          },
        },
      };
    } catch {
      return {
        status: 503,
        body: { error: 'AGENT_RUNTIME_DIAGNOSTICS_UNAVAILABLE' },
        executionStatus: 'definite',
      };
    }
  }
}
