import type { Env } from '@authrim/ar-lib-core';
import { buildIssuerUrl } from '@authrim/ar-lib-core';

export type SAMLEntityIdStyle = 'role_url' | 'metadata_url';
export type SAMLInteractiveLoginUrlPolicy = 'tenant_host' | 'ui_base_url';
export type SAMLLocalRole = 'idp' | 'sp';

export interface SAMLPublicSettings {
  entityIdStyle: SAMLEntityIdStyle;
  interactiveLoginUrlPolicy: SAMLInteractiveLoginUrlPolicy;
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

export async function getSAMLEntityIdStyle(
  env: Env,
  tenantId: string
): Promise<SAMLEntityIdStyle> {
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

export async function getSAMLPublicSettings(env: Env, tenantId: string): Promise<SAMLPublicSettings> {
  const storedSettings = await readStoredSAMLSettings(env, tenantId);
  return {
    entityIdStyle:
      normalizeSAMLEntityIdStyle(env.SAML_ENTITY_ID_STYLE) ?? storedSettings.entityIdStyle,
    interactiveLoginUrlPolicy:
      normalizeSAMLInteractiveLoginUrlPolicy(env.SAML_INTERACTIVE_LOGIN_URL_POLICY) ??
      storedSettings.interactiveLoginUrlPolicy,
  };
}

export async function putSAMLPublicSettings(
  env: Env,
  tenantId: string,
  settings: SAMLPublicSettings
): Promise<void> {
  if (!env.SETTINGS) {
    throw new Error('SETTINGS KV binding is required to update SAML settings');
  }

  await env.SETTINGS.put(
    buildSAMLSettingsKey(tenantId),
    JSON.stringify({
      entityIdStyle: settings.entityIdStyle,
      interactiveLoginUrlPolicy: settings.interactiveLoginUrlPolicy,
      updatedAt: Date.now(),
    })
  );
}

export async function getSAMLLocalEntityIds(env: Env, tenantId: string): Promise<SAMLLocalEntityIds> {
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

async function readStoredSAMLSettings(env: Env, tenantId: string): Promise<SAMLPublicSettings> {
  const defaults = {
    entityIdStyle: DEFAULT_SAML_ENTITY_ID_STYLE,
    interactiveLoginUrlPolicy: DEFAULT_SAML_INTERACTIVE_LOGIN_URL_POLICY,
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
    };
  } catch {
    return defaults;
  }
}
