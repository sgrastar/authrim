import {
  DirectoryPasswordError,
  type DirectoryPasswordVerifyInput,
  type DirectoryPasswordVerifyResult,
  validateDirectoryPasswordVerifyResult,
} from './directory-password';

const DEFAULT_RELAY_TIMEOUT_MS = 5000;

export interface DirectoryPasswordRelayClientConfig {
  relay: DurableObjectNamespace;
  tenantId: string;
  connectorId: string;
  timeoutMs?: number;
}

export class DirectoryPasswordRelayClient {
  constructor(private readonly config: DirectoryPasswordRelayClientConfig) {}

  async verifyPassword(
    input: DirectoryPasswordVerifyInput
  ): Promise<DirectoryPasswordVerifyResult> {
    const requestId = input.requestId || crypto.randomUUID();
    let lastError: DirectoryPasswordError | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.verifyPasswordOnce(input, requestId);
      } catch (error) {
        if (!(error instanceof DirectoryPasswordError)) throw error;
        lastError = error;
        if (attempt > 0 || !shouldRetryRelayError(error.details)) {
          throw error;
        }
      }
    }

    throw (
      lastError ??
      new DirectoryPasswordError({
        requestId,
        tenantId: this.config.tenantId,
        connectorId: this.config.connectorId,
        code: 'relay_unavailable',
        retryable: true,
        status: 0,
      })
    );
  }

  private async verifyPasswordOnce(
    input: DirectoryPasswordVerifyInput,
    requestId: string
  ): Promise<DirectoryPasswordVerifyResult> {
    const stub = this.relayStub();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs || DEFAULT_RELAY_TIMEOUT_MS
    );

    let response: Response;
    try {
      response = await stub.fetch('https://directory-relay.internal/verify-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          request_id: requestId,
          tenant_id: this.config.tenantId,
          connector_id: this.config.connectorId,
          username: input.username,
          password: input.password,
          attribute_names: input.attributeNames || [],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new DirectoryPasswordError({
        requestId,
        tenantId: this.config.tenantId,
        connectorId: this.config.connectorId,
        code:
          error instanceof DOMException && error.name === 'AbortError'
            ? 'relay_timeout'
            : 'relay_fetch_error',
        retryable: true,
        status: 0,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const parsed = await safeParseRelayError(response);
      throw new DirectoryPasswordError({
        requestId,
        tenantId: this.config.tenantId,
        connectorId: this.config.connectorId,
        code: parsed.error?.code || 'relay_unavailable',
        retryable: parsed.error?.retryable ?? response.status >= 500,
        status: response.status,
      });
    }

    return validateDirectoryPasswordVerifyResult(
      await safeParseJson(response),
      {
        endpoint: 'https://directory-relay.internal',
        tenantId: this.config.tenantId,
        connectorId: this.config.connectorId,
        keyId: '',
        secret: '',
        timeoutMs: this.config.timeoutMs,
      },
      requestId
    );
  }

  private relayStub(): DurableObjectStub {
    const id = this.config.relay.idFromName(directoryRelayInstanceName(this.config));
    return this.config.relay.get(id);
  }
}

function shouldRetryRelayError(error: {
  code: string;
  retryable: boolean;
  status: number;
}): boolean {
  if (!error.retryable) return false;
  if (error.status === 429) return false;
  return ![
    'relay_connector_offline',
    'relay_overloaded',
    'relay_connector_not_configured',
    'invalid_relay_request',
    'relay_request_too_large',
  ].includes(error.code);
}

export function directoryRelayInstanceName(input: {
  tenantId: string;
  connectorId: string;
}): string {
  return `${encodeURIComponent(input.tenantId)}:${encodeURIComponent(input.connectorId)}`;
}

async function safeParseRelayError(response: Response): Promise<{
  error?: { code?: string; retryable?: boolean };
}> {
  try {
    return (await response.json()) as { error?: { code?: string; retryable?: boolean } };
  } catch {
    return {};
  }
}

async function safeParseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
