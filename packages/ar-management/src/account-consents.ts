import type { Context } from 'hono';
import type { AccountInformationRelease, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  accountInformationRelease,
  CONSENT_EVENTS,
  createAccountAuthContextFromHono,
  createAuthContextFromHono,
  getLogger,
  getTenantIdFromContext,
  invalidateConsentCache,
  listOAuthClientConsentsWithClients,
  listSamlSpReleaseConsentsWithProviders,
  listUserStatementConsentRecords,
  publishEvent,
  withdrawSamlSpReleaseConsent,
  withdrawStatementConsent,
  lookupStatementDefinitions,
  type ExtendedConsentEventData,
} from '@authrim/ar-lib-core';
import { requireAccountSession } from './account-page';
import { recordAccountOperation } from './account-operation-log';
import { withdrawOAuthClientConsent } from './oauth-client-consent-withdrawal';

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
  /** The person can withdraw it here: granted, and the statement allows withdrawal. */
  withdrawable?: boolean;
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
      /** It can be withdrawn on the account page (DELETE /api/account/consents/statements/:id). */
      withdrawable?: boolean;
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
  const statementIds = [...new Set(records.map((record) => record.statement_id))];
  // Whether each statement allows withdrawal (read in chunks: D1 binds at most 100 values).
  const allowsWithdrawal = new Map<string, boolean>();
  for (let start = 0; start < statementIds.length; start += 90) {
    const chunk = statementIds.slice(start, start + 90);
    const rows = await input.metadata.query<{
      id: string;
      withdrawal_allowed: number | string | boolean | null;
    }>(
      `SELECT id, withdrawal_allowed FROM consent_statements
        WHERE tenant_id = ? AND id IN (${chunk.map(() => '?').join(',')})`,
      [input.tenantId, ...chunk]
    );
    for (const row of rows) {
      allowsWithdrawal.set(
        row.id,
        row.withdrawal_allowed === null ||
          row.withdrawal_allowed === true ||
          Number(row.withdrawal_allowed) === 1
      );
    }
  }
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
        withdrawable:
          // A statement that is gone no longer forbids it (the withdrawal itself allows it then).
          record.status === 'granted' && allowsWithdrawal.get(record.statement_id) !== false,
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
    withdrawable: row.withdrawable === true,
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

/**
 * Withdraw the person's consent to an OIDC service:
 * DELETE /api/account/consents/oauth-client?client_id=...
 *
 * Ends the tokens issued under it (refresh token families included) and deletes it; the next
 * authorization asks again. A failure leaves the consent in place, so a retry can complete it.
 */
export async function withdrawAccountOAuthClientConsentHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }
  const clientId = c.req.query('client_id');
  if (!clientId || clientId.length > 256) {
    return c.json({ error: 'invalid_request', error_description: 'client_id is required' }, 400);
  }
  const tenantId = getTenantIdFromContext(c);
  const userId = accountSession.userId;
  const accountCtx = createAccountAuthContextFromHono(c, tenantId);
  const existing = await accountCtx.coreAdapter.query<{ scope: string }>(
    `SELECT scope FROM oauth_client_consents
      WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
    [tenantId, userId, clientId]
  );
  if (existing.length === 0) {
    return c.json({ error: 'not_found', error_description: 'Consent not found' }, 404);
  }
  const previousScopes = existing[0].scope.split(' ').filter(Boolean);
  await withdrawOAuthClientConsent(c.env, accountCtx.coreAdapter, {
    tenantId,
    userId,
    clientId,
    previousScopes,
  });
  await invalidateConsentCache(c.env, userId, tenantId, clientId);
  publishEvent(c, {
    type: CONSENT_EVENTS.REVOKED,
    tenantId,
    data: {
      userId,
      clientId,
      scopes: previousScopes,
      previousScopes,
      revocationReason: 'user_request',
      initiatedBy: 'user',
    } satisfies ExtendedConsentEventData,
  }).catch((error: unknown) => {
    getLogger(c)
      .module('ACCOUNT')
      .error(
        'Failed to publish consent.revoked event',
        { action: 'publish_event' },
        error as Error
      );
  });
  await recordAccountOperation(c, {
    userId,
    action: 'account.consent.withdrawn',
    resourceType: 'oauth_client',
    resourceId: clientId,
    metadata: { protocol: 'oidc' },
  });
  return c.json({ withdrawn: true });
}

/**
 * Withdraw the person's agreement to a consent statement:
 * DELETE /api/account/consents/statements/:statementId
 *
 * Only a granted agreement to a statement that allows withdrawal; a required statement is asked
 * again at the next sign-in or single sign-on.
 */
export async function withdrawAccountStatementConsentHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }
  const statementId = c.req.param('statementId');
  if (!statementId || statementId.length > 128) {
    return c.json({ error: 'invalid_request', error_description: 'statementId is required' }, 400);
  }
  const tenantId = getTenantIdFromContext(c);
  const userId = accountSession.userId;
  try {
    const result = await withdrawStatementConsent(
      {
        metadata: createAuthContextFromHono(c, tenantId).coreAdapter,
        account: createAccountAuthContextFromHono(c, tenantId).coreAdapter,
      },
      tenantId,
      userId,
      statementId,
      { env: c.env, actor: { id: userId, type: 'user' } }
    );
    if (result === 'missing') {
      return c.json({ error: 'not_found', error_description: 'Consent not found' }, 404);
    }
    if (result === 'not_granted') {
      return c.json(
        { error: 'invalid_request', error_description: 'Only a granted consent can be withdrawn' },
        400
      );
    }
    if (result === 'withdrawal_forbidden') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'This consent statement does not allow withdrawal',
        },
        400
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'statement_consent_atomic_backend_unsupported'
    ) {
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'Consent cannot be withdrawn on this database backend',
        },
        503
      );
    }
    throw error;
  }
  await recordAccountOperation(c, {
    userId,
    action: 'account.consent.withdrawn',
    resourceType: 'statement',
    resourceId: statementId,
    metadata: { kind: 'statement' },
  });
  return c.json({ withdrawn: true });
}
