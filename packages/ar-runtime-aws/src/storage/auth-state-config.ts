/** Deployment-owned authentication-state selection, independent of SQL audit/control storage. */
export type AwsAuthStateConfig =
  | { backend: 'postgresql' }
  | { backend: 'dynamodb'; region: string; tableArn: string; namespace: string };
export type DynamoAuthStateConfig = Extract<AwsAuthStateConfig, { backend: 'dynamodb' }>;

export function normalizeAwsAuthStateConfig(
  value: unknown,
  expected: { accountId?: string; region?: string; restoreId?: string } = {}
): AwsAuthStateConfig {
  const invalid = (): never => {
    throw new Error('aws_auth_state_config_invalid');
  };
  // This is the only legacy default. Explicit malformed configurations never fall back.
  if (value === undefined) return { backend: 'postgresql' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const v = value as Record<string, unknown>;
  if (v.backend === 'postgresql') {
    if (Object.keys(v).join(',') !== 'backend') return invalid();
    return { backend: 'postgresql' };
  }
  if (
    v.backend !== 'dynamodb' ||
    Object.keys(v).sort().join(',') !== 'backend,namespace,region,tableArn' ||
    typeof v.tableArn !== 'string' ||
    typeof v.region !== 'string' ||
    typeof v.namespace !== 'string'
  )
    return invalid();
  const arn =
    /^arn:(aws|aws-us-gov|aws-cn):dynamodb:([a-z0-9-]+):(\d{12}):table\/([a-zA-Z0-9_.-]{3,255})$/u.exec(
      v.tableArn
    );
  if (
    !arn ||
    arn[2] !== v.region ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(v.region) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v.namespace) ||
    (expected.accountId !== undefined && expected.accountId !== arn[3]) ||
    (expected.region !== undefined && expected.region !== v.region) ||
    (expected.restoreId !== undefined && expected.restoreId !== v.namespace)
  )
    return invalid();
  if (
    (v.region.startsWith('cn-')
      ? 'aws-cn'
      : v.region.startsWith('us-gov-')
        ? 'aws-us-gov'
        : 'aws') !== arn[1]
  )
    return invalid();
  return { backend: 'dynamodb', region: v.region, tableArn: v.tableArn, namespace: v.namespace };
}

export function dynamoAuthStateTableName(target: DynamoAuthStateConfig): string {
  const normalized = normalizeAwsAuthStateConfig(target);
  if (normalized.backend !== 'dynamodb') throw new Error('aws_auth_state_config_invalid');
  return normalized.tableArn.slice(normalized.tableArn.indexOf(':table/') + 7);
}
