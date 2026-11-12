/**
 * The information release part of the consent screen (/auth/consent): what the app would be
 * given about the user, shown for approval, and the decision taken from the answer. The approval
 * goes on to /authorize with the consent confirmation, and from there into the code and tokens
 * (information-release-consent.ts).
 */
import type { Context } from 'hono';
import {
  findReleaseConsentRecord,
  getClientCached,
  getLocalization,
  readInformationReleaseConsentSetting,
  releasePresentationKey,
  RELEASE_APPROVE_REQUIRED,
  createAuthContextFromHono,
  createAccountAuthContextFromHono,
  parseClaimsRequest,
  type ConsentChallengeMetadata,
  type ConsentInformationReleaseScreen,
  type Env,
  type InformationReleaseConsentSetting,
  type OAuthClientReleaseDecision,
  type ReleaseCandidate,
} from '@authrim/ar-lib-core';
import { computeReleaseCandidates } from './release-candidates';

interface ReleaseContext {
  c: Context<{ Bindings: Env }>;
  tenantId: string;
  userId: string;
  clientId: string;
  metadata: ConsentChallengeMetadata;
}

function scopesOf(value: string | undefined): string[] {
  return (value ?? '').split(' ').filter(Boolean);
}

function isIdTokenOnly(responseType: string | undefined): boolean {
  const types = scopesOf(responseType);
  return types.includes('id_token') && !types.includes('token') && !types.includes('code');
}

async function candidatesFor(
  context: ReleaseContext,
  scopes: string[]
): Promise<{
  setting: InformationReleaseConsentSetting;
  candidates: ReleaseCandidate[];
  values: Record<string, unknown>;
} | null> {
  const clientMetadata = await getClientCached(context.c, context.c.env, context.clientId);
  if (!clientMetadata) return null;
  const setting = readInformationReleaseConsentSetting(clientMetadata.information_release_consent);
  if (!setting.enabled) return { setting, candidates: [], values: {} };
  const metadata = context.metadata as ConsentChallengeMetadata & Record<string, unknown>;
  const parsed = parseClaimsRequest(metadata.claims);
  const release = await computeReleaseCandidates({
    c: context.c,
    tenantId: context.tenantId,
    userId: context.userId,
    clientId: context.clientId,
    clientMetadata,
    scopes,
    claimsRequest: parsed.request,
    claimsRequestProtected: metadata.authorization_request_integrity_protected === true,
    idTokenOnly: isIdTokenOnly(metadata.response_type),
  });
  return { setting, ...release };
}

async function purposeOf(
  context: ReleaseContext,
  setting: InformationReleaseConsentSetting,
  language: string,
  defaultLanguage: string
): Promise<ConsentInformationReleaseScreen['purpose'] | undefined> {
  if (!setting.purpose_statement_id) return undefined;
  const metadata = createAuthContextFromHono(context.c, context.tenantId).coreAdapter;
  const version = await metadata.queryOne<{ id: string; version: string }>(
    `SELECT id, version FROM consent_statement_versions
      WHERE tenant_id = ? AND statement_id = ? AND is_current = 1`,
    [context.tenantId, setting.purpose_statement_id]
  );
  if (!version) return undefined;
  const localization = await getLocalization(
    metadata,
    context.tenantId,
    version.id,
    language,
    defaultLanguage
  );
  return {
    statement_id: setting.purpose_statement_id,
    version: version.version,
    title: localization?.title || setting.purpose_statement_id,
    ...(localization?.description ? { description: localization.description } : {}),
    document_url: localization?.document_url ?? null,
    inline_content: localization?.inline_content ?? null,
  };
}

/**
 * The information release the screen shows for this request, or undefined when the app does not
 * ask (its setting is off, or it would be given nothing about the user).
 */
export async function loadInformationReleaseScreen(
  context: ReleaseContext & { language: string; defaultLanguage: string; consentGeneration: number }
): Promise<ConsentInformationReleaseScreen | undefined> {
  const found = await candidatesFor(context, scopesOf(context.metadata.scope));
  if (!found || !found.setting.enabled || found.candidates.length === 0) return undefined;
  const { setting, candidates, values } = found;
  const purpose = await purposeOf(context, setting, context.language, context.defaultLanguage);
  const record = await findReleaseConsentRecord(
    createAccountAuthContextFromHono(context.c, context.tenantId).coreAdapter,
    {
      tenantId: context.tenantId,
      userId: context.userId,
      clientId: context.clientId,
      consentGeneration: context.consentGeneration,
    }
  );
  const approvedBefore = new Set(record?.basis === 'user' ? record.approved : []);
  return {
    items: candidates.map((item) => ({
      name: item.name,
      required: item.required,
      ...(item.required ? {} : { previously_approved: approvedBefore.has(item.name) }),
      ...(setting.show_values ? { value: values[item.name] } : {}),
    })),
    show_values: setting.show_values,
    presentation_key: await releasePresentationKey(candidates, purpose?.version ?? null),
    ...(purpose ? { purpose } : {}),
  };
}

/** The approval taken from the answer, or why it cannot be taken. */
export type InformationReleaseAnswer =
  | { ok: true; approval: string[]; decision: OAuthClientReleaseDecision | null }
  | { ok: false; reason: 'changed' };

/**
 * Take the answer to the information release the screen showed. The answer is taken only for
 * what was shown (the presentation key, recomputed now); the approval is made for the scopes
 * the user kept (`effectiveScopes`): its required items, and the optional ones the user chose.
 */
export async function answerInformationRelease(
  context: ReleaseContext & {
    effectiveScopes: string[];
    selected: readonly string[] | undefined;
    presentationKey: string | undefined;
  }
): Promise<InformationReleaseAnswer> {
  const shown = await candidatesFor(context, scopesOf(context.metadata.scope));
  if (!shown) return { ok: true, approval: [], decision: null };
  const { setting } = shown;
  // Not asked: its required items go. What the user decided before is replaced (not asked is
  // recorded), so turning the setting on again asks them rather than reusing an old answer.
  if (!setting.enabled) {
    return {
      ok: true,
      approval: [RELEASE_APPROVE_REQUIRED],
      decision: {
        presented: [],
        approved: [],
        declined: [],
        mode: setting.ask,
        basis: 'not_asked',
      },
    };
  }
  // Nothing about the user to give now: nothing is approved (information the user adds later is
  // asked for then), and the empty answer is kept so the next authorization is not asked again.
  if (shown.candidates.length === 0) {
    return {
      ok: true,
      approval: [],
      decision: { presented: [], approved: [], declined: [], mode: setting.ask, basis: 'user' },
    };
  }
  const purpose = await purposeOf(context, setting, 'en', 'en');
  const key = await releasePresentationKey(shown.candidates, purpose?.version ?? null);
  if (context.presentationKey !== key) return { ok: false, reason: 'changed' };

  const kept =
    context.effectiveScopes.join(' ') === scopesOf(context.metadata.scope).join(' ')
      ? shown
      : await candidatesFor(context, context.effectiveScopes);
  const candidates = kept?.candidates ?? [];
  const selected = new Set(context.selected ?? []);
  const approved = candidates
    .filter((item) => item.required || selected.has(item.name))
    .map((item) => item.name);
  const declined = candidates
    .filter((item) => !item.required && !selected.has(item.name))
    .map((item) => item.name);
  return {
    ok: true,
    approval: approved,
    decision: {
      presented: shown.candidates.map((item) => item.name),
      approved,
      declined,
      mode: setting.ask,
      basis: 'user',
    },
  };
}
