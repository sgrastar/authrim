import type { Env, SAMLSigningKeyPolicy } from '@authrim/ar-lib-core';
import { buildIssuerUrl } from '@authrim/ar-lib-core';
import {
  DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT,
  type SAMLSigningCertificateSubjectAlternativeNames,
  type SAMLSigningCertificateSubject,
} from './key-utils';

export type SAMLEntityIdStyle = 'role_url' | 'metadata_url';
export type SAMLInteractiveLoginUrlPolicy = 'tenant_host' | 'ui_base_url';
export type SAMLLocalRole = 'idp' | 'sp';

export interface SAMLPublicSettings {
  entityIdStyle: SAMLEntityIdStyle;
  interactiveLoginUrlPolicy: SAMLInteractiveLoginUrlPolicy;
  certificateSubject: Required<SAMLSigningCertificateSubject>;
  certificateSubjectAlternativeNames: SAMLSigningCertificateSubjectAlternativeNameSettings;
  signingKeyPolicies: {
    idp?: SAMLSigningKeyPolicy;
    sp?: SAMLSigningKeyPolicy;
  };
}

export interface SAMLSigningCertificateSubjectAlternativeNameSettings {
  includeGeneratedDnsNames: boolean;
  dnsNames: string[];
}

export interface SAMLLocalEntityIds {
  issuerUrl: string;
  entityIdStyle: SAMLEntityIdStyle;
  idpEntityId: string;
  spEntityId: string;
  idpMetadataUrl: string;
  spMetadataUrl: string;
}

export const DEFAULT_SAML_ENTITY_ID_STYLE: SAMLEntityIdStyle = 'metadata_url';
export const DEFAULT_SAML_INTERACTIVE_LOGIN_URL_POLICY: SAMLInteractiveLoginUrlPolicy =
  'tenant_host';
export const SAML_TENANT_SETTINGS_CATEGORY = 'saml';

export function normalizeSAMLEntityIdStyle(value: unknown): SAMLEntityIdStyle | null {
  return value === 'role_url' || value === 'metadata_url' ? value : null;
}

export function normalizeSAMLInteractiveLoginUrlPolicy(
  value: unknown
): SAMLInteractiveLoginUrlPolicy | null {
  return value === 'tenant_host' || value === 'ui_base_url' ? value : null;
}

export function buildSAMLSettingsKey(tenantId: string): string {
  return `settings:tenant:${tenantId}:${SAML_TENANT_SETTINGS_CATEGORY}`;
}

export function buildSAMLEntityIdFromIssuerUrl(
  issuerUrl: string,
  role: SAMLLocalRole,
  style: SAMLEntityIdStyle
): string {
  const roleUrl = `${issuerUrl}/saml/${role}`;
  return style === 'metadata_url' ? `${roleUrl}/metadata` : roleUrl;
}

export function buildSAMLMetadataUrlFromIssuerUrl(issuerUrl: string, role: SAMLLocalRole): string {
  return `${issuerUrl}/saml/${role}/metadata`;
}

export async function getSAMLEntityIdStyle(env: Env, tenantId: string): Promise<SAMLEntityIdStyle> {
  const envStyle = normalizeSAMLEntityIdStyle(env.SAML_ENTITY_ID_STYLE);
  if (envStyle) {
    return envStyle;
  }

  const storedSettings = await readStoredSAMLSettings(env, tenantId);
  return storedSettings.entityIdStyle;
}

export async function getSAMLInteractiveLoginUrlPolicy(
  env: Env,
  tenantId: string
): Promise<SAMLInteractiveLoginUrlPolicy> {
  const envPolicy = normalizeSAMLInteractiveLoginUrlPolicy(env.SAML_INTERACTIVE_LOGIN_URL_POLICY);
  if (envPolicy) {
    return envPolicy;
  }

  const storedSettings = await readStoredSAMLSettings(env, tenantId);
  return storedSettings.interactiveLoginUrlPolicy;
}

export async function getSAMLPublicSettings(
  env: Env,
  tenantId: string
): Promise<SAMLPublicSettings> {
  const storedSettings = await readStoredSAMLSettings(env, tenantId);
  return {
    entityIdStyle:
      normalizeSAMLEntityIdStyle(env.SAML_ENTITY_ID_STYLE) ?? storedSettings.entityIdStyle,
    interactiveLoginUrlPolicy:
      normalizeSAMLInteractiveLoginUrlPolicy(env.SAML_INTERACTIVE_LOGIN_URL_POLICY) ??
      storedSettings.interactiveLoginUrlPolicy,
    certificateSubject: storedSettings.certificateSubject,
    certificateSubjectAlternativeNames: storedSettings.certificateSubjectAlternativeNames,
    signingKeyPolicies: storedSettings.signingKeyPolicies,
  };
}

export async function putSAMLPublicSettings(
  env: Env,
  tenantId: string,
  settings: Partial<SAMLPublicSettings> &
    Pick<SAMLPublicSettings, 'entityIdStyle' | 'interactiveLoginUrlPolicy'>
): Promise<void> {
  if (!env.SETTINGS) {
    throw new Error('SETTINGS KV binding is required to update SAML settings');
  }

  const before = await readStoredSAMLSettings(env, tenantId);
  await env.SETTINGS.put(
    buildSAMLSettingsKey(tenantId),
    JSON.stringify({
      entityIdStyle: settings.entityIdStyle,
      interactiveLoginUrlPolicy: settings.interactiveLoginUrlPolicy,
      certificateSubject: settings.certificateSubject ?? before.certificateSubject,
      certificateSubjectAlternativeNames:
        settings.certificateSubjectAlternativeNames ?? before.certificateSubjectAlternativeNames,
      signingKeyPolicies: settings.signingKeyPolicies ?? before.signingKeyPolicies,
      updatedAt: Date.now(),
    })
  );
}

export async function putSAMLLocalSigningSettings(
  env: Env,
  tenantId: string,
  settings: Pick<
    SAMLPublicSettings,
    'certificateSubject' | 'certificateSubjectAlternativeNames' | 'signingKeyPolicies'
  >
): Promise<SAMLPublicSettings> {
  if (!env.SETTINGS) {
    throw new Error('SETTINGS KV binding is required to update SAML signing settings');
  }
  const before = await readStoredSAMLSettings(env, tenantId);
  const next: SAMLPublicSettings = {
    ...before,
    certificateSubject: settings.certificateSubject,
    certificateSubjectAlternativeNames: settings.certificateSubjectAlternativeNames,
    signingKeyPolicies: settings.signingKeyPolicies,
  };
  await env.SETTINGS.put(
    buildSAMLSettingsKey(tenantId),
    JSON.stringify({
      ...next,
      updatedAt: Date.now(),
    })
  );
  return next;
}

export async function getSAMLLocalEntityIds(
  env: Env,
  tenantId: string
): Promise<SAMLLocalEntityIds> {
  const issuerUrl = buildIssuerUrl(env, tenantId);
  const entityIdStyle = await getSAMLEntityIdStyle(env, tenantId);
  return {
    issuerUrl,
    entityIdStyle,
    idpEntityId: buildSAMLEntityIdFromIssuerUrl(issuerUrl, 'idp', entityIdStyle),
    spEntityId: buildSAMLEntityIdFromIssuerUrl(issuerUrl, 'sp', entityIdStyle),
    idpMetadataUrl: buildSAMLMetadataUrlFromIssuerUrl(issuerUrl, 'idp'),
    spMetadataUrl: buildSAMLMetadataUrlFromIssuerUrl(issuerUrl, 'sp'),
  };
}

export function buildSAMLSigningCertificateSubjectAlternativeNames(
  entityIds: SAMLLocalEntityIds,
  role: SAMLLocalRole,
  settings: SAMLSigningCertificateSubjectAlternativeNameSettings
): SAMLSigningCertificateSubjectAlternativeNames {
  const generatedUrls =
    role === 'idp'
      ? [
          entityIds.idpEntityId,
          entityIds.idpMetadataUrl,
          `${entityIds.issuerUrl}/saml/idp/sso`,
          `${entityIds.issuerUrl}/saml/idp/slo`,
        ]
      : [
          entityIds.spEntityId,
          entityIds.spMetadataUrl,
          `${entityIds.issuerUrl}/saml/sp/acs`,
          `${entityIds.issuerUrl}/saml/sp/slo`,
        ];
  const generatedNames = settings.includeGeneratedDnsNames
    ? generatedUrls.map(extractDnsNameFromUrl).filter((name): name is string => Boolean(name))
    : [];
  return {
    dnsNames: uniqueDnsNames([...generatedNames, ...settings.dnsNames]),
  };
}

async function readStoredSAMLSettings(env: Env, tenantId: string): Promise<SAMLPublicSettings> {
  const defaults = {
    entityIdStyle: DEFAULT_SAML_ENTITY_ID_STYLE,
    interactiveLoginUrlPolicy: DEFAULT_SAML_INTERACTIVE_LOGIN_URL_POLICY,
    certificateSubject: DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT,
    certificateSubjectAlternativeNames: {
      includeGeneratedDnsNames: true,
      dnsNames: [],
    },
    signingKeyPolicies: {},
  };

  if (!env.SETTINGS) {
    return defaults;
  }

  try {
    const raw = await env.SETTINGS.get(buildSAMLSettingsKey(tenantId));
    if (!raw) {
      return defaults;
    }

    const parsed = JSON.parse(raw) as {
      entityIdStyle?: unknown;
      entity_id_style?: unknown;
      interactiveLoginUrlPolicy?: unknown;
      interactive_login_url_policy?: unknown;
      certificateSubject?: unknown;
      certificateSubjectAlternativeNames?: unknown;
      certificate_subject_alternative_names?: unknown;
      signingKeyPolicies?: unknown;
    };
    return {
      entityIdStyle:
        normalizeSAMLEntityIdStyle(parsed.entityIdStyle) ??
        normalizeSAMLEntityIdStyle(parsed.entity_id_style) ??
        DEFAULT_SAML_ENTITY_ID_STYLE,
      interactiveLoginUrlPolicy:
        normalizeSAMLInteractiveLoginUrlPolicy(parsed.interactiveLoginUrlPolicy) ??
        normalizeSAMLInteractiveLoginUrlPolicy(parsed.interactive_login_url_policy) ??
        DEFAULT_SAML_INTERACTIVE_LOGIN_URL_POLICY,
      certificateSubject: normalizeCertificateSubject(parsed.certificateSubject),
      certificateSubjectAlternativeNames: normalizeCertificateSubjectAlternativeNames(
        parsed.certificateSubjectAlternativeNames ?? parsed.certificate_subject_alternative_names
      ),
      signingKeyPolicies: normalizeSigningKeyPolicies(parsed.signingKeyPolicies),
    };
  } catch {
    return defaults;
  }
}

function normalizeCertificateSubject(value: unknown): Required<SAMLSigningCertificateSubject> {
  const source =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    countryName: readString(source.countryName, 2).toUpperCase(),
    stateOrProvinceName: readString(source.stateOrProvinceName, 128),
    localityName: readString(source.localityName, 128),
    organizationName:
      readString(source.organizationName, 128) ||
      DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT.organizationName,
    organizationalUnitName: readString(source.organizationalUnitName, 128),
    commonName:
      readString(source.commonName, 128) || DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT.commonName,
  };
}

function readString(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, maxLength)
    : '';
}

export function normalizeCertificateSubjectAlternativeNames(
  value: unknown
): SAMLSigningCertificateSubjectAlternativeNameSettings {
  const source =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const includeGeneratedDnsNames =
    typeof source.includeGeneratedDnsNames === 'boolean' ? source.includeGeneratedDnsNames : true;
  return {
    includeGeneratedDnsNames,
    dnsNames: uniqueDnsNames(Array.isArray(source.dnsNames) ? source.dnsNames : []),
  };
}

function uniqueDnsNames(values: unknown[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of values) {
    const name = readDnsName(value);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.slice(0, 20);
}

function readDnsName(value: unknown): string {
  const normalized = readString(value, 253).toLowerCase();
  if (!normalized || normalized.includes(':') || normalized.includes('/')) {
    return '';
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized) || normalized.includes('*')) {
    return '';
  }
  const labels = normalized.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )
  ) {
    return '';
  }
  return normalized;
}

function extractDnsNameFromUrl(value: string): string {
  try {
    return readDnsName(new URL(value).hostname);
  } catch {
    return readDnsName(value);
  }
}

function normalizeSigningKeyPolicies(value: unknown): SAMLPublicSettings['signingKeyPolicies'] {
  if (typeof value !== 'object' || value === null) return {};
  const source = value as { idp?: SAMLSigningKeyPolicy; sp?: SAMLSigningKeyPolicy };
  return {
    idp: typeof source.idp === 'object' && source.idp ? source.idp : undefined,
    sp: typeof source.sp === 'object' && source.sp ? source.sp : undefined,
  };
}
