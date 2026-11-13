/**
 * Public consent statement page API
 *
 * The text of one consent statement, for the public statement page of the Login UI
 * (`/statements/<slug>`). Public endpoint — no authentication. The statement must be active; a
 * version is shown only once it has been published (`active` or `archived`), never a draft.
 *
 * - GET /api/v1/consent-statements/:slug            the current version
 * - GET /api/v1/consent-statements/:slug?version=…  a published earlier version (YYYYMMDD)
 *
 * The language is `lang`, else the first `Accept-Language` tag, with the same fallback the consent
 * step uses (that language → English → the first localization).
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  getLocalization,
  getLogger,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';

const VERSION_PATTERN = /^\d{8}$/u;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u;
const MAX_SLUG_LENGTH = 128;

interface PublishedVersionRow {
  id: string;
  version: string;
  content_type: string;
  effective_at: number | string;
  is_current: number | string | boolean;
}

const isOn = (value: unknown): boolean => value === true || Number(value) === 1;

/** The language asked for: `lang` when well formed, else the first Accept-Language tag. */
export function requestedStatementLanguage(
  lang: string | undefined,
  acceptLanguage: string | undefined
): string {
  const fromQuery = lang?.trim();
  if (fromQuery && LANGUAGE_PATTERN.test(fromQuery)) return fromQuery;
  const first = acceptLanguage?.split(',')[0]?.split(';')[0]?.trim();
  if (first && LANGUAGE_PATTERN.test(first)) return first;
  return 'en';
}

function notFound(c: Context<{ Bindings: Env }>) {
  return c.json({ error: 'not_found', error_description: 'Statement not found' }, 404);
}

/** GET /api/v1/consent-statements/:slug */
export async function publicConsentStatementHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('PUBLIC_CONSENT_STATEMENT');
  const slug = c.req.param('slug') ?? '';
  const requestedVersion = c.req.query('version');
  if (!slug || slug.length > MAX_SLUG_LENGTH) return notFound(c);
  if (requestedVersion !== undefined && !VERSION_PATTERN.test(requestedVersion)) {
    return c.json({ error: 'invalid_request', error_description: 'version must be YYYYMMDD' }, 400);
  }

  try {
    const tenantId = getTenantIdFromContext(c);
    const db = createAuthContextFromHono(c, tenantId).coreAdapter;
    const statements = await db.query<{ id: string; slug: string; category: string }>(
      `SELECT id, slug, category FROM consent_statements
        WHERE tenant_id = ? AND slug = ? AND is_active = 1 AND retired_at IS NULL`,
      [tenantId, slug]
    );
    const statement = statements[0];
    if (!statement) return notFound(c);

    const versions = await db.query<PublishedVersionRow>(
      `SELECT id, version, content_type, effective_at, is_current
         FROM consent_statement_versions
        WHERE tenant_id = ? AND statement_id = ? AND status IN ('active', 'archived')
        ORDER BY version DESC`,
      [tenantId, statement.id]
    );
    const shown = requestedVersion
      ? versions.find((row) => row.version === requestedVersion)
      : versions.find((row) => isOn(row.is_current));
    if (!shown) return notFound(c);

    const language = requestedStatementLanguage(
      c.req.query('lang'),
      c.req.header('Accept-Language')
    );
    const localization = await getLocalization(db, tenantId, shown.id, language);

    // Not kept by a browser or a shared cache: on the shared Login UI the tenant is chosen by a
    // cookie, so the same URL can name another tenant's statement.
    c.header('Cache-Control', 'no-store');
    return c.json({
      slug: statement.slug,
      category: statement.category,
      language: localization?.language ?? language,
      title: localization?.title || statement.slug,
      description: localization?.description ?? '',
      content_type: shown.content_type === 'url' ? 'url' : 'inline',
      document_url: localization?.document_url ?? null,
      inline_content: localization?.inline_content ?? null,
      version: {
        version: shown.version,
        effective_at: Number(shown.effective_at),
        is_current: isOn(shown.is_current),
      },
      versions: versions.map((row) => ({
        version: row.version,
        effective_at: Number(row.effective_at),
        is_current: isOn(row.is_current),
      })),
    });
  } catch (error) {
    log.error('Failed to read the consent statement', { action: 'read' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to read the statement' },
      500
    );
  }
}
