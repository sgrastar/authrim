import { AwsSetupError } from './setup-aws-cli.mjs';

const invalid = () => {
  throw new AwsSetupError('aws_setup_auth_state_invalid');
};

/** Setup selects the service; the deployment itself supplies the exact new table and generation. */
export function normalizeSetupAuthState(value) {
  if (value === undefined) return { backend: 'postgresql' };
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).join(',') !== 'backend' ||
    !['postgresql', 'dynamodb'].includes(value.backend)
  )
    invalid();
  return { backend: value.backend };
}

export function executionAuthState(config, state, restoreId) {
  const selected = normalizeSetupAuthState(config.authState);
  if (selected.backend === 'postgresql')
    return config.authState === undefined ? undefined : selected;
  const tableArn = state.stages.foundation?.outputs?.AuthStateTableArn;
  const prefix = `arn:aws:dynamodb:${config.target.region}:${config.target.accountId}:table/`;
  if (
    typeof tableArn !== 'string' ||
    !tableArn.startsWith(prefix) ||
    !/^[A-Za-z0-9_.-]{3,255}$/u.test(tableArn.slice(prefix.length)) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(restoreId)
  )
    invalid();
  return { backend: 'dynamodb', region: config.target.region, tableArn, namespace: restoreId };
}
