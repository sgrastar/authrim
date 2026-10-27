import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

async function template(name: string) {
  const text = await readFile(new URL(`../../deploy/${name}`, import.meta.url), 'utf8');
  const document = parseDocument(text, {
    customTags: ['!Ref', '!Sub', '!GetAtt'].map((tag) => ({
      tag,
      resolve: (value: string) => value,
    })),
  });
  expect(document.errors).toEqual([]);
  return document.toJSON() as {
    Parameters: Record<string, { AllowedPattern: string }>;
    Resources: Record<
      string,
      {
        Type: string;
        DeletionPolicy?: string;
        UpdateReplacePolicy?: string;
        Properties: Record<string, unknown> & {
          PolicyDocument?: {
            Statement: Array<{ Effect: string; Action: string; Resource: string }>;
          };
        };
      }
    >;
  };
}

describe('DSQL infrastructure isolation', () => {
  it('creates only a protected, retained test cluster with no existing infrastructure links', async () => {
    const value = await template('dsql-compatibility-probe.yaml');
    expect(Object.keys(value.Resources)).toEqual(['ProbeCluster']);
    expect(value.Resources.ProbeCluster).toMatchObject({
      Type: 'AWS::DSQL::Cluster',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: { DeletionProtectionEnabled: true },
    });
    expect(value.Resources.ProbeCluster.Properties).not.toHaveProperty('MultiRegionProperties');
  });

  it('grants SQL access to one cluster without infrastructure, IAM, or existing policy ownership', async () => {
    const value = await template('dsql-probe-access.yaml');
    expect(Object.keys(value.Resources)).toEqual(['ProbeSqlAccess']);
    const policy = value.Resources.ProbeSqlAccess;
    expect(policy.Type).toBe('AWS::IAM::RolePolicy');
    const statements = policy.Properties.PolicyDocument?.Statement;
    expect(statements).toEqual([
      {
        Sid: 'ConnectOnlyToSyntheticProbeCluster',
        Effect: 'Allow',
        Action: 'dsql:DbConnectAdmin',
        Resource:
          'arn:${AWS::Partition}:dsql:${AWS::Region}:${AWS::AccountId}:cluster/${ProbeClusterId}',
      },
    ]);
    const cluster = new RegExp(`^(?:${value.Parameters.ProbeClusterId.AllowedPattern})$`, 'u');
    const role = new RegExp(`^(?:${value.Parameters.ProbeOperatorRoleName.AllowedPattern})$`, 'u');
    expect(cluster.test('a'.repeat(26))).toBe(true);
    for (const input of ['*', 'a'.repeat(25), 'a'.repeat(26) + '*', 'other-region/cluster']) {
      expect(cluster.test(input)).toBe(false);
    }
    expect(role.test('authrim-dr-bootstrap-operator')).toBe(true);
    for (const input of ['production-lambda-role', '*', 'root', 'authrim-dr-bootstrap-operator*']) {
      expect(role.test(input)).toBe(false);
    }
    expect(policy.Properties.PolicyName).toBe('authrim-dsql-probe-${ProbeClusterId}');
  });
});
