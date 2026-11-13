/**
 * Whether a SAML request may be answered with the information its SP would be given, or the person
 * is asked first on the consent screen shared with OIDC (ar-auth `/auth/consent`, the Login UI's
 * consent page). Used by SP-initiated (sso.ts) and IdP-initiated (idp-initiated.ts) sign-ins.
 *
 * Asked: the consent documents the SP's sign-in Flow requires at single sign-on that the person
 * has not agreed to, and the information release (saml-release-consent.ts in ar-lib-core) unless
 * the SP is trusted, its setting does not ask (its required items go), or the person's last
 * decision still answers today's items. The answer comes back on the consent challenge: the
 * request resumes, the decision is checked against the request, the person, the session, today's
 * items and the current record, and the challenge is used up once.
 */
import type { Context } from 'hono';
import type {
  DatabaseAdapter,
  Env,
  NameIDFormat,
  SAMLSPConfig,
  SamlReleaseConsentChallengeMetadata,
  SamlReleaseItem,
} from '@authrim/ar-lib-core';
import {
  automaticReleaseApproval,
  buildIssuerUrl,
  checkUserConsentSatisfaction,
  findSamlSpReleaseConsent,
  findSamlSpReleaseConsentGeneration,
  getChallengeStoreByChallengeId,
  getUIConfig,
  readInformationReleaseConsentSetting,
  readSamlReleaseConsentChallenge,
  readSamlReleaseConsentDecision,
  recordSamlSpReleaseDecision,
  releasePresentationKey,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveClientTrustPolicy,
  resolveStatementRequirements,
  reusableReleaseApproval,
  SAML_RELEASE_CONSENT_PURPOSE,
  ssoConsentStatementsForTarget,
} from '@authrim/ar-lib-core';
import { getSAMLInteractiveLoginUrlPolicy } from '../common/entity-id';
import { getSamlUserCoreAdapter, type SAMLUserInfo } from '../common/user-store';
import { samlReleaseItems, type SAMLAttributeRelease } from './release-items';

/** How long the person has to answer the consent screen (never past the request's own end). */
const CONSENT_CHALLENGE_TTL_SECONDS = 10 * 60;

export type SAMLReleaseConsentOutcome =
  /** Answer with this approval (item keys, or the approve-all / required-only markers). */
  | { kind: 'issue'; approval: string[]; consentGeneration: number }
  /** Send the person to the consent screen. */
  | { kind: 'ask'; challengeId: string; consentUrl: string }
  /** The person refused on the consent screen. */
  | { kind: 'refused' }
  /** The request may not show a screen (IsPassive), and one is needed. */
  | { kind: 'no_passive' }
  /**
   * The runtime cannot show the consent screen (the AWS runtime) and one is needed: the request
   * is refused rather than answered without it.
   */
  | { kind: 'screen_unavailable' };

interface ResolveInput {
  c: Context<{ Bindings: Env }>;
  env: Env;
  tenantId: string;
  spConfig: SAMLSPConfig;
  userInfo: SAMLUserInfo;
  session: { userId: string; sessionId: string };
  release: SAMLAttributeRelease;
  nameIdFormat: NameIDFormat;
  isPassive: boolean;
  /** The stored request: an AuthnRequest's ID, or an IdP-initiated sign-in's pending ID. */
  requestId: string;
  idpInitiated: boolean;
  /** Where the consent screen sends the person once answered (a path on the issuer). */
  resumePath: string;
  /** The consent challenge the stored request waits for, if it sent the person to one. */
  pendingChallengeId?: string;
  /** The request's own end (ms): the screen never outlives it. */
  notAfterMs: number;
  /**
   * Operation id for using the challenge up, so a lost answer can be recognised as this
   * request's own.
   */
  operationId: string;
}

async function metadataAdapter(env: Env, tenantId: string): Promise<DatabaseAdapter> {
  return resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-release-consent', { tenantId });
}

/** The consent documents the SP's sign-in Flow requires at SSO that the person has not agreed to. */
async function unansweredDocuments(
  metadata: DatabaseAdapter,
  account: DatabaseAdapter,
  input: { tenantId: string; spEntityId: string; userId: string }
): Promise<string[]> {
  const requirements = await resolveStatementRequirements(
    metadata,
    input.tenantId,
    await ssoConsentStatementsForTarget(metadata, input.tenantId, {
      type: 'saml_sp',
      id: input.spEntityId,
    })
  );
  if (requirements.length === 0) return [];
  const { unsatisfied } = await checkUserConsentSatisfaction(
    account,
    input.tenantId,
    input.userId,
    requirements
  );
  return unsatisfied;
}

async function purposeVersion(
  metadata: DatabaseAdapter,
  tenantId: string,
  statementId: string | null
): Promise<string | null> {
  if (!statementId) return null;
  const row = await metadata.queryOne<{ version: string }>(
    `SELECT version FROM consent_statement_versions
      WHERE tenant_id = ? AND statement_id = ? AND is_current = 1`,
    [tenantId, statementId]
  );
  return row?.version ?? null;
}

function sameItems(
  shown: readonly SamlReleaseItem[],
  current: readonly SamlReleaseItem[]
): boolean {
  if (shown.length !== current.length) return false;
  const required = new Map(current.map((item) => [item.key, item.required]));
  return shown.every((item) => required.get(item.key) === item.required);
}

type ChallengeStoreStub = {
  getChallengeRpc(id: string): Promise<{
    id: string;
    tenantId: string;
    type: string;
    userId: string;
    consumed: boolean;
    metadata?: Record<string, unknown>;
    decision?: Record<string, unknown>;
  } | null>;
  storeChallengeRpc(request: Record<string, unknown>): Promise<unknown>;
  consumeChallengeRpc(request: Record<string, unknown>): Promise<unknown>;
};

async function challengeStore(env: Env, tenantId: string, id: string): Promise<ChallengeStoreStub> {
  const store = (await getChallengeStoreByChallengeId(env, id, tenantId)) as ChallengeStoreStub;
  return store;
}

/** The consent page's URL for a challenge (the Login UI, or the tenant's own host). */
async function consentPageUrl(env: Env, tenantId: string, challengeId: string): Promise<string> {
  const uiConfig = await getUIConfig(env, tenantId);
  if (!uiConfig?.baseUrl) throw new Error('saml_consent_ui_not_configured');
  const policy = await getSAMLInteractiveLoginUrlPolicy(env, tenantId);
  const base = policy === 'tenant_host' ? buildIssuerUrl(env, tenantId) : uiConfig.baseUrl;
  const url = new URL(uiConfig.paths?.consent || '/consent', base);
  url.searchParams.set('challenge_id', challengeId);
  if (policy === 'ui_base_url' && tenantId) url.searchParams.set('tenant_hint', tenantId);
  return url.toString();
}

/**
 * Decide how the request goes on (see the file comment). Throws when what it needs cannot be read:
 * nothing is released on a guess.
 */
export async function resolveSAMLReleaseConsent(
  input: ResolveInput
): Promise<SAMLReleaseConsentOutcome> {
  const { env, tenantId, spConfig, session } = input;
  const metadata = await metadataAdapter(env, tenantId);
  const account = await getSamlUserCoreAdapter(env, tenantId, session.userId);
  const key = { tenantId, userId: session.userId, spEntityId: spConfig.entityId };
  const consentGeneration = await findSamlSpReleaseConsentGeneration(account, key);
  const setting = readInformationReleaseConsentSetting(spConfig.informationReleaseConsent);
  const trust = await resolveClientTrustPolicy(metadata, tenantId, 'saml_sp', spConfig.entityId);
  const trusted = Boolean(trust?.trusted || trust?.skip_authorization_consent);
  const documents = await unansweredDocuments(metadata, account, {
    tenantId,
    spEntityId: spConfig.entityId,
    userId: session.userId,
  });
  const items = samlReleaseItems(input.release, {
    nameIdFormat: input.nameIdFormat,
    userInfo: input.userInfo,
    showValues: setting.show_values,
  });
  const candidates = items.map((item) => ({ name: item.key, required: item.required }));
  const purpose = setting.enabled
    ? await purposeVersion(metadata, tenantId, setting.purpose_statement_id)
    : null;
  const presentationKey = await releasePresentationKey(candidates, purpose);

  // The answer the person gave on the screen this request sent them to.
  if (input.pendingChallengeId) {
    const answered = await takeAnsweredChallenge(input, {
      account,
      consentGeneration,
      documents,
      items,
      presentationKey,
    });
    if (answered) return answered;
  }

  const automatic = env.SAML_RUNTIME_PORTS
    ? // This runtime admits imported trusted SPs only; anything else is never released unasked.
      trusted
      ? { approval: ['*'] }
      : null
    : automaticReleaseApproval(setting, trusted);
  let approval = automatic?.approval ?? null;
  if (!approval && !env.SAML_RUNTIME_PORTS) {
    const record = await findSamlSpReleaseConsent(account, { ...key, consentGeneration });
    approval =
      record && !record.refused ? reusableReleaseApproval(setting, record, candidates) : null;
  }
  if (approval && documents.length === 0) {
    return { kind: 'issue', approval, consentGeneration };
  }
  if (input.isPassive) return { kind: 'no_passive' };
  if (env.SAML_RUNTIME_PORTS) return { kind: 'screen_unavailable' };

  const challengeId = crypto.randomUUID();
  const challenge: SamlReleaseConsentChallengeMetadata = {
    protocol: 'saml',
    purpose: SAML_RELEASE_CONSENT_PURPOSE,
    session_id: session.sessionId,
    saml_request_id: input.requestId,
    saml_sp_entity_id: spConfig.entityId,
    idp_initiated: input.idpInitiated,
    resume_path: input.resumePath,
    sp_name: spConfig.displayName || spConfig.entityId,
    ...(spConfig.logoUrl ? { sp_logo_uri: spConfig.logoUrl } : {}),
    ...(approval
      ? {}
      : {
          release: {
            items,
            show_values: setting.show_values,
            ask: setting.ask,
            purpose_statement_id: setting.purpose_statement_id,
            presentation_key: presentationKey,
            consent_generation: consentGeneration,
          },
        }),
  };
  const store = await challengeStore(env, tenantId, challengeId);
  await store.storeChallengeRpc({
    id: challengeId,
    tenantId,
    type: 'consent',
    userId: session.userId,
    challenge: challengeId,
    ttl: CONSENT_CHALLENGE_TTL_SECONDS,
    notAfterMs: input.notAfterMs,
    metadata: challenge,
  });
  return {
    kind: 'ask',
    challengeId,
    consentUrl: await consentPageUrl(env, tenantId, challengeId),
  };
}

/**
 * The decision on the challenge the request sent the person to, when it can be taken: the person
 * refused, or approved what is still asked today under the current record. Null when there is
 * none to take (not answered, not this request's, or no longer matching): the person is asked
 * again.
 */
async function takeAnsweredChallenge(
  input: ResolveInput,
  now: {
    account: DatabaseAdapter;
    consentGeneration: number;
    documents: string[];
    items: SamlReleaseItem[];
    presentationKey: string;
  }
): Promise<SAMLReleaseConsentOutcome | null> {
  const id = input.pendingChallengeId as string;
  const store = await challengeStore(input.env, input.tenantId, id);
  const stored = await store.getChallengeRpc(id);
  const metadata = readSamlReleaseConsentChallenge(stored?.metadata);
  const decision = readSamlReleaseConsentDecision(stored?.decision);
  if (
    !stored ||
    stored.consumed ||
    stored.type !== 'consent' ||
    stored.tenantId !== input.tenantId ||
    stored.userId !== input.session.userId ||
    !metadata ||
    !decision ||
    metadata.session_id !== input.session.sessionId ||
    metadata.saml_request_id !== input.requestId ||
    metadata.saml_sp_entity_id !== input.spConfig.entityId ||
    metadata.idp_initiated !== input.idpInitiated
  ) {
    return null;
  }

  const consume = async () => {
    await store.consumeChallengeRpc({
      id,
      tenantId: input.tenantId,
      type: 'consent',
      challenge: id,
      requireDecided: true,
      operationId: input.operationId,
    });
  };
  // A refusal ends this request, whatever changed since.
  if (!decision.approved) {
    await consume();
    // The screen claimed the refusal but could not keep it (its write failed): it is kept now, so
    // an earlier approval no longer answers the next request. Best effort: the request is refused
    // either way.
    if (metadata.release && decision.decision_revision === undefined) {
      const items = metadata.release.items.map((item) => item.key);
      await recordSamlSpReleaseDecision(now.account, {
        tenantId: input.tenantId,
        userId: input.session.userId,
        spEntityId: input.spConfig.entityId,
        consentGeneration: metadata.release.consent_generation,
        decision: {
          presented: items,
          approved: [],
          declined: items,
          mode: metadata.release.ask,
          basis: 'user',
          refused: true,
        },
        operationId: input.operationId,
        now: decision.decided_at,
      }).catch(() => undefined);
    }
    return { kind: 'refused' };
  }
  // The documents are recorded by the screen; one still not agreed to is asked again.
  if (now.documents.length > 0) return null;
  let approval: string[] | null = null;
  if (metadata.release) {
    const record = await findSamlSpReleaseConsent(now.account, {
      tenantId: input.tenantId,
      userId: input.session.userId,
      spEntityId: input.spConfig.entityId,
      consentGeneration: now.consentGeneration,
    });
    // Taken only for what was shown and is still asked, and while the decision written for it is
    // the current one (a later decision, or a withdrawal, wins).
    if (
      metadata.release.consent_generation !== now.consentGeneration ||
      metadata.release.presentation_key !== now.presentationKey ||
      !sameItems(metadata.release.items, now.items) ||
      !record ||
      record.refused ||
      decision.decision_revision === undefined ||
      record.revision !== decision.decision_revision
    ) {
      return null;
    }
    const current = new Set(now.items.map((item) => item.key));
    approval = decision.approved_items.filter((key) => current.has(key));
  }
  await consume();
  if (approval) return { kind: 'issue', approval, consentGeneration: now.consentGeneration };
  // Only documents were asked: the release is decided as for a request that was not asked.
  return null;
}

/**
 * Whether the person's information release consent is still under the generation the release
 * was decided under: checked last before the request is completed and answered (a withdrawal
 * since then issues nothing).
 */
export async function samlReleaseConsentStillCurrent(
  env: Env,
  input: { tenantId: string; userId: string; spEntityId: string; consentGeneration: number }
): Promise<boolean> {
  const account = await getSamlUserCoreAdapter(env, input.tenantId, input.userId);
  return (await findSamlSpReleaseConsentGeneration(account, input)) === input.consentGeneration;
}
