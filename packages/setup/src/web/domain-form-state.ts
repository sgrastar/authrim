export type ApiDomainExampleRowKind = 'initial-tenant' | 'initial-tenant-explicit' | 'other-tenant';

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

export interface SetupDomainValidationInput {
  apiDomain: string;
  loginUiDomain?: string | null;
  adminUiDomain?: string | null;
  tenantName?: string | null;
}

export interface SetupDomainValidationIssue {
  field: 'apiDomain' | 'loginUiDomain' | 'adminUiDomain';
  message: string;
  suggestion?: string;
}

export function isValidCustomDomain(domain: string): boolean {
  const normalized = domain.trim();
  if (normalized.length === 0 || normalized.length > 253) {
    return false;
  }

  const labels = normalized.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0 || label.length > 63)) {
    return false;
  }

  if (labels.some((label) => label.toLowerCase().startsWith('xn--'))) {
    return false;
  }

  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,63}$/i.test(tld)) {
    return false;
  }

  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

export function validateSetupDomainInputs(
  input: SetupDomainValidationInput
): SetupDomainValidationIssue[] {
  function normalizeDomain(value: string | null | undefined): string {
    return String(value || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/\.+$/, '')
      .toLowerCase();
  }

  function getZoneName(hostname: string): string {
    const parts = hostname.split('.').filter(Boolean);
    const twoPartTlds = new Set([
      'co.uk',
      'org.uk',
      'gov.uk',
      'ac.uk',
      'co.jp',
      'or.jp',
      'ne.jp',
      'co.nz',
      'org.nz',
      'net.nz',
      'co.kr',
      'or.kr',
      'ne.kr',
      'co.in',
      'firm.in',
      'net.in',
      'org.in',
      'gen.in',
      'co.id',
      'web.id',
      'ac.id',
      'or.id',
      'co.za',
      'org.za',
      'net.za',
      'com.au',
      'net.au',
      'org.au',
      'com.br',
      'net.br',
      'org.br',
    ]);
    const lastTwo = parts.slice(-2).join('.');
    if (twoPartTlds.has(lastTwo) && parts.length >= 3) {
      return parts.slice(-3).join('.');
    }
    return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
  }

  function prefixLabelsFor(hostname: string, parentDomain: string): string[] {
    if (!hostname || !parentDomain) {
      return [];
    }
    if (hostname === parentDomain) {
      return [];
    }
    const suffix = `.${parentDomain}`;
    if (!hostname.endsWith(suffix)) {
      return [];
    }
    return hostname.slice(0, -suffix.length).split('.').filter(Boolean);
  }

  function buildBaseMessage(hostname: string): string {
    return (
      `Base Domain must be the parent domain used by tenant URLs. "${hostname}" has ` +
      'two or more labels before the registered domain, which would create unsupported ' +
      'two-label tenant hosts.'
    );
  }

  function buildUiMessage(label: string, hostname: string, suggestion: string): string {
    return (
      `${label} domain "${hostname}" is too deep for the standard tenant domain model. ` +
      `Use a one-label host such as "${suggestion}" instead.`
    );
  }

  const issues: SetupDomainValidationIssue[] = [];
  const apiDomain = normalizeDomain(input.apiDomain);
  const loginUiDomain = normalizeDomain(input.loginUiDomain);
  const adminUiDomain = normalizeDomain(input.adminUiDomain);

  if (apiDomain && isValidCustomDomain(apiDomain)) {
    const zoneName = getZoneName(apiDomain);
    const apiPrefixLabels = prefixLabelsFor(apiDomain, zoneName);
    if (apiPrefixLabels.length >= 2) {
      const suggested = `${apiPrefixLabels[apiPrefixLabels.length - 1]}.${zoneName}`;
      issues.push({
        field: 'apiDomain',
        message: buildBaseMessage(apiDomain),
        suggestion: suggested,
      });
    }
  }

  const uiDomains = [
    ['loginUiDomain', 'Login UI', loginUiDomain],
    ['adminUiDomain', 'Admin UI', adminUiDomain],
  ] as const;

  for (const [field, label, hostname] of uiDomains) {
    if (!hostname || !isValidCustomDomain(hostname)) {
      continue;
    }

    const parentDomain =
      apiDomain && hostname.endsWith(`.${apiDomain}`) ? apiDomain : getZoneName(hostname);
    const uiPrefixLabels = prefixLabelsFor(hostname, parentDomain);
    if (uiPrefixLabels.length >= 2) {
      const suggestion = `${uiPrefixLabels.join('-')}.${parentDomain}`;
      issues.push({
        field,
        message: buildUiMessage(label, hostname, suggestion),
        suggestion,
      });
    }
  }

  return issues;
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
