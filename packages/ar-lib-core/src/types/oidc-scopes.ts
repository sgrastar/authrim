export type OidcScopeType = 'system' | 'custom';

export interface OidcScopeLocalization {
  display_name?: string;
  description?: string;
}

export interface OidcScope {
  id: string;
  tenant_id: string;
  name: string;
  display_name: string;
  description?: string | null;
  scope_type: OidcScopeType;
  enabled: number | boolean;
  localizations_json?: string | Record<string, OidcScopeLocalization> | null;
  created_at: number;
  updated_at: number;
}

export interface OidcScopeResponse extends Omit<OidcScope, 'localizations_json'> {
  localizations: Record<string, OidcScopeLocalization>;
}
