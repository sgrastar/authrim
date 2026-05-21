import { signHttpSinkPayload, type HttpSinkSignatureInput } from './http-sink-signature';

export type HttpSinkAuthMode = 'none' | 'bearer' | 'api_key' | 'custom_headers' | 'hmac';

export interface HttpSinkAuthConfig {
  mode: HttpSinkAuthMode;
  bearerToken?: string;
  apiKey?: {
    headerName: string;
    value: string;
    prefix?: string;
  };
  customHeaders?: Array<{
    name: string;
    value: string;
    secret?: boolean;
  }>;
  hmac?: Omit<HttpSinkSignatureInput, 'secret'> & {
    secret: string;
  };
}

export interface HttpSinkAuthHeadersResult {
  headers: Record<string, string>;
  redactedHeaders: Record<string, string>;
}

const REDACTED = '[redacted]';

function assertHeaderName(name: string): void {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
    throw new Error(`invalid_http_header_name:${name}`);
  }
}

function setHeader(
  result: HttpSinkAuthHeadersResult,
  name: string,
  value: string,
  secret: boolean
): void {
  assertHeaderName(name);
  result.headers[name] = value;
  result.redactedHeaders[name] = secret ? REDACTED : value;
}

export async function buildHttpSinkAuthHeaders(
  config: HttpSinkAuthConfig
): Promise<HttpSinkAuthHeadersResult> {
  const result: HttpSinkAuthHeadersResult = {
    headers: {},
    redactedHeaders: {},
  };

  if (config.mode === 'none') {
    return result;
  }

  if (config.mode === 'bearer') {
    if (!config.bearerToken) {
      throw new Error('missing_bearer_token');
    }
    setHeader(result, 'Authorization', `Bearer ${config.bearerToken}`, true);
    return result;
  }

  if (config.mode === 'api_key') {
    if (!config.apiKey) {
      throw new Error('missing_api_key');
    }
    const value = config.apiKey.prefix
      ? `${config.apiKey.prefix} ${config.apiKey.value}`
      : config.apiKey.value;
    setHeader(result, config.apiKey.headerName, value, true);
    return result;
  }

  if (config.mode === 'custom_headers') {
    for (const header of config.customHeaders ?? []) {
      setHeader(result, header.name, header.value, header.secret ?? false);
    }
    return result;
  }

  if (config.mode === 'hmac') {
    if (!config.hmac) {
      throw new Error('missing_hmac_config');
    }
    const signature = await signHttpSinkPayload(config.hmac);
    for (const [name, value] of Object.entries(signature.headers)) {
      setHeader(result, name, value, name.toLowerCase().includes('signature'));
    }
    return result;
  }

  return result;
}
