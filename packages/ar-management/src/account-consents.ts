import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  getTenantIdFromContext,
  invalidateConsentCache,
} from '@authrim/ar-lib-core';
import { requireAccountSession } from './account-page';
import { recordAccountOperation } from './account-operation-log';

const ACCOUNT_CONSENT_REAUTH_TTL_SECONDS = 5 * 60;
const ACCOUNT_CONSENT_ID_MAX_LENGTH = 512;

type OAuthClientConsentRow = {
  id: string;
  client_id: string;
  scope: string;
  selected_scopes: unknown;
  granted_at: number;
  expires_at: number | null;
  privacy_policy_version: string | null;
  tos_version: string | null;
  consent_version: number | null;
  client_name: string | null;
  logo_uri: string | null;
};

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
  protocol: string;
  consent_kind: string;
  recipient_type: string | null;
  recipient_id: string | null;
  status: string;
  flow_id: string | null;
  flow_version_id: string | null;
  flow_node_id: string | null;
  released_scopes_json: unknown;
  released_claims_json: unknown;
  released_attributes_json: unknown;
  evidence_json: unknown;
};

type AccountConsentRecord =
  | {
      kind: 'oauth_client';
      recordType: 'release_grant';
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
    }
  | {
      kind: 'statement';
      recordType: 'document_acceptance' | 'release_grant';
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
      consentKind?: string;
      protocol?: string;
      gateKind?: 'legal_document' | 'oidc_authorization' | 'saml_attribute_release';
      targetType?: string;
      targetId?: string;
      flowId?: string;
      flowVersionId?: string;
      flowNodeId?: string;
      releasedScopes?: string[];
      releasedClaims?: string[];
      releasedAttributes?: string[];
    };

function setNoStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function getPreferredLanguage(c: Context<{ Bindings: Env }>): string {
  const language = c.req.header('Accept-Language')?.split(',')[0]?.split('-')[0]?.toLowerCase();
  return language === 'ja' ? 'ja' : 'en';
}

function parseSelectedScopes(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'string') ? value : undefined;
  }
  if (!value) {
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function parseStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'string') ? value : undefined;
  }
  if (!value) return undefined;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function receiptIdFromEvidence(value: unknown): string | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const receiptId = (parsed as Record<string, unknown>).consent_gate_receipt_id;
    return typeof receiptId === 'string' && /^cgr_[a-f0-9]{32}$/u.test(receiptId)
      ? receiptId
      : undefined;
  } catch {
    return undefined;
  }
}

function gateKindForConsentKind(
  consentKind: string
): 'legal_document' | 'oidc_authorization' | 'saml_attribute_release' {
  if (consentKind === 'scope_claim_release') return 'oidc_authorization';
  if (consentKind === 'attribute_release') return 'saml_attribute_release';
  return 'legal_document';
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

export async function listAccountConsentsHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const preferredLanguage = getPreferredLanguage(c);
  const [statementRows, flowRecordRows, oauthRows] = await Promise.all([
    authCtx.coreAdapter.query<StatementConsentRow>(
      `SELECT ucr.id, ucr.statement_id, ucr.version_id, ucr.version, ucr.status,
              ucr.granted_at, ucr.withdrawn_at, ucr.expires_at, ucr.client_id,
              ucr.receipt_id, ucr.updated_at, cs.slug, cs.category,
              COALESCE(loc_pref.title, loc_en.title, cs.slug, ucr.statement_id) AS title,
              COALESCE(loc_pref.description, loc_en.description) AS description
         FROM user_consent_records ucr
         LEFT JOIN consent_statements cs
           ON ucr.tenant_id = cs.tenant_id AND ucr.statement_id = cs.id
         LEFT JOIN consent_statement_localizations loc_pref
           ON loc_pref.tenant_id = ucr.tenant_id
          AND loc_pref.version_id = ucr.version_id
          AND loc_pref.language = ?
         LEFT JOIN consent_statement_localizations loc_en
           ON loc_en.tenant_id = ucr.tenant_id
          AND loc_en.version_id = ucr.version_id
          AND loc_en.language = 'en'
        WHERE ucr.tenant_id = ? AND ucr.user_id = ?
        ORDER BY ucr.updated_at DESC`,
      [preferredLanguage, tenantId, accountSession.userId]
    ),
    authCtx.coreAdapter.query<FlowConsentRecordRow>(
      `SELECT cr.id, cr.statement_id,
              COALESCE(csv.id, cr.statement_version) AS version_id,
              cr.statement_version AS version,
			  cr.decision, cr.selected_value,
              CASE dac.status
                WHEN 'accepted' THEN 'active'
                WHEN 'withdrawn' THEN 'revoked'
                WHEN 'expired' THEN 'expired'
                ELSE cr.status
              END AS record_status,
			  cr.protocol, cr.consent_kind, cr.recipient_type, cr.recipient_id,
			  cr.flow_id, cr.flow_version_id, cr.flow_node_id,
			  cr.released_scopes_json, cr.released_claims_json,
			  cr.released_attributes_json, cr.evidence_json,
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
         LEFT JOIN document_acknowledgments_current dac
           ON dac.tenant_id = cr.tenant_id
          AND dac.subject_user_id = cr.subject_user_id
          AND dac.consent_kind = cr.consent_kind
          AND dac.statement_id = cr.statement_id
          AND dac.statement_version = cr.statement_version
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
                 OR (
                   newer.updated_at = cr.updated_at
                   AND newer.created_at = cr.created_at
                   AND newer.status = 'revoked'
                   AND cr.status <> 'revoked'
                 )
               )
          )
        ORDER BY cr.updated_at DESC`,
      [preferredLanguage, tenantId, accountSession.userId]
    ),
    authCtx.coreAdapter.query<OAuthClientConsentRow>(
      `SELECT c.id, c.client_id, c.scope, c.selected_scopes, c.granted_at, c.expires_at,
              c.privacy_policy_version, c.tos_version, c.consent_version,
              oc.client_name, oc.logo_uri
         FROM oauth_client_consents c
         LEFT JOIN oauth_clients oc ON c.tenant_id = oc.tenant_id AND c.client_id = oc.client_id
        WHERE c.tenant_id = ? AND c.user_id = ?
        ORDER BY c.granted_at DESC`,
      [tenantId, accountSession.userId]
    ),
  ]);

  const statementConsents: AccountConsentRecord[] = statementRows.map((row) => ({
    kind: 'statement',
    recordType: 'document_acceptance',
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
    recordType:
      row.consent_kind === 'scope_claim_release' || row.consent_kind === 'attribute_release'
        ? 'release_grant'
        : 'document_acceptance',
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
    receiptId: receiptIdFromEvidence(row.evidence_json) ?? row.receipt_id ?? undefined,
    updatedAt: row.updated_at,
    selectedValue: row.selected_value ?? undefined,
    consentKind: row.consent_kind,
    protocol: row.protocol,
    gateKind: gateKindForConsentKind(row.consent_kind),
    targetType: row.recipient_type ?? undefined,
    targetId: row.recipient_id ?? undefined,
    flowId: row.flow_id ?? undefined,
    flowVersionId: row.flow_version_id ?? undefined,
    flowNodeId: row.flow_node_id ?? undefined,
    releasedScopes: parseStringArray(row.released_scopes_json),
    releasedClaims: parseStringArray(row.released_claims_json),
    releasedAttributes: parseStringArray(row.released_attributes_json),
  }));

  const oauthConsents: AccountConsentRecord[] = oauthRows.map((row) => ({
    kind: 'oauth_client',
    recordType: 'release_grant',
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
  }));
  const consents = [...flowStatementConsents, ...statementConsents, ...oauthConsents];

  return c.json({
    consents,
    total: consents.length,
  });
}

type AccountConsentWithdrawalKind = 'document_acceptance' | 'release_grant' | 'oauth_client';

type ConsentEvidenceIdentityRow = {
  id: string;
  protocol: string;
  consent_kind: string;
  statement_id: string;
  statement_version: string;
  client_id: string | null;
  saml_sp_id: string | null;
  recipient_type: string | null;
  recipient_id: string | null;
};

function accountConsentReauthRequired(c: Context<{ Bindings: Env }>): Response {
  setNoStore(c);
  return c.json(
    {
      error: 'reauth_required',
      error_description: 'Recent authentication is required to withdraw consent',
      reauth_required: true,
    },
    403
  );
}

function validWithdrawalKind(value: string): value is AccountConsentWithdrawalKind {
  return value === 'document_acceptance' || value === 'release_grant' || value === 'oauth_client';
}

function buildConsentWithdrawalEvidenceStatement(input: {
  tenantId: string;
  userId: string;
  sourceRecordId: string;
  withdrawalRecordId: string;
  now: number;
  withdrawalKind: AccountConsentWithdrawalKind;
  currentStateExistsSql: string;
  currentStateExistsParams: unknown[];
}): { sql: string; params: unknown[] } {
  return {
    sql: `INSERT INTO consent_records (
      id, tenant_id, subject_user_id, actor_user_id, protocol, consent_kind,
      client_id, saml_sp_id, recipient_type, recipient_id, binding_type, binding_key,
      resource_type, resource_id, purpose_key, statement_id, statement_version, policy_id,
      flow_id, flow_version_id, flow_node_id, decision, selected_value, selected_options_json,
      released_scopes_json, released_claims_json, released_attributes_json, status, expires_at,
      revoked_at, evidence_json, created_at, updated_at
    )
    SELECT ?, tenant_id, subject_user_id, ?, protocol, consent_kind,
           client_id, saml_sp_id, recipient_type, recipient_id, binding_type, binding_key,
           resource_type, resource_id, purpose_key, statement_id, statement_version, policy_id,
           flow_id, flow_version_id, flow_node_id, 'rejected', NULL, NULL,
           released_scopes_json, released_claims_json, released_attributes_json, 'revoked',
           expires_at, ?, ?, ?, ?
      FROM consent_records
     WHERE tenant_id = ? AND subject_user_id = ? AND id = ? AND status = 'active'
       AND EXISTS (${input.currentStateExistsSql})`,
    params: [
      input.withdrawalRecordId,
      input.userId,
      input.now,
      JSON.stringify({
        source: 'account_page',
        action: 'consent_withdrawn',
        withdrawal_kind: input.withdrawalKind,
        source_record_id: input.sourceRecordId,
      }),
      input.now,
      input.now,
      input.tenantId,
      input.userId,
      input.sourceRecordId,
      ...input.currentStateExistsParams,
    ],
  };
}

export async function withdrawAccountConsentHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) return accountSession;
  if (
    Math.floor(Date.now() / 1000) >=
    accountSession.authTime + ACCOUNT_CONSENT_REAUTH_TTL_SECONDS
  ) {
    return accountConsentReauthRequired(c);
  }

  const kind = c.req.param('kind');
  const recordId = c.req.param('id');
  if (
    !kind ||
    !validWithdrawalKind(kind) ||
    !recordId ||
    recordId.length > ACCOUNT_CONSENT_ID_MAX_LENGTH
  ) {
    return c.json(
      { error: 'invalid_request', error_description: 'Invalid consent withdrawal target' },
      400
    );
  }

  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const now = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  let invalidatedClientId: string | null = null;

  try {
    if (kind === 'oauth_client') {
      const grant = await authCtx.coreAdapter.queryOne<{
        id: string;
        client_id: string;
        scope: string;
      }>(
        `SELECT id, client_id, scope FROM oauth_client_consents
          WHERE tenant_id = ? AND user_id = ? AND id = ? LIMIT 1`,
        [tenantId, accountSession.userId, recordId]
      );
      if (!grant) {
        return c.json({ error: 'not_found', error_description: 'Consent was not found' }, 404);
      }
      const historyId = crypto.randomUUID();
      const scopeSnapshot = JSON.stringify(grant.scope.split(/\s+/u).filter(Boolean));
      const results = await authCtx.coreAdapter.batch([
        {
          sql: `INSERT INTO consent_history (
            id, tenant_id, user_id, client_id, action, scopes_before, scopes_after, created_at
          ) SELECT ?, tenant_id, user_id, client_id, 'revoked', ?, NULL, ?
              FROM oauth_client_consents
             WHERE tenant_id = ? AND user_id = ? AND id = ? AND client_id = ? AND scope = ?`,
          params: [
            historyId,
            scopeSnapshot,
            nowMs,
            tenantId,
            accountSession.userId,
            recordId,
            grant.client_id,
            grant.scope,
          ],
        },
        {
          sql: `DELETE FROM oauth_client_consents
            WHERE tenant_id = ? AND user_id = ? AND id = ? AND client_id = ? AND scope = ?
              AND EXISTS (SELECT 1 FROM consent_history WHERE tenant_id = ? AND id = ?)`,
          params: [
            tenantId,
            accountSession.userId,
            recordId,
            grant.client_id,
            grant.scope,
            tenantId,
            historyId,
          ],
        },
      ]);
      if (results[0]?.rowsAffected !== 1 || results[1]?.rowsAffected !== 1) {
        throw new Error('consent_grant_changed');
      }
      invalidatedClientId = grant.client_id;
    } else {
      const source = await authCtx.coreAdapter.queryOne<ConsentEvidenceIdentityRow>(
        `SELECT id, protocol, consent_kind, statement_id, statement_version, client_id,
                saml_sp_id, recipient_type, recipient_id, status
           FROM consent_records
          WHERE tenant_id = ? AND subject_user_id = ? AND id = ? AND status = 'active' LIMIT 1`,
        [tenantId, accountSession.userId, recordId]
      );
      const expectedDocument = kind === 'document_acceptance';
      const isRelease =
        source?.consent_kind === 'scope_claim_release' ||
        source?.consent_kind === 'attribute_release';
      if (!source || (expectedDocument ? isRelease : !isRelease)) {
        return c.json({ error: 'not_found', error_description: 'Consent was not found' }, 404);
      }

      const withdrawalRecordId = crypto.randomUUID();
      let currentStateExistsSql: string;
      let currentStateExistsParams: unknown[];
      let currentStateStatement: { sql: string; params: unknown[] };
      let expectedCurrentRows: (rowsAffected: number) => boolean = (rowsAffected) =>
        rowsAffected === 1;
      if (kind === 'document_acceptance') {
        currentStateExistsSql = `SELECT 1 FROM document_acknowledgments_current
          WHERE tenant_id = ? AND subject_user_id = ? AND consent_kind = ?
            AND statement_id = ? AND statement_version = ? AND status = 'accepted'`;
        currentStateExistsParams = [
          tenantId,
          accountSession.userId,
          source.consent_kind,
          source.statement_id,
          source.statement_version,
        ];
        currentStateStatement = {
          sql: `UPDATE document_acknowledgments_current
                SET status = 'withdrawn', withdrawn_at = ?, latest_evidence_record_id = ?,
                    updated_at = ?
              WHERE tenant_id = ? AND subject_user_id = ? AND consent_kind = ?
                AND statement_id = ? AND statement_version = ? AND status = 'accepted'
                AND EXISTS (SELECT 1 FROM consent_records
                  WHERE tenant_id = ? AND subject_user_id = ? AND id = ? AND status = 'revoked')`,
          params: [
            now,
            withdrawalRecordId,
            now,
            tenantId,
            accountSession.userId,
            source.consent_kind,
            source.statement_id,
            source.statement_version,
            tenantId,
            accountSession.userId,
            withdrawalRecordId,
          ],
        };
      } else if (source.consent_kind === 'scope_claim_release') {
        const clientId = source.client_id ?? source.recipient_id;
        if (!clientId) throw new Error('consent_target_missing');
        currentStateExistsSql = `SELECT 1 FROM oauth_client_consents
          WHERE tenant_id = ? AND user_id = ? AND client_id = ?`;
        currentStateExistsParams = [tenantId, accountSession.userId, clientId];
        currentStateStatement = {
          sql: `DELETE FROM oauth_client_consents
              WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
          params: [tenantId, accountSession.userId, clientId],
        };
        invalidatedClientId = clientId;
      } else {
        const spId = source.saml_sp_id ?? source.recipient_id;
        if (!spId) throw new Error('consent_target_missing');
        currentStateExistsSql = `SELECT 1 FROM attribute_release_consents
          WHERE tenant_id = ? AND subject_id = ? AND destination_type = 'saml_sp'
            AND destination_id = ? AND consent_state = 'granted'`;
        currentStateExistsParams = [tenantId, accountSession.userId, spId];
        currentStateStatement = {
          sql: `UPDATE attribute_release_consents
                SET consent_state = 'revoked', revoked_at = ?, updated_at = ?
              WHERE tenant_id = ? AND subject_id = ? AND destination_type = 'saml_sp'
                AND destination_id = ? AND consent_state = 'granted'
                AND EXISTS (SELECT 1 FROM consent_records
                  WHERE tenant_id = ? AND subject_user_id = ? AND id = ? AND status = 'revoked')`,
          params: [
            nowMs,
            nowMs,
            tenantId,
            accountSession.userId,
            spId,
            tenantId,
            accountSession.userId,
            withdrawalRecordId,
          ],
        };
        expectedCurrentRows = (rowsAffected) => rowsAffected >= 1;
      }
      const results = await authCtx.coreAdapter.batch([
        buildConsentWithdrawalEvidenceStatement({
          tenantId,
          userId: accountSession.userId,
          sourceRecordId: source.id,
          withdrawalRecordId,
          now,
          withdrawalKind: kind,
          currentStateExistsSql,
          currentStateExistsParams,
        }),
        currentStateStatement,
      ]);
      if (results[0]?.rowsAffected !== 1 || !expectedCurrentRows(results[1]?.rowsAffected ?? 0)) {
        throw new Error('consent_current_state_changed');
      }
    }

    if (invalidatedClientId) {
      await invalidateConsentCache(c.env, accountSession.userId, tenantId, invalidatedClientId);
    }
    await recordAccountOperation(c, {
      userId: accountSession.userId,
      action: 'account.consent.withdrawn',
      resourceType: 'consent',
      resourceId: recordId,
      metadata: { kind },
    });
    return c.json({ ok: true, consent: { id: recordId, kind, status: 'withdrawn' } });
  } catch {
    return c.json(
      { error: 'conflict', error_description: 'Consent changed; reload and try again' },
      409
    );
  }
}
