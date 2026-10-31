import { AwsSetupError } from './setup-aws-cli.mjs';

const fail = () => {
  throw new AwsSetupError('aws_setup_ui_invalid');
};
function keys(value, expected) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join() !== [...expected].sort().join()
  ) fail();
}
function origin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) fail();
  } catch { fail(); }
}

/** Public destination selection only; source client/origin authorization is checked during restore. */
export function normalizeSetupUi(components, ui, mode) {
  if (components === undefined && ui === undefined) return undefined;
  keys(components, ['loginUi', 'adminUi']);
  if (typeof components.loginUi !== 'boolean' || typeof components.adminUi !== 'boolean') fail();
  if (components.loginUi || components.adminUi)
    throw new AwsSetupError('aws_setup_packaged_ui_unsupported');
  keys(ui, ['login', 'admin']);
  if (ui.login?.mode === 'external') {
    keys(ui.login, ['mode', 'baseUrl', 'clientId', 'paths']);
    origin(ui.login.baseUrl);
    if (typeof ui.login.clientId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(ui.login.clientId)) fail();
    keys(ui.login.paths, ['login', 'reauth']);
    for (const value of Object.values(ui.login.paths)) {
      if (
        typeof value !== 'string' ||
        value.length > 256 ||
        !/^\/[A-Za-z0-9_~./-]*$/u.test(value) ||
        value.includes('//') ||
        value.split('/').some((part) => part === '.' || part === '..')
      ) fail();
    }
  } else {
    keys(ui.login, ['mode']);
    if (!['disabled', 'embedded-rehearsal'].includes(ui.login.mode)) fail();
    if (ui.login.mode === 'embedded-rehearsal' && mode !== 'browser-rehearsal') fail();
  }
  if (ui.admin?.mode === 'external') {
    keys(ui.admin, ['mode', 'baseUrl']);
    origin(ui.admin.baseUrl);
  } else {
    keys(ui.admin, ['mode']);
    if (ui.admin.mode !== 'disabled') fail();
  }
  return JSON.parse(JSON.stringify({ components, ui }));
}
