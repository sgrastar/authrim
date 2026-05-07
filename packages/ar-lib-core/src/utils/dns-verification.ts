/**
 * DNS TXT Record Verification Utility
 *
 * Uses DNS over HTTPS (DoH) to query DNS TXT records for domain ownership verification.
 * Cloudflare Workers cannot perform native DNS lookups, so DoH is required.
 *
 * @packageDocumentation
 */

import { safeFetchJson } from './url-security';

// =============================================================================
// Types
// =============================================================================

export interface DnsVerificationResult {
  verified: boolean;
  recordFound: boolean;
  expectedValue: string;
  actualValues: string[];
  error?: string;
}

export interface DnsVerificationConfig {
  /** DoH endpoint URL (default: Cloudflare DNS) */
  dohEndpoint?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** DNS record prefix (default: _authrim-verify) */
  recordPrefix?: string;
  /** Token prefix in TXT value (default: authrim-domain-verify=) */
  tokenPrefix?: string;
}

// DoH JSON response format (RFC 8484 / Cloudflare DoH JSON API)
interface DohResponse {
  Status: number;
  TC: boolean;
  RD: boolean;
  RA: boolean;
  AD: boolean;
  CD: boolean;
  Question: Array<{ name: string; type: number }>;
  Answer?: Array<{
    name: string;
    type: number;
    TTL: number;
    data: string;
  }>;
}

// =============================================================================
// Constants
// =============================================================================

// Cloudflare DoH endpoint (supports JSON format)
const DEFAULT_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RECORD_PREFIX = '_authrim-verify';
const DEFAULT_TOKEN_PREFIX = 'authrim-domain-verify=';

// DNS record type: TXT = 16
const DNS_TYPE_TXT = 16;

// Token validity duration (24 hours)
export const VERIFICATION_TOKEN_TTL_SECONDS = 24 * 60 * 60;

// =============================================================================
// Token Generation
// =============================================================================

/**
 * Generate a cryptographically secure verification token
 */
export async function generateVerificationToken(): Promise<string> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Get the DNS record name for verification
 */
export function getVerificationRecordName(domain: string, config?: DnsVerificationConfig): string {
  const prefix = config?.recordPrefix || DEFAULT_RECORD_PREFIX;
  // Remove any leading dot from domain
  const normalizedDomain = domain.replace(/^\./, '');
  return `${prefix}.${normalizedDomain}`;
}

/**
 * Get the expected TXT record value
 */
export function getExpectedRecordValue(token: string, config?: DnsVerificationConfig): string {
  const tokenPrefix = config?.tokenPrefix || DEFAULT_TOKEN_PREFIX;
  return `${tokenPrefix}${token}`;
}

// =============================================================================
// DNS Query via DoH
// =============================================================================

/**
 * Query DNS TXT records using DNS over HTTPS
 *
 * @param domain - The domain to query TXT records for
 * @param config - Optional configuration
 * @returns Array of TXT record values
 */
export async function queryDnsTxtRecords(
  domain: string,
  config?: DnsVerificationConfig
): Promise<string[]> {
  const endpoint = config?.dohEndpoint || DEFAULT_DOH_ENDPOINT;
  const timeout = config?.timeout || DEFAULT_TIMEOUT_MS;

  // Build DoH query URL with JSON format
  const url = new URL(endpoint);
  url.searchParams.set('name', domain);
  url.searchParams.set('type', 'TXT');

  try {
    const data = await safeFetchJson<DohResponse>(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/dns-json',
      },
      timeoutMs: timeout,
      maxResponseSize: 64 * 1024,
    });

    // Check for NXDOMAIN or other errors
    if (data.Status !== 0) {
      // Status 0 = NOERROR, 3 = NXDOMAIN
      return [];
    }

    if (!data.Answer) {
      return [];
    }

    // Extract TXT record values
    return data.Answer.filter((answer) => answer.type === DNS_TYPE_TXT).map((answer) => {
      // TXT records may be quoted in the response
      let value = answer.data;
      // Remove surrounding quotes if present
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      return value;
    });
  } catch (error) {
    throw error;
  }
}

// =============================================================================
// Domain Verification
// =============================================================================

/**
 * Verify domain ownership via DNS TXT record
 *
 * Expected record format:
 * Name: _authrim-verify.example.com
 * Value: authrim-domain-verify={token}
 *
 * @param domain - The domain to verify
 * @param token - The verification token to check
 * @param config - Optional configuration
 * @returns Verification result
 */
export async function verifyDomainDnsTxt(
  domain: string,
  token: string,
  config?: DnsVerificationConfig
): Promise<DnsVerificationResult> {
  const recordName = getVerificationRecordName(domain, config);
  const expectedValue = getExpectedRecordValue(token, config);

  try {
    const txtRecords = await queryDnsTxtRecords(recordName, config);

    const verified = txtRecords.some((value) => value === expectedValue);

    return {
      verified,
      recordFound: txtRecords.length > 0,
      expectedValue,
      actualValues: txtRecords,
    };
  } catch (error) {
    return {
      verified: false,
      recordFound: false,
      expectedValue,
      actualValues: [],
      error: error instanceof Error ? error.message : 'Unknown DNS query error',
    };
  }
}

// =============================================================================
// Verification Status Helpers
// =============================================================================

export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'failed' | 'expired';

/**
 * Check if verification token has expired
 */
export function isVerificationExpired(expiresAt: number): boolean {
  return Math.floor(Date.now() / 1000) > expiresAt;
}

/**
 * Calculate token expiration timestamp
 */
export function calculateVerificationExpiry(ttlSeconds?: number): number {
  const ttl = ttlSeconds ?? VERIFICATION_TOKEN_TTL_SECONDS;
  return Math.floor(Date.now() / 1000) + ttl;
}
