export const STRIPPED_PLUGIN_EGRESS_HEADERS = [
  'authorization',
  'cf-connecting-ip',
  'cf-ray',
  'cf-worker',
  'connection',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'proxy-authorization',
  'set-cookie',
  'transfer-encoding',
  'upgrade',
  'x-api-key',
  'x-auth-token',
  'x-forwarded-for',
  'x-real-ip',
] as const;

const FORBIDDEN_INJECTION_HEADERS = new Set([
  ...STRIPPED_PLUGIN_EGRESS_HEADERS,
  'content-encoding',
  'content-type',
]);

export function isApprovedCredentialInjectionHeader(
  kind: 'header' | 'bearer',
  name: string
): boolean {
  const normalized = name.toLowerCase();
  if (kind === 'bearer') return normalized === 'authorization';
  return !FORBIDDEN_INJECTION_HEADERS.has(normalized);
}
