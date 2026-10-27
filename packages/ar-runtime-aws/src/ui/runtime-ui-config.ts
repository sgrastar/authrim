/** Deployment-owned UI selection. Full packaged applications are not deployed by this profile. */
export interface AwsRuntimeUiConfig {
  components: { loginUi: false; adminUi: false };
  ui: {
    login:
      | { mode: 'disabled' }
      | { mode: 'embedded-rehearsal' }
      | {
          mode: 'external';
          baseUrl: string;
          clientId: string;
          paths: { login: string; reauth: string };
        };
    admin: { mode: 'disabled' } | { mode: 'external'; baseUrl: string };
  };
}

function invalid(): never {
  throw new Error('aws_runtime_ui_config_invalid');
}

function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    invalid();
}

export function isAwsUiOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.origin === value &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 256 &&
    /^\/(?!\/)[A-Za-z0-9_~./-]*$/u.test(value) &&
    !value.includes('//') &&
    !value.split('/').some((part) => part === '.' || part === '..')
  );
}

/** Undefined alone retains the historical embedded test screen; explicit objects are strict. */
export function normalizeAwsRuntimeUiConfig(value: unknown): AwsRuntimeUiConfig {
  if (value === undefined)
    return {
      components: { loginUi: false, adminUi: false },
      ui: { login: { mode: 'embedded-rehearsal' }, admin: { mode: 'disabled' } },
    };
  exact(value, ['components', 'ui']);
  exact(value.components, ['loginUi', 'adminUi']);
  if (value.components.loginUi === true || value.components.adminUi === true) {
    throw new Error('aws_packaged_ui_unsupported');
  }
  if (value.components.loginUi !== false || value.components.adminUi !== false) invalid();
  exact(value.ui, ['login', 'admin']);
  const login = value.ui.login;
  const admin = value.ui.admin;
  if (!login || typeof login !== 'object' || !admin || typeof admin !== 'object') invalid();
  const loginMode = (login as Record<string, unknown>).mode;
  if (loginMode === 'external') {
    exact(login, ['mode', 'baseUrl', 'clientId', 'paths']);
    exact(login.paths, ['login', 'reauth']);
    if (
      !isAwsUiOrigin(login.baseUrl) ||
      typeof login.clientId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/u.test(login.clientId) ||
      !validPath(login.paths.login) ||
      !validPath(login.paths.reauth)
    )
      invalid();
  } else {
    exact(login, ['mode']);
    if (loginMode !== 'disabled' && loginMode !== 'embedded-rehearsal') invalid();
  }
  const adminMode = (admin as Record<string, unknown>).mode;
  if (adminMode === 'external') {
    exact(admin, ['mode', 'baseUrl']);
    if (!isAwsUiOrigin(admin.baseUrl)) invalid();
  } else {
    exact(admin, ['mode']);
    if (adminMode !== 'disabled') invalid();
  }
  return structuredClone(value) as unknown as AwsRuntimeUiConfig;
}

/** Preserve legacy activation digests when no destination override was recorded. */
export function awsRuntimeUiConfigurationEvidence(value: unknown): {
  destinationUi?: AwsRuntimeUiConfig;
} {
  return value === undefined ? {} : { destinationUi: normalizeAwsRuntimeUiConfig(value) };
}
