/**
 * The consent screen (/auth/consent) for a SAML service provider: what the SAML IdP put on the
 * challenge (saml-release-consent.ts in ar-lib-core) is shown, and the answer is decided on the
 * challenge, never used up here. The request itself stays with the SAML IdP: the person is sent
 * back to it (`resume_path`), and it takes the decision once it checked it against the request.
 *
 * The answer is written when it is taken: the consent documents agreed to, and the information
 * release decision (a refusal too: it ends the reuse of an earlier approval) under the withdrawal
 * generation it was asked under, with the record's new revision kept on the challenge.
 */
import type { Context } from 'hono';
import {
  buildIssuerUrl,
  createAccountAuthContextFromHono,
  createPIIContextFromHono,
  findSamlSpReleaseConsent,
  getChallengeStoreByChallengeId,
  getConsentUserInfo,
  getLogger,
  getTenantIdFromContext,
  hashIpAddress,
  isSamlSpReleaseConsentChanged,
  processConsentItemDecisions,
  readSamlReleaseConsentChallenge,
  recordSamlSpReleaseDecision,
  resolveAccountDataContextFromHono,
  StatementConsentAccountReadError,
  type ConsentInformationReleaseScreen,
  type Env,
  type ExtendedConsentScreenData,
  type SamlReleaseConsentChallengeMetadata,
  type SamlReleaseConsentDecision,
} from '@authrim/ar-lib-core';
import {
  changedConsentDocument,
  consentRecordsUnavailable,
  loadConsentScreenItems,
  statementConsentStores,
  statementSnapshotsMatch,
  type DisplayedStatementVersions,
  type SessionBoundConsentChallenge,
} from './consent';
import { loadReleasePurpose } from './consent-release';

function invalidChallenge(c: Context<{ Bindings: Env }>): Response {
  return c.json(
    { error: 'invalid_request', error_description: 'Invalid or expired challenge' },
    400
  );
}

function languageOf(c: Context<{ Bindings: Env }>, metadata: SamlReleaseConsentChallengeMetadata) {
  return (
    metadata.ui_locales?.split(' ')[0] ||
    c.req.header('Accept-Language')?.split(',')[0]?.split('-')[0] ||
    'en'
  );
}

/** GET /auth/consent for a SAML SP's challenge. */
export async function samlConsentGet(
  c: Context<{ Bindings: Env }>,
  challengeId: string,
  challenge: SessionBoundConsentChallenge
): Promise<Response> {
  const metadata = readSamlReleaseConsentChallenge(challenge.metadata);
  if (!metadata) return invalidChallenge(c);
  const tenantId = getTenantIdFromContext(c);
  await resolveAccountDataContextFromHono(c, challenge.userId);
  const account = createAccountAuthContextFromHono(c, tenantId);
  const user = await getConsentUserInfo(
    account.coreAdapter,
    challenge.userId,
    tenantId,
    createPIIContextFromHono(c, tenantId).defaultPiiAdapter
  );
  if (!user) {
    return c.json({ error: 'access_denied', error_description: 'Authentication required' }, 401);
  }
  const language = languageOf(c, metadata);

  let consentItems: ExtendedConsentScreenData['consent_items'];
  try {
    consentItems = await loadConsentScreenItems(c, {
      tenantId,
      clientId: metadata.saml_sp_entity_id,
      targetType: 'saml_sp',
      userId: challenge.userId,
      language,
      defaultLanguage: 'en',
    });
  } catch (error) {
    if (error instanceof StatementConsentAccountReadError) {
      return consentRecordsUnavailable(c, error);
    }
    throw error;
  }

  let informationRelease: ConsentInformationReleaseScreen | undefined;
  if (metadata.release) {
    const release = metadata.release;
    const record = await findSamlSpReleaseConsent(account.coreAdapter, {
      tenantId,
      userId: challenge.userId,
      spEntityId: metadata.saml_sp_entity_id,
      consentGeneration: release.consent_generation,
    });
    const approvedBefore = new Set(record && !record.refused ? record.approved : []);
    const purpose = await loadReleasePurpose(
      c,
      tenantId,
      release.purpose_statement_id,
      language,
      'en'
    );
    informationRelease = {
      items: release.items.map((item) => ({
        name: item.key,
        label: item.label,
        kind: item.kind,
        required: item.required,
        ...(item.required ? {} : { previously_approved: approvedBefore.has(item.key) }),
        ...(item.deferred ? { deferred: true } : {}),
        ...(release.show_values && item.values
          ? { value: item.values.length === 1 ? item.values[0] : item.values }
          : {}),
      })),
      show_values: release.show_values,
      presentation_key: release.presentation_key,
      ...(purpose ? { purpose } : {}),
    };
  }

  const response: ExtendedConsentScreenData = {
    challenge_id: challengeId,
    protocol: 'saml',
    client: {
      client_id: metadata.saml_sp_entity_id,
      client_name: metadata.sp_name,
      ...(metadata.sp_logo_uri ? { logo_uri: metadata.sp_logo_uri } : {}),
      is_trusted: false,
    },
    scopes: [],
    user,
    organizations: [],
    primary_org: null,
    roles: [],
    acting_as: null,
    target_org_id: null,
    features: { org_selector_enabled: false, acting_as_enabled: false, show_roles: false },
    consent_items: consentItems,
    consent_management_enabled: (consentItems?.length ?? 0) > 0,
    consent_language: language,
    ...(informationRelease ? { information_release: informationRelease } : {}),
  };
  return c.json(response);
}

/** POST /auth/consent for a SAML SP's challenge: the answer is decided on the challenge. */
export async function samlConsentPost(
  c: Context<{ Bindings: Env }>,
  challengeId: string,
  challenge: SessionBoundConsentChallenge,
  answer: {
    approved: boolean;
    consentItemDecisions?: Record<string, 'granted' | 'denied'>;
    consentItemVersions?: DisplayedStatementVersions;
    releaseSelected?: string[];
    releasePresentationKey?: string;
  }
): Promise<Response> {
  const log = getLogger(c).module('CONSENT');
  const metadata = readSamlReleaseConsentChallenge(challenge.metadata);
  if (!metadata) return invalidChallenge(c);
  const tenantId = getTenantIdFromContext(c);
  const store = (await getChallengeStoreByChallengeId(c.env, challengeId, tenantId)) as unknown as {
    decideChallengeRpc(request: {
      id: string;
      tenantId: string;
      type: 'consent';
      operationId: string;
      decision: Record<string, unknown>;
      replaceOwn?: boolean;
    }): Promise<{ outcome: 'decided' | 'conflict' | 'gone' }>;
  };
  const resumeUrl = new URL(metadata.resume_path, buildIssuerUrl(c.env, tenantId)).toString();
  // An answer already taken (another tab, a resend): the SAML request goes on with that one.
  if ((challenge as { decision?: unknown }).decision) {
    return c.json({ redirect_url: resumeUrl });
  }
  await resolveAccountDataContextFromHono(c, challenge.userId);
  const account = createAccountAuthContextFromHono(c, tenantId).coreAdapter;
  const operationId = crypto.randomUUID();
  const now = Date.now();
  const release = metadata.release;

  const decide = (decision: SamlReleaseConsentDecision, replaceOwn = false) =>
    store.decideChallengeRpc({
      id: challengeId,
      tenantId,
      type: 'consent',
      operationId,
      decision: decision as unknown as Record<string, unknown>,
      ...(replaceOwn ? { replaceOwn: true } : {}),
    });
  const historyOf = { userAgent: c.req.header('User-Agent') ?? null };

  try {
    // What the answer decides, checked before anything is written.
    let consentItems: Awaited<ReturnType<typeof loadConsentScreenItems>> = [];
    let itemDecisions: Record<string, 'granted' | 'denied'> = {};
    let approvedItems: string[] = [];
    let declinedItems: string[] = [];
    if (answer.approved) {
      // The documents shown must be the ones asked for now, and every required one agreed to.
      consentItems = await loadConsentScreenItems(c, {
        tenantId,
        clientId: metadata.saml_sp_entity_id,
        targetType: 'saml_sp',
        userId: challenge.userId,
        language: 'en',
        defaultLanguage: 'en',
      });
      if (!statementSnapshotsMatch(consentItems, answer.consentItemVersions)) {
        return await changedConsentDocument(c, challenge, false);
      }
      // The information release is taken only for what was shown.
      if (release && answer.releasePresentationKey !== release.presentation_key) {
        return await changedConsentDocument(c, challenge, false);
      }
      const submitted = answer.consentItemDecisions ?? {};
      itemDecisions = Object.fromEntries(
        consentItems.map((item) => {
          const given = submitted[item.statement_id];
          return [
            item.statement_id,
            given === 'granted' || given === 'denied'
              ? given
              : item.checkbox_mode === 'none'
                ? 'granted'
                : 'denied',
          ];
        })
      );
      if (
        consentItems.some(
          (item) =>
            item.is_required &&
            item.enforcement === 'block' &&
            itemDecisions[item.statement_id] !== 'granted'
        )
      ) {
        return c.json(
          {
            error: 'consent_required',
            error_description: 'Required consent items must be granted',
          },
          400
        );
      }
      if (release) {
        const selected = new Set(answer.releaseSelected ?? []);
        approvedItems = release.items
          .filter((item) => item.required || selected.has(item.key))
          .map((item) => item.key);
        declinedItems = release.items
          .filter((item) => !item.required && !selected.has(item.key))
          .map((item) => item.key);
      }
    }

    // One answer wins: it claims the challenge before it writes anything, so an answer that lost
    // (another tab, a resend) records nothing. The claim carries no revision yet: until it is
    // completed below, the SAML request takes no approval from it (a refusal stands as claimed).
    const claimed = await decide({
      approved: answer.approved,
      approved_items: approvedItems,
      declined_items: declinedItems,
      decided_at: now,
    });
    if (claimed.outcome === 'gone') return invalidChallenge(c);
    if (claimed.outcome === 'conflict') return c.json({ redirect_url: resumeUrl });

    if (answer.approved && consentItems.length > 0) {
      const ipAddress = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
      try {
        await processConsentItemDecisions(
          statementConsentStores(c, tenantId),
          tenantId,
          challenge.userId,
          itemDecisions,
          {
            ip_address: ipAddress || undefined,
            user_agent: c.req.header('User-Agent'),
            client_id: metadata.saml_sp_entity_id,
          },
          ipAddress ? await hashIpAddress(ipAddress, tenantId, c.env.KV ?? null, c.env) : undefined,
          Object.fromEntries(
            consentItems.map((item) => [
              item.statement_id,
              {
                version_id: item.version_id,
                version: item.version,
                content_hash: item.content_hash ?? null,
                withdrawal_allowed: item.withdrawal_allowed,
              },
            ])
          ),
          { env: c.env }
        );
      } catch (error) {
        if (
          error instanceof Error &&
          ['document_changed', 'statement_consent_transition_rejected'].includes(error.message)
        ) {
          return await changedConsentDocument(c, challenge, false);
        }
        throw error;
      }
    }
    if (release) {
      // The decision is kept (a refusal too: an earlier approval no longer answers the next
      // request), and the claim completed with the record's revision.
      const { revision } = await recordSamlSpReleaseDecision(account, {
        tenantId,
        userId: challenge.userId,
        spEntityId: metadata.saml_sp_entity_id,
        consentGeneration: release.consent_generation,
        decision: {
          presented: release.items.map((item) => item.key),
          approved: approvedItems,
          declined: answer.approved ? declinedItems : release.items.map((item) => item.key),
          mode: release.ask,
          basis: 'user',
          refused: !answer.approved,
        },
        operationId,
        now,
        history: historyOf,
      });
      await decide(
        {
          approved: answer.approved,
          approved_items: approvedItems,
          declined_items: declinedItems,
          decision_revision: revision,
          decided_at: now,
        },
        true
      );
    }
  } catch (error) {
    if (error instanceof StatementConsentAccountReadError) {
      return consentRecordsUnavailable(c, error);
    }
    if (isSamlSpReleaseConsentChanged(error)) {
      return c.json(
        {
          error: 'consent_withdrawn',
          error_description:
            'Consent for this service changed while it was being answered. Start again.',
        },
        409
      );
    }
    log.error('SAML consent post error', { action: 'post_consent' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to process consent' }, 500);
  }
  return c.json({ redirect_url: resumeUrl });
}
