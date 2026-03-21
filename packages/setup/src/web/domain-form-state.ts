export type ApiDomainExampleRowKind =
  | 'initial-tenant'
  | 'initial-tenant-explicit'
  | 'other-tenant';

export interface ApiDomainExampleRow {
  kind: ApiDomainExampleRowKind;
  url: string;
  tenantName?: string;
}

export interface ApiDomainFormInput {
  baseDomain: string;
  multiTenantChecked: boolean;
  nakedDomainChecked: boolean;
  tenantName: string;
  primaryTenant?: string | null;
}

export interface ApiDomainUiState {
  hasBaseDomain: boolean;
  hasValidBaseDomain: boolean;
  multiTenantEnabled: boolean;
  showWorkersDevNote: boolean;
  showNakedDomainControls: boolean;
  showTenantFields: boolean;
  showPrimaryTenantRow: boolean;
  showExamples: boolean;
  baseDomainPlaceholder: string;
  multiTenantHintMode: 'needs-custom-domain' | 'single-tenant' | 'multi-tenant';
  nakedDomainHintMode: 'hidden' | 'include-tenant' | 'omit-tenant';
  exampleRows: ApiDomainExampleRow[];
}

export function isValidCustomDomain(domain: string): boolean {
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain.trim());
}

export function computeApiDomainUiState(input: ApiDomainFormInput): ApiDomainUiState {
  const baseDomain = input.baseDomain.trim();
  const tenantName = input.tenantName.trim() || 'default';
  const primaryTenant = input.primaryTenant?.trim() || '';

  const hasBaseDomain = baseDomain.length > 0;
  const multiTenantEnabled = hasBaseDomain && input.multiTenantChecked;
  const nakedDomainEnabled = multiTenantEnabled && input.nakedDomainChecked;
  const nakedTenantName = primaryTenant || tenantName;

  const exampleRows: ApiDomainExampleRow[] = [];

  if (multiTenantEnabled) {
    if (nakedDomainEnabled) {
      exampleRows.push({
        kind: 'initial-tenant',
        tenantName: nakedTenantName,
        url: `https://${baseDomain}`,
      });

      if (nakedTenantName !== tenantName) {
        exampleRows.push({
          kind: 'initial-tenant-explicit',
          tenantName,
          url: `https://${tenantName}.${baseDomain}`,
        });
      }

      exampleRows.push({
        kind: 'other-tenant',
        url: `https://{tenantName}.${baseDomain}`,
      });
    } else {
      exampleRows.push({
        kind: 'initial-tenant',
        tenantName,
        url: `https://${tenantName}.${baseDomain}`,
      });
      exampleRows.push({
        kind: 'other-tenant',
        url: `https://{tenantName}.${baseDomain}`,
      });
    }
  }

  return {
    hasBaseDomain,
    hasValidBaseDomain: isValidCustomDomain(baseDomain),
    multiTenantEnabled,
    showWorkersDevNote: !hasBaseDomain,
    showNakedDomainControls: multiTenantEnabled,
    showTenantFields: !hasBaseDomain || (multiTenantEnabled && !nakedDomainEnabled),
    showPrimaryTenantRow: nakedDomainEnabled,
    showExamples: multiTenantEnabled,
    baseDomainPlaceholder: nakedDomainEnabled
      ? 'example.com'
      : multiTenantEnabled
        ? 'tenant.example.com'
        : 'oidc.example.com',
    multiTenantHintMode: !hasBaseDomain
      ? 'needs-custom-domain'
      : multiTenantEnabled
        ? 'multi-tenant'
        : 'single-tenant',
    nakedDomainHintMode: !multiTenantEnabled
      ? 'hidden'
      : nakedDomainEnabled
        ? 'omit-tenant'
        : 'include-tenant',
    exampleRows,
  };
}
