import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';

const body = await readFile(
  new URL('../deploy/replication-authority.yaml', import.meta.url),
  'utf8'
);
const customTags = [
  ...['Ref', 'Sub'].map((name) => ({
    tag: `!${name}`,
    resolve: (value) => ({ [name === 'Ref' ? name : `Fn::${name}`]: value }),
  })),
  { tag: '!GetAtt', resolve: (value) => ({ 'Fn::GetAtt': value.split('.') }) },
  ...['Not', 'Equals'].map((name) => ({
    tag: `!${name}`,
    collection: 'seq',
    resolve: (value) => ({ [`Fn::${name}`]: value.toJSON() }),
  })),
];
const template = parse(body, { customTags });
const resources = template.Resources;

test('authority deployment creates no tenant databases, secret material, DNS or asynchronous execution', () => {
  assert(Buffer.byteLength(body) < 51_200);
  assert(
    !Object.values(resources).some((value) =>
      /RDS|DynamoDB|SecretsManager|Route53|EventSourceMapping|EventBridge|Scheduler/u.test(
        value.Type
      )
    )
  );
  assert.equal(resources.RpcRoute.Properties.RouteKey, 'POST /replication/v1/rpc');
  assert.equal(resources.AuthorityFunction.Properties.Handler, 'replication-authority.handler');
  assert.deepEqual(resources.AuthorityFunction.Properties.Code.S3ObjectVersion, {
    Ref: 'ArtifactObjectVersion',
  });
});

test('authority secret is an exact immutable-version reference and runtime role can only read it', () => {
  const vars = resources.AuthorityFunction.Properties.Environment.Variables;
  assert.deepEqual(vars.AUTHRIM_REPLICATION_AUTHORITY_SECRET_VERSION_ID, {
    Ref: 'AuthoritySecretVersionId',
  });
  assert.deepEqual(vars.AUTHRIM_REPLICATION_AUTHORITY_ACCOUNT_ID, { Ref: 'AWS::AccountId' });
  assert.equal(vars.NODE_EXTRA_CA_CERTS, '/var/task/certs/rds-ca.pem');
  const statements = resources.RuntimeRole.Properties.Policies.flatMap(
    (value) => value.PolicyDocument.Statement
  );
  const secretStatements = statements.filter((value) =>
    JSON.stringify(value.Action ?? []).includes('secretsmanager:')
  );
  assert.deepEqual(secretStatements, [
    {
      Effect: 'Allow',
      Action: 'secretsmanager:GetSecretValue',
      Resource: { Ref: 'AuthoritySecretArn' },
    },
  ]);
  assert.deepEqual(resources.RuntimeRole.Properties.PermissionsBoundary, {
    Ref: 'RuntimePermissionsBoundaryArn',
  });
  assert(!statements.some((value) => JSON.stringify(value.Action).includes('s3:')));
});

test('private runtime has no public network rule and application code cannot manage interfaces', () => {
  const sg = resources.RuntimeSecurityGroup.Properties;
  assert.equal(sg.SecurityGroupIngress, undefined);
  assert.equal(sg.SecurityGroupEgress.length, 2);
  assert(
    sg.SecurityGroupEgress.every(
      (value) => value.DestinationSecurityGroupId && !value.CidrIp && !value.CidrIpv6
    )
  );
  assert.deepEqual(resources.DatabaseIngress.Properties.SourceSecurityGroupId, {
    Ref: 'RuntimeSecurityGroup',
  });
  const deny = resources.DenyCodeVpcApis.Properties.PolicyDocument.Statement[0];
  assert.equal(deny.Effect, 'Deny');
  assert.deepEqual(deny.Condition.ArnEquals['lambda:SourceFunctionArn'], {
    'Fn::GetAtt': ['AuthorityFunction', 'Arn'],
  });
});

test('invocation permission is account- and route-bound and retained logs contain no request content', () => {
  assert.deepEqual(resources.InvokePermission.Properties.SourceAccount, { Ref: 'AWS::AccountId' });
  assert.match(
    resources.InvokePermission.Properties.SourceArn['Fn::Sub'],
    /\/\*\/POST\/replication\/v1\/rpc$/u
  );
  for (const name of ['AuthorityLogs', 'AccessLogs']) {
    assert.equal(resources[name].DeletionPolicy, 'Retain');
    assert.equal(resources[name].UpdateReplacePolicy, 'Retain');
  }
  const format = JSON.parse(resources.Stage.Properties.AccessLogSettings.Format);
  assert.deepEqual(Object.keys(format).sort(), ['requestId', 'responseLatency', 'status']);
  assert.equal(resources.AuthorityFunction.Properties.LoggingConfig.ApplicationLogLevel, 'WARN');
});

const servingBody = await readFile(
  new URL('../deploy/replication-serving.yaml', import.meta.url),
  'utf8'
);
const serving = parse(servingBody);

test('replication templates retain their attribution and resource change-safety context', () => {
  for (const current of [template, serving]) {
    assert.equal(current.Metadata.AWSToolsMetrics.AWSAgentToolkit, 'aws-cloudformation@3');
    assert(Buffer.byteLength(current.Description) <= 1_024);
    for (const [name, resource] of Object.entries(current.Resources)) {
      const context = resource.Metadata?.['com.aws.cloudformation.Context'];
      assert.equal(typeof context?.why, 'string', `${name} must explain its purpose`);
      assert(
        Array.isArray(context.must) && context.must.length > 0,
        `${name} must preserve its operating constraints`
      );
    }
  }
});

test('replicated serving is opt-in on the same runtime bundle and creates no data store or network route', () => {
  assert(Buffer.byteLength(servingBody) < 51_200);
  assert(
    !Object.values(serving.Resources).some((value) =>
      /RDS|DynamoDB|SecretsManager|Route53|NatGateway|EC2::Route|EventSourceMapping|Scheduler/u.test(
        value.Type
      )
    )
  );
  const lambda = serving.Resources.ServingFunction.Properties;
  assert.equal(lambda.Handler, 'lambda.handler');
  assert.deepEqual(lambda.Code.S3ObjectVersion, { Ref: 'ArtifactObjectVersion' });
  assert.deepEqual(Object.keys(lambda.Environment.Variables).sort(), [
    'AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN',
    'AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID',
    'NODE_EXTRA_CA_CERTS',
  ]);
  assert.equal(serving.Parameters.AuthStateTableArn.Default, '');
  assert(serving.Rules.AuthStateNetwork.Assertions[0].Assert['Fn::Or']);
});

test('serving network requires an explicit reviewed authority path with only HTTPS outbound and no public ingress', () => {
  for (const name of ['AuthorityHttpsEgressCidr', 'AuthorityNetworkPathReady']) {
    assert.equal(serving.Parameters[name].Default, undefined);
  }
  assert.deepEqual(serving.Parameters.AuthorityNetworkPathReady.AllowedValues, ['true']);
  const sg = serving.Resources.RuntimeSecurityGroup.Properties;
  assert.equal(sg.SecurityGroupIngress, undefined);
  const cidrRules = sg.SecurityGroupEgress.filter((value) => value.CidrIp || value.CidrIpv6);
  assert.deepEqual(cidrRules, [
    {
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      CidrIp: { Ref: 'AuthorityHttpsEgressCidr' },
    },
  ]);
  assert.deepEqual(serving.Resources.DatabaseIngress.Properties.SourceSecurityGroupId, {
    Ref: 'RuntimeSecurityGroup',
  });
});

test('serving may only read pinned generation object versions and scoped secrets in its account', () => {
  const statements = serving.Resources.RuntimeRole.Properties.Policies.flatMap(
    (value) => value.PolicyDocument.Statement
  );
  const secrets = statements.filter((value) =>
    JSON.stringify(value.Action ?? []).includes('secretsmanager:')
  );
  assert.deepEqual(secrets, [
    {
      Effect: 'Allow',
      Action: 'secretsmanager:GetSecretValue',
      Resource: [
        { Ref: 'DiscoverySecretArn' },
        {
          'Fn::Sub':
            'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:${GenerationSecretNamePrefix}/*',
        },
      ],
    },
  ]);
  const s3 = statements.filter((value) => JSON.stringify(value.Action ?? []).includes('s3:'));
  assert.deepEqual(s3, [
    {
      Effect: 'Allow',
      Action: 's3:GetObjectVersion',
      Resource: {
        'Fn::Sub': 'arn:${AWS::Partition}:s3:::${GenerationBucket}/${GenerationObjectPrefix}/*',
      },
      Condition: { StringEquals: { 's3:ResourceAccount': { Ref: 'AWS::AccountId' } } },
    },
  ]);
  assert.deepEqual(serving.Resources.RuntimeRole.Properties.PermissionsBoundary, {
    Ref: 'RuntimePermissionsBoundaryArn',
  });
  for (const name of ['ServingLogs', 'AccessLogs']) {
    assert.equal(serving.Resources[name].DeletionPolicy, 'Retain');
    assert.equal(serving.Resources[name].UpdateReplacePolicy, 'Retain');
  }
  assert.deepEqual(serving.Resources.InvokePermission.Properties.SourceAccount, {
    Ref: 'AWS::AccountId',
  });
});
