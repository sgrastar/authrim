/**
 * Information release consent for SAML service providers, as the consent screen (ar-auth
 * `/auth/consent`) and the SAML IdP (ar-saml) share it.
 *
 * The screen only shows what the SAML IdP put on the consent challenge and takes the answer; the
 * request itself (keeping it, resuming it, answering the SP) stays with the IdP. The challenge is
 * one ChallengeStore entry with a state: pending (shown) → decided (the screen's answer, by
 * `decideChallengeRpc`) → consumed (the resumed SAML request, by `consumeChallengeRpc` with
 * `requireDecided`).
 *
 * Every item has a key made from its kind, name and actual format, the same everywhere it is used
 * (challenge, screen, answer, record, the final filter): two attributes of one name in different
 * NameFormats, or the NameID in two formats, are different items. The label shown is apart from it.
 */
import type { InformationReleaseAsk } from './information-release-consent';

export type SamlReleaseItemKind = 'attribute' | 'nameid';

/** The key of a release item (see the file comment). */
export function samlReleaseItemKey(
  item:
    | { kind: 'attribute'; name: string; nameFormat?: string | null }
    | { kind: 'nameid'; format: string }
): string {
  return item.kind === 'attribute'
    ? JSON.stringify(['attribute', item.name, item.nameFormat ?? null])
    : JSON.stringify(['nameid', item.format]);
}

/** One item the SP would be given, as the challenge keeps it and the screen shows it. */
export interface SamlReleaseItem {
  key: string;
  kind: SamlReleaseItemKind;
  /** What the person sees (the Destination Profile's label, the friendly name, or the name). */
  label: string;
  /** Required by the SP: approving the request releases it. */
  required: boolean;
  /** The values, when the SP's setting shows them and they exist before approval. */
  values?: string[];
  /** Made only once approved (a pairwise identifier): never shown, never made for nothing. */
  deferred?: boolean;
}

export const SAML_RELEASE_CONSENT_PURPOSE = 'saml_release_consent';

/** What the SAML IdP puts on the consent challenge. */
export interface SamlReleaseConsentChallengeMetadata {
  protocol: 'saml';
  purpose: typeof SAML_RELEASE_CONSENT_PURPOSE;
  /** The browser session the screen is answered in (the same one the request is answered for). */
  session_id: string;
  /** The stored request: an AuthnRequest's ID, or an IdP-initiated sign-in's pending ID. */
  saml_request_id: string;
  saml_sp_entity_id: string;
  idp_initiated: boolean;
  /** Where the screen sends the person once answered (a path on the IdP's issuer). */
  resume_path: string;
  sp_name: string;
  sp_logo_uri?: string;
  ui_locales?: string;
  /** The information release to ask for; absent when only consent documents are asked. */
  release?: {
    items: SamlReleaseItem[];
    show_values: boolean;
    ask: InformationReleaseAsk;
    purpose_statement_id: string | null;
    /** Identifies what was shown (items, required-ness, purpose version). */
    presentation_key: string;
    /** The withdrawal generation the decision is made under. */
    consent_generation: number;
  };
}

/** The screen's answer, kept on the challenge (`decision`). */
export interface SamlReleaseConsentDecision {
  approved: boolean;
  /** Item keys approved and declined (empty when refused, or when no release was asked). */
  approved_items: string[];
  declined_items: string[];
  /** The revision of the record the answer was written as (none when no release was asked). */
  decision_revision?: number;
  decided_at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function readItems(value: unknown): SamlReleaseItem[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const items: SamlReleaseItem[] = [];
  const keys = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || !isString(entry.key) || keys.has(entry.key)) return null;
    if (entry.kind !== 'attribute' && entry.kind !== 'nameid') return null;
    if (!isString(entry.label) || typeof entry.required !== 'boolean') return null;
    if (
      entry.values !== undefined &&
      (!Array.isArray(entry.values) || !entry.values.every((item) => typeof item === 'string'))
    ) {
      return null;
    }
    keys.add(entry.key);
    items.push({
      key: entry.key,
      kind: entry.kind,
      label: entry.label,
      required: entry.required,
      ...(entry.values ? { values: entry.values } : {}),
      ...(entry.deferred === true ? { deferred: true } : {}),
    });
  }
  return items;
}

/** Read a SAML consent challenge's metadata strictly (null when it is not one, or malformed). */
export function readSamlReleaseConsentChallenge(
  metadata: unknown
): SamlReleaseConsentChallengeMetadata | null {
  if (!isRecord(metadata)) return null;
  if (metadata.protocol !== 'saml' || metadata.purpose !== SAML_RELEASE_CONSENT_PURPOSE) {
    return null;
  }
  if (
    !isString(metadata.session_id) ||
    !isString(metadata.saml_request_id, 512) ||
    !isString(metadata.saml_sp_entity_id) ||
    typeof metadata.idp_initiated !== 'boolean' ||
    !isString(metadata.resume_path, 8192) ||
    !metadata.resume_path.startsWith('/') ||
    metadata.resume_path.startsWith('//') ||
    !isString(metadata.sp_name)
  ) {
    return null;
  }
  let release: SamlReleaseConsentChallengeMetadata['release'];
  if (metadata.release !== undefined) {
    const source = metadata.release;
    if (!isRecord(source)) return null;
    const items = readItems(source.items);
    const ask = source.ask;
    if (
      !items ||
      typeof source.show_values !== 'boolean' ||
      (ask !== 'once' && ask !== 'every_time' && ask !== 'when_items_change') ||
      (source.purpose_statement_id !== null && !isString(source.purpose_statement_id, 128)) ||
      !isString(source.presentation_key, 512) ||
      !Number.isSafeInteger(source.consent_generation)
    ) {
      return null;
    }
    release = {
      items,
      show_values: source.show_values,
      ask,
      purpose_statement_id: source.purpose_statement_id,
      presentation_key: source.presentation_key,
      consent_generation: source.consent_generation as number,
    };
  }
  return {
    protocol: 'saml',
    purpose: SAML_RELEASE_CONSENT_PURPOSE,
    session_id: metadata.session_id,
    saml_request_id: metadata.saml_request_id,
    saml_sp_entity_id: metadata.saml_sp_entity_id,
    idp_initiated: metadata.idp_initiated,
    resume_path: metadata.resume_path,
    sp_name: metadata.sp_name,
    ...(isString(metadata.sp_logo_uri) ? { sp_logo_uri: metadata.sp_logo_uri } : {}),
    ...(isString(metadata.ui_locales, 256) ? { ui_locales: metadata.ui_locales } : {}),
    ...(release ? { release } : {}),
  };
}

/** Read a decision kept on a SAML consent challenge (null when malformed). */
export function readSamlReleaseConsentDecision(value: unknown): SamlReleaseConsentDecision | null {
  if (!isRecord(value) || typeof value.approved !== 'boolean') return null;
  const names = (list: unknown) =>
    Array.isArray(list) && list.every((item) => typeof item === 'string') ? list : null;
  const approved = names(value.approved_items);
  const declined = names(value.declined_items);
  if (!approved || !declined || !Number.isSafeInteger(value.decided_at)) return null;
  if (value.decision_revision !== undefined && !Number.isSafeInteger(value.decision_revision)) {
    return null;
  }
  return {
    approved: value.approved,
    approved_items: approved,
    declined_items: declined,
    ...(value.decision_revision !== undefined
      ? { decision_revision: value.decision_revision as number }
      : {}),
    decided_at: value.decided_at as number,
  };
}
