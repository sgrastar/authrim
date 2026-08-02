export type PluginEgressRule =
  | { kind: 'exact'; host: string }
  | { kind: 'suffix_wildcard'; suffix: string };

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const FORBIDDEN_SUFFIXES = new Set([
  'internal',
  'localhost',
  'local',
  'localdomain',
  'home',
  'lan',
]);

function normalizedHost(hostname: string): string {
  const host = hostname.toLowerCase();
  if (
    host.length < 1 ||
    host.length > 253 ||
    host.endsWith('.') ||
    host.includes(':') ||
    host.includes('%') ||
    host.split('.').some((label) => !HOST_LABEL.test(label) || label.startsWith('xn--')) ||
    FORBIDDEN_SUFFIXES.has(host.split('.').at(-1) ?? '') ||
    /^\d+\.\d+\.\d+\.\d+$/u.test(host)
  ) {
    throw new Error('plugin_egress_host_invalid');
  }
  return host;
}

function normalizedRule(rule: PluginEgressRule): { kind: PluginEgressRule['kind']; host: string } {
  if (rule.kind === 'exact') return { kind: rule.kind, host: normalizedHost(rule.host) };
  if (rule.kind !== 'suffix_wildcard' || !rule.suffix.startsWith('*.')) {
    throw new Error('plugin_egress_rule_invalid');
  }
  const host = normalizedHost(rule.suffix.slice(2));
  if (host.split('.').length < 2) throw new Error('plugin_egress_rule_too_broad');
  return { kind: rule.kind, host };
}

export function authorizePluginEgressUrl(value: string, rules: readonly PluginEgressRule[]): URL {
  if (value.length > 4096 || rules.length > 100) throw new Error('plugin_egress_request_invalid');
  const schemeSeparator = value.indexOf('://');
  const authorityStart = schemeSeparator < 0 ? 0 : schemeSeparator + 3;
  const relativeAuthorityEnd = value.slice(authorityStart).search(/[/?#]/u);
  const authorityEnd =
    relativeAuthorityEnd < 0 ? value.length : authorityStart + relativeAuthorityEnd;
  const authority = value.slice(authorityStart, authorityEnd);
  if (schemeSeparator < 1 || authority.length < 1 || /[%\u0080-\uFFFF]/u.test(authority)) {
    throw new Error('plugin_egress_url_invalid');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('plugin_egress_url_invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    url.hash !== ''
  ) {
    throw new Error('plugin_egress_url_invalid');
  }
  const host = normalizedHost(url.hostname);
  const allowed = rules
    .map(normalizedRule)
    .some((rule) => (rule.kind === 'exact' ? host === rule.host : host.endsWith(`.${rule.host}`)));
  if (!allowed) throw new Error('plugin_egress_host_denied');
  return url;
}
