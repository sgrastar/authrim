/**
 * Console notices for SAML provider certificates that are about to expire or already have.
 *
 * Runs with the scheduled maintenance, for the tenants of that run. A provider (IdP or SP) counts
 * while enabled, or while the metadata sync suspended it because its certificate ran out (that is
 * the outage the notice is about). It counts by the end of its continuous certificate coverage from
 * now: a rollover certificate that already is valid keeps the notice away, one that starts only
 * after the current certificate ends does not (verification fails in the gap). Within 14 days of
 * that end (or past it) the notice is `high`, within 30 days `caution`. One notice per provider,
 * level and end date; a notice whose provider is fine again (new certificate, disabled by an
 * administrator, deleted) is resolved on the next run.
 */

import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS, AdminNoticeRepository } from '@authrim/ar-lib-core';
import { requireDedicatedAdminDatabaseAdapter } from '@authrim/ar-lib-core';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SAML_CERTIFICATE_CAUTION_DAYS = 30;
export const SAML_CERTIFICATE_HIGH_DAYS = 14;
const CATEGORY = 'saml_certificate';
type Level = 'expired' | 'high' | 'caution';

export interface SamlCertificateProblem {
  providerId: string;
  providerName: string;
  providerType: string;
  level: Level;
  validTo: number;
}

interface ProviderRow {
  id: string;
  name: string;
  provider_type: string;
  config_json: string;
  enabled?: number | boolean | null;
}

interface Log {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface SamlNoticeTarget {
  tenantId: string;
  adapters: Array<{ adapter: DatabaseAdapter; bindingRef: string }>;
}

interface CertificateSpan {
  from: number;
  to: number;
}

function certificateSpans(configJson: string): CertificateSpan[] {
  let config: unknown;
  try {
    config = JSON.parse(configJson);
  } catch {
    return [];
  }
  const certificates = (config as { certificateValidation?: { certificates?: unknown } })
    ?.certificateValidation?.certificates;
  if (!Array.isArray(certificates)) return [];
  const spans: CertificateSpan[] = [];
  for (const certificate of certificates) {
    const entry = certificate as { validFrom?: unknown; validTo?: unknown } | null;
    if (typeof entry?.validTo !== 'string') continue;
    const to = Date.parse(entry.validTo);
    if (!Number.isFinite(to)) continue;
    const parsedFrom = typeof entry.validFrom === 'string' ? Date.parse(entry.validFrom) : NaN;
    spans.push({ from: Number.isFinite(parsedFrom) ? parsedFrom : -Infinity, to });
  }
  return spans;
}

/**
 * The time the provider's certificates stop covering it, counted from `now`: the end of the
 * continuous run of certificates that are valid now and follow one another without a gap. When no
 * certificate is valid now, the latest end among those already over (or, when every certificate
 * starts later, the latest end overall). Null when no certificate is known.
 */
export function certificateCoverageEnd(configJson: string, now: number): number | null {
  const spans = certificateSpans(configJson);
  if (spans.length === 0) return null;
  let covered = now;
  for (;;) {
    let next = covered;
    for (const span of spans) {
      if (span.from <= covered && span.to > covered && span.to > next) next = span.to;
    }
    if (next === covered) break;
    covered = next;
  }
  if (covered > now) return covered;
  const over = spans.filter((span) => span.to <= now).map((span) => span.to);
  return Math.max(...(over.length > 0 ? over : spans.map((span) => span.to)));
}

export function certificateLevel(validTo: number, now: number): Level | null {
  if (validTo <= now) return 'expired';
  const remaining = validTo - now;
  if (remaining <= SAML_CERTIFICATE_HIGH_DAYS * DAY_MS) return 'high';
  if (remaining <= SAML_CERTIFICATE_CAUTION_DAYS * DAY_MS) return 'caution';
  return null;
}

/** Enabled, or switched off by the metadata sync (not by an administrator). */
function isInService(row: ProviderRow): boolean {
  if (
    row.enabled === undefined ||
    row.enabled === null ||
    row.enabled === 1 ||
    row.enabled === true
  )
    return true;
  try {
    const policy = (JSON.parse(row.config_json) as { metadataRefreshPolicy?: unknown })
      ?.metadataRefreshPolicy as { suspendedByMetadataSync?: unknown } | undefined;
    return policy?.suspendedByMetadataSync === true;
  } catch {
    return false;
  }
}

export function findSamlCertificateProblems(
  rows: ProviderRow[],
  now: number
): SamlCertificateProblem[] {
  const problems: SamlCertificateProblem[] = [];
  for (const row of rows) {
    if (!isInService(row)) continue;
    const validTo = certificateCoverageEnd(row.config_json, now);
    if (validTo === null) continue;
    const level = certificateLevel(validTo, now);
    if (level) {
      problems.push({
        providerId: row.id,
        providerName: row.name,
        providerType: row.provider_type,
        level,
        validTo,
      });
    }
  }
  return problems;
}

const dayOf = (time: number): string => new Date(time).toISOString().slice(0, 10);

/** The date is part of the key: a replaced certificate with a new end opens a fresh notice. */
const keyOf = (tenantId: string, problem: SamlCertificateProblem): string =>
  `saml-cert:${tenantId}:${problem.providerId}:${problem.level}:${dayOf(problem.validTo)}`;

/** Raise what is due for one tenant and resolve what no longer is. */
export async function syncSamlCertificateNotices(
  notices: AdminNoticeRepository,
  tenantId: string,
  problems: SamlCertificateProblem[],
  now: number
): Promise<{ raised: number; resolved: number }> {
  const wanted = new Set(problems.map((p) => keyOf(tenantId, p)));
  let raised = 0;
  for (const problem of problems) {
    const date = dayOf(problem.validTo);
    const expired = problem.level === 'expired';
    const title = expired
      ? `The certificate of the SAML provider ${problem.providerName} has expired (${date})`
      : `The certificate of the SAML provider ${problem.providerName} expires on ${date}`;
    await notices.create(
      {
        scope_type: 'tenant',
        tenant_id: tenantId,
        severity: problem.level === 'caution' ? 'caution' : 'high',
        source: 'system',
        category: CATEGORY,
        message_key: expired ? 'saml_certificate_expired' : 'saml_certificate_expiring',
        params: { provider: problem.providerName, date },
        title,
        link: '/admin/applications/all',
        required_permission: ADMIN_PERMISSIONS.SAML_PROVIDERS_READ,
        source_ref: problem.providerId,
        deduplication_key: keyOf(tenantId, problem),
      },
      now
    );
    raised += 1;
  }
  let resolved = 0;
  for (const key of await notices.listOpenDeduplicationKeys(tenantId, CATEGORY)) {
    if (!wanted.has(key) && (await notices.resolveByDeduplicationKey(key, now))) resolved += 1;
  }
  return { raised, resolved };
}

async function providersOf(target: SamlNoticeTarget): Promise<ProviderRow[]> {
  const rows: ProviderRow[] = [];
  for (const { adapter } of target.adapters) {
    rows.push(
      ...(await adapter.query<ProviderRow>(
        `SELECT id, name, provider_type, config_json, enabled FROM identity_providers
          WHERE tenant_id = ? AND provider_type IN ('saml_idp', 'saml_sp')`,
        [target.tenantId]
      ))
    );
  }
  return rows;
}

/**
 * The scheduled run. Never throws. A tenant whose providers cannot be read is left as it is (its
 * open notices are not resolved on a guess).
 */
export async function processScheduledSamlCertificateNotices(
  env: Env,
  targets: SamlNoticeTarget[],
  log: Log,
  now: number = Date.now()
): Promise<void> {
  try {
    const notices = new AdminNoticeRepository(
      requireDedicatedAdminDatabaseAdapter(env, 'admin-notice-saml-certificates')
    );
    for (const target of targets) {
      try {
        const problems = findSamlCertificateProblems(await providersOf(target), now);
        const result = await syncSamlCertificateNotices(notices, target.tenantId, problems, now);
        if (result.raised > 0 || result.resolved > 0) {
          log.info('SAML certificate notices synced', { tenantId: target.tenantId, ...result });
        }
      } catch (error) {
        log.warn('SAML certificate notices skipped for a tenant', {
          tenantId: target.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    log.warn('SAML certificate notices failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
