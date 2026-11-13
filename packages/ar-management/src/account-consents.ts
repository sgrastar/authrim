import type { Context } from 'hono';
import type { AccountInformationRelease, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  accountInformationRelease,
  createAccountAuthContextFromHono,
  createAuthContextFromHono,
  getTenantIdFromContext,
  listOAuthClientConsentsWithClients,
  listSamlSpReleaseConsentsWithProviders,
  listUserStatementConsentRecords,
  withdrawSamlSpReleaseConsent,
  lookupStatementDefinitions,
} from '@authrim/ar-lib-core';
import { requireAccountSession } from './account-page';
import { recordAccountOperation } from './account-operation-log';

type StatementConsentRow = {
  id: string;
  statement_id: string;
  version_id: string;
  version: string;
  status: string;
  granted_at: number | null;
  withdrawn_at: number | null;
  expires_at: number | null;
  client_id: string | null;
  receipt_id: string | null;
  updated_at: number;
  slug: string | null;
  category: string | null;
  title: string | null;
  description: string | null;
};

type FlowConsentRecordRow = StatementConsentRow & {
  decision: string;
  selected_value: string | null;
  record_status: string;
};

type AccountConsentRecord =
  | {
      kind: 'oauth_client';
      id: string;
      clientId: string;
      clientName?: string;
      clientLogoUri?: string;
      scopes: string[];
      selectedScopes?: string[];
      grantedAt: number;
      expiresAt?: number;
      policyVersions?: {
        privacyPolicyVersion?: string;
        tosVersion?: string;
        consentVersion?: number;
      };
      informationRelease?: AccountInformationRelease;
    }
  | {
      /** A SAML SP the person decided the information release for. */
      kind: 'saml_sp';
      id: string;
      spEntityId: string;
      spName?: string;
      decidedAt: number;
      informationRelease?: AccountInformationRelease;
    }
  | {
      kind: 'statement';
      id: string;
      statementId: string;
      versionId: string;
      version: string;
      status: string;
      title: string;
      description?: string;
      slug?: string;
      category?: string;
      grantedAt?: number;
      withdrawnAt?: number;
      expiresAt?: number;
      clientId?: string;
      receiptId?: string;
      updatedAt: number;
      selectedValue?: string;
    };

function setNoStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function getPreferredLanguage(c: Context<{ Bindings: Env }>): string {
  const language = c.req.header('Accept-Language')?.split(',')[0]?.trim();
  if (!language) return 'en';
  const lower = language.toLowerCase();
  if (
    lower === 'zh-cn' ||
    lower === 'zh-hans' ||
    lower.startsWith('zh-hans-') ||
    lower === 'zh-sg' ||
    lower === 'zh'
  ) {
    return 'zh-CN';
  }
  if (
    lower === 'zh-tw' ||
    lower === 'zh-hant' ||
    lower.startsWith('zh-hant-') ||
    lower === 'zh-hk' ||
    lower === 'zh-mo'
  ) {
    return 'zh-TW';
  }
  const base = lower.split('-')[0];
  return base &&
    [
      'en',
      'ja',
      'es',
      'pt',
      'fr',
      'de',
      'ko',
      'ru',
      'id',
      'ar',
      'it',
      'th',
      'vi',
      'hi',
      'bn',
      'tr',
      'sw',
      'am',
      'pl',
    ].includes(base)
    ? base
    : 'en';
}

function parseSelectedScopes(value: string | null): string[] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFlowConsentStatus(row: FlowConsentRecordRow): string {
  if (row.record_status === 'revoked') {
    return 'withdrawn';
  }
  if (row.decision === 'rejected') {
    return 'denied';
  }
  return 'granted';
}

async function listStatementConsentRows(input: {
  metadata: DatabaseAdapter;
  account: DatabaseAdapter;
  tenantId: string;
  userId: string;
  language: string;
}): Promise<StatementConsentRow[]> {
  const records = await listUserStatementConsentRecords(
    input.account,
    input.tenantId,
    input.userId
  );
  if (records.length === 0) return [];
  const definitions = await lookupStatementDefinitions(
    input.metadata,
    input.tenantId,
    {
      statementIds: records.map((record) => record.statement_id),
      versionIds: records.map((record) => record.version_id),
    },
    input.language
  );
  return records
    .map((record) => {
      const statement = definitions.statements.get(record.statement_id);
      const localization = definitions.localizations.get(record.version_id);
      return {
        id: record.id,
        statement_id: record.statement_id,
        version_id: record.version_id,
        version: record.version,
        status: record.status,
        granted_at: record.granted_at ?? null,
        withdrawn_at: record.withdrawn_at ?? null,
        expires_at: record.expires_at ?? null,
        client_id: record.client_id ?? null,
        receipt_id: record.receipt_id ?? null,
        updated_at: record.updated_at,
        slug: statement?.slug ?? null,
        category: statement?.category ?? null,
        title: localization?.title ?? statement?.slug ?? record.statement_id,
        description: localization?.description ?? null,
      };
    })
    .sort((left, right) => right.updated_at - left.updated_at);
}

export async function listAccountConsentsHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const accountCtx = createAccountAuthContextFromHono(c, tenantId);
  const preferredLanguage = getPreferredLanguage(c);
  const [statementRows, flowRecordRows, oauthRows, samlRows] = await Promise.all([
    // The record is the user's, in the account database; what it names is the tenant's, in the
    // metadata database. A record whose definition is gone is still returned (it is evidence).
    listStatementConsentRows({
      metadata: authCtx.coreAdapter,
      account: accountCtx.coreAdapter,
      tenantId,
      userId: accountSession.userId,
      language: preferredLanguage,
    }),
    authCtx.coreAdapter.query<FlowConsentRecordRow>(
      `SELECT cr.id, cr.statement_id,
              COALESCE(csv.id, cr.statement_version) AS version_id,
              cr.statement_version AS version,
              cr.decision, cr.selected_value, cr.status AS record_status,
              CASE
                WHEN cr.decision IN ('accepted', 'once', 'always', 'selected')
                THEN cr.created_at
                ELSE NULL
              END AS granted_at,
              cr.revoked_at AS withdrawn_at,
              cr.expires_at,
              COALESCE(cr.client_id, cr.saml_sp_id, cr.recipient_id) AS client_id,
              NULL AS receipt_id,
              cr.updated_at,
              cs.slug,
              cs.category,
              COALESCE(loc_pref.title, loc_en.title, cs.slug, cr.statement_id) AS title,
              COALESCE(loc_pref.description, loc_en.description) AS description
         FROM consent_records cr
         LEFT JOIN consent_statements cs
           ON cr.tenant_id = cs.tenant_id AND cr.statement_id = cs.id
         LEFT JOIN consent_statement_versions csv
           ON csv.tenant_id = cr.tenant_id
          AND csv.statement_id = cr.statement_id
          AND csv.version = cr.statement_version
         LEFT JOIN consent_statement_localizations loc_pref
           ON loc_pref.tenant_id = cr.tenant_id
          AND loc_pref.version_id = csv.id
          AND loc_pref.language = ?
         LEFT JOIN consent_statement_localizations loc_en
           ON loc_en.tenant_id = cr.tenant_id
          AND loc_en.version_id = csv.id
          AND loc_en.language = 'en'
        WHERE cr.tenant_id = ? AND cr.subject_user_id = ?
          AND NOT EXISTS (
            SELECT 1
              FROM consent_records newer
             WHERE newer.tenant_id = cr.tenant_id
               AND newer.subject_user_id = cr.subject_user_id
               AND newer.statement_id = cr.statement_id
               AND newer.statement_version = cr.statement_version
               AND COALESCE(newer.policy_id, '') = COALESCE(cr.policy_id, '')
               AND COALESCE(newer.client_id, '') = COALESCE(cr.client_id, '')
               AND COALESCE(newer.saml_sp_id, '') = COALESCE(cr.saml_sp_id, '')
               AND COALESCE(newer.recipient_type, '') = COALESCE(cr.recipient_type, '')
               AND COALESCE(newer.recipient_id, '') = COALESCE(cr.recipient_id, '')
               AND COALESCE(newer.binding_type, '') = COALESCE(cr.binding_type, '')
               AND COALESCE(newer.binding_key, '') = COALESCE(cr.binding_key, '')
               AND (
                 newer.updated_at > cr.updated_at
                 OR (newer.updated_at = cr.updated_at AND newer.created_at > cr.created_at)
               )
          )
        ORDER BY cr.updated_at DESC`,
      [preferredLanguage, tenantId, accountSession.userId]
    ),
    // OAuth client consents are stored with the user in its account database (resolved by
    // requireAccountSession); client records are tenant metadata.
    listOAuthClientConsentsWithClients({
      accountCore: accountCtx.coreAdapter,
      tenantMetadata: authCtx.coreAdapter,
      tenantId,
      userId: accountSession.userId,
    }),
    // SAML SPs' information release decisions: kept with the user, SP names are tenant metadata.
    listSamlSpReleaseConsentsWithProviders({
      accountCore: accountCtx.coreAdapter,
      tenantMetadata: authCtx.coreAdapter,
      tenantId,
      userId: accountSession.userId,
    }),
  ]);

  const statementConsents: AccountConsentRecord[] = statementRows.map((row) => ({
    kind: 'statement',
    id: row.id,
    statementId: row.statement_id,
    versionId: row.version_id,
    version: row.version,
    status: row.status,
    title: row.title ?? row.slug ?? row.statement_id,
    description: row.description ?? undefined,
    slug: row.slug ?? undefined,
    category: row.category ?? undefined,
    grantedAt: row.granted_at ?? undefined,
    withdrawnAt: row.withdrawn_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    clientId: row.client_id ?? undefined,
    receiptId: row.receipt_id ?? undefined,
    updatedAt: row.updated_at,
  }));

  const flowStatementConsents: AccountConsentRecord[] = flowRecordRows.map((row) => ({
    kind: 'statement',
    id: row.id,
    statementId: row.statement_id,
    versionId: row.version_id,
    version: row.version,
    status: normalizeFlowConsentStatus(row),
    title: row.title ?? row.slug ?? row.statement_id,
    description: row.description ?? undefined,
    slug: row.slug ?? undefined,
    category: row.category ?? undefined,
    grantedAt: row.granted_at ?? undefined,
    withdrawnAt: row.withdrawn_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    clientId: row.client_id ?? undefined,
    receiptId: row.receipt_id ?? undefined,
    updatedAt: row.updated_at,
    selectedValue: row.selected_value ?? undefined,
  }));

  const oauthConsents: AccountConsentRecord[] = oauthRows.map((row) => ({
    kind: 'oauth_client',
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name ?? undefined,
    clientLogoUri: row.logo_uri ?? undefined,
    scopes: row.scope.split(' ').filter(Boolean),
    selectedScopes: parseSelectedScopes(row.selected_scopes),
    grantedAt: row.granted_at,
    expiresAt: row.expires_at ?? undefined,
    policyVersions:
      row.privacy_policy_version || row.tos_version
        ? {
            privacyPolicyVersion: row.privacy_policy_version ?? undefined,
            tosVersion: row.tos_version ?? undefined,
            consentVersion: row.consent_version ?? 1,
          }
        : undefined,
    informationRelease: accountInformationRelease(row),
  }));
  const samlConsents: AccountConsentRecord[] = samlRows.map((row) => ({
    kind: 'saml_sp',
    id: row.spEntityId,
    spEntityId: row.spEntityId,
    spName: row.spName ?? undefined,
    decidedAt: row.decidedAt,
    // The SP's trust wins over the record (a new sign-in is approved by it); a record that cannot
    // be read is shown without its items.
    informationRelease: row.currentBasis
      ? { basis: row.currentBasis, approved: [], declined: [], decidedAt: row.decidedAt }
      : row.release
        ? {
            basis: row.release.basis,
            approved: row.release.basis === 'user' ? row.release.approved : [],
            declined: row.release.basis === 'user' ? row.release.declined : [],
            decidedAt: row.decidedAt,
            ...(row.release.refused ? { refused: true } : {}),
          }
        : undefined,
  }));
  const consents = [
    ...flowStatementConsents,
    ...statementConsents,
    ...oauthConsents,
    ...samlConsents,
  ];

  return c.json({
    consents,
    total: consents.length,
  });
}

/**
 * Withdraw the person's information release decision on a SAML SP:
 * DELETE /api/account/consents/saml-sp?sp_entity_id=...
 *
 * The next sign-in to the SP asks again; a sign-in in flight issues nothing under the old
 * decision (the withdrawal generation moves on).
 */
export async function withdrawAccountSamlConsentHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }
  const spEntityId = c.req.query('sp_entity_id');
  if (!spEntityId || spEntityId.length > 2048) {
    return c.json({ error: 'invalid_request', error_description: 'sp_entity_id is required' }, 400);
  }
  const tenantId = getTenantIdFromContext(c);
  const accountCtx = createAccountAuthContextFromHono(c, tenantId);
  const { withdrawn } = await withdrawSamlSpReleaseConsent(accountCtx.coreAdapter, {
    tenantId,
    userId: accountSession.userId,
    spEntityId,
    now: Date.now(),
    userAgent: c.req.header('User-Agent') ?? null,
  });
  if (!withdrawn) {
    return c.json({ error: 'not_found', error_description: 'Consent not found' }, 404);
  }
  await recordAccountOperation(c, {
    userId: accountSession.userId,
    action: 'account.consent.withdrawn',
    resourceType: 'saml_sp',
    resourceId: spEntityId,
    metadata: { protocol: 'saml' },
  });
  return c.json({ withdrawn: true });
}
