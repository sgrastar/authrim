import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentAccessMcpRequestContext } from '../../protocol/mcp';

export const AGENT_ACCESS_INTERNAL_CONTEXT_HEADER = 'x-authrim-agent-access-context';
const MAX_CONTEXT_BYTES = 16 * 1024;

export interface CloudflareAgentAccessCurrentRequest {
  context: AgentAccessMcpRequestContext;
  sourceAccessToken: string;
}

const requestStorage = new AsyncLocalStorage<CloudflareAgentAccessCurrentRequest>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function encodeCloudflareAgentAccessRequestContext(
  context: AgentAccessMcpRequestContext
): string {
  const bytes = new TextEncoder().encode(JSON.stringify(context));
  if (bytes.byteLength > MAX_CONTEXT_BYTES) {
    throw new TypeError('Agent Access request context is too large');
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

export function decodeCloudflareAgentAccessRequestContext(
  encoded: string | null
): AgentAccessMcpRequestContext | null {
  if (!encoded || encoded.length > Math.ceil((MAX_CONTEXT_BYTES * 4) / 3) + 4) return null;
  try {
    const padded = encoded
      .replace(/-/gu, '+')
      .replace(/_/gu, '/')
      .padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength > MAX_CONTEXT_BYTES) return null;
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isRecord(value) ||
      !isRecord(value.actor) ||
      !isRecord(value.grant) ||
      !isRecord(value.resource) ||
      typeof value.issuerOrigin !== 'string' ||
      typeof value.correlationId !== 'string'
    ) {
      return null;
    }
    return value as unknown as AgentAccessMcpRequestContext;
  } catch {
    return null;
  }
}

export function runWithCloudflareAgentAccessRequest<T>(
  request: CloudflareAgentAccessCurrentRequest,
  callback: () => T
): T {
  return requestStorage.run(request, callback);
}

export function getCloudflareAgentAccessCurrentRequest():
  | CloudflareAgentAccessCurrentRequest
  | undefined {
  return requestStorage.getStore();
}
