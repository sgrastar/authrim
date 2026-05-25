import type { Env } from '../types/env';
import { getPrimaryTenantVanityDomain } from '../services/tenant-vanity-domain-resolver';
import {
  buildIssuerUrl,
  buildRequestIdentifier,
  buildRequestIssuerUrl,
  getRequestHost,
} from './issuer';
import { getTenantSettings } from './tenant-settings';

export interface TenantBindingPolicy {
  allowedHosts: string[];
  allowedIdentifiers: string[];
}

function parseDelimitedValues(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeHostEntry(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
      return new URL(trimmed).hostname.toLowerCase();
    }
  } catch {
    return null;
  }

  const host = trimmed.toLowerCase().replace(/\/$/, '');
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)
    ? host
    : null;
}

function normalizeIdentifierEntry(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
      return new URL(trimmed).origin;
    }
  } catch {
    return null;
  }

  return trimmed;
}

function normalizeIdentifierCandidate(value: string): string {
  if (value.startsWith('https://') || value.startsWith('http://')) {
    return new URL(value).origin;
  }

  return value;
}

export async function getTenantBindingPolicy(
  kv: KVNamespace | undefined,
  env: Partial<Env>,
  tenantId: string
): Promise<TenantBindingPolicy> {
  const settings = await getTenantSettings(kv, tenantId, 'tenant');
  const configuredHosts = new Set<string>();
  const configuredIdentifiers = new Set<string>();
  const defaultIdentifiers = new Set<string>();
  let canonicalHost: string | null = null;
  let canonicalIssuerUrl: string | null = null;

  try {
    canonicalIssuerUrl = buildIssuerUrl(env, tenantId);
    canonicalHost = new URL(canonicalIssuerUrl).hostname.toLowerCase();
    defaultIdentifiers.add(normalizeIdentifierCandidate(canonicalIssuerUrl));
    defaultIdentifiers.add(`did:web:${canonicalHost}`);
  } catch {
    // Ignore invalid canonical issuer configuration here; callers already validate
    // runtime issuer configuration elsewhere.
  }

  for (const entry of parseDelimitedValues(settings?.['tenant.allowed_domains'])) {
    const normalized = normalizeHostEntry(entry);
    if (normalized) {
      configuredHosts.add(normalized);
    }
  }

  for (const entry of parseDelimitedValues(settings?.['tenant.allowed_identifiers'])) {
    const normalized = normalizeIdentifierEntry(entry);
    if (normalized) {
      configuredIdentifiers.add(normalized);
    }
  }

  const primaryVanityDomain = await getPrimaryTenantVanityDomain(env, tenantId);
  if (primaryVanityDomain) {
    configuredHosts.add(primaryVanityDomain.hostname);
    configuredIdentifiers.add(`https://${primaryVanityDomain.hostname}`);
    configuredIdentifiers.add(`did:web:${primaryVanityDomain.hostname}`);
  }

  const allowedHosts =
    configuredHosts.size > 0 ? [...configuredHosts] : canonicalHost ? [canonicalHost] : [];
  const allowedIdentifiers =
    configuredIdentifiers.size > 0 ? [...configuredIdentifiers] : [...defaultIdentifiers];

  return {
    allowedHosts,
    allowedIdentifiers,
  };
}

export async function validateTenantRequestBinding(
  request: Request,
  kv: KVNamespace | undefined,
  env: Partial<Env>,
  tenantId: string
): Promise<boolean> {
  const policy = await getTenantBindingPolicy(kv, env, tenantId);
  const requestHost = getRequestHost(request)?.split(':')[0]?.toLowerCase();

  if (requestHost && policy.allowedHosts.length > 0 && !policy.allowedHosts.includes(requestHost)) {
    return false;
  }

  const identifierCandidates = new Set<string>();
  const issuerUrl = buildRequestIssuerUrl(request, env, tenantId);
  identifierCandidates.add(normalizeIdentifierCandidate(issuerUrl));
  identifierCandidates.add(
    normalizeIdentifierCandidate(
      buildRequestIdentifier(
        request,
        env,
        tenantId,
        (env as Partial<Env> & { ISSUER_IDENTIFIER?: string }).ISSUER_IDENTIFIER
      )
    )
  );

  const verifierIdentifier = (env as Partial<Env> & { VERIFIER_IDENTIFIER?: string })
    .VERIFIER_IDENTIFIER;
  if (verifierIdentifier) {
    identifierCandidates.add(
      normalizeIdentifierCandidate(
        buildRequestIdentifier(request, env, tenantId, verifierIdentifier)
      )
    );
  }

  return [...identifierCandidates].some((candidate) =>
    policy.allowedIdentifiers.includes(candidate)
  );
}
