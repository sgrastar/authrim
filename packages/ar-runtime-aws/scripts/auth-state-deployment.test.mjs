import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';

const names = [
  'saml-idp-foundation',
  'saml-idp-bootstrap-roles',
  'saml-browser-access',
  'saml-idp-db-bootstrap',
  'saml-idp-workload',
  'saml-browser-workload',
];
const customTags = [
  ...['Ref', 'Sub', 'Condition', 'GetAZs'].map((name) => ({
    tag: `!${name}`,
    resolve: (value) => ({
      [name === 'Ref' || name === 'Condition' ? name : `Fn::${name}`]: value,
    }),
  })),
  { tag: '!GetAtt', resolve: (value) => ({ 'Fn::GetAtt': value.split('.') }) },
  ...['If', 'Not', 'Equals', 'And', 'Or', 'Select', 'Join'].map((name) => ({
    tag: `!${name}`,
    collection: 'seq',
    resolve: (value) => ({ [`Fn::${name}`]: value.toJSON() }),
  })),
];
const bodies = Object.fromEntries(
  await Promise.all(
    names.map(async (name) => [
      name,
      await readFile(new URL(`../deploy/${name}.yaml`, import.meta.url), 'utf8'),
    ])
  )
);
const templates = Object.fromEntries(
  Object.entries(bodies).map(([name, body]) => [name, parse(body, { customTags })])
);
const tableArn = 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/rehearsal-auth-state';
const dataActions = [
  'dynamodb:GetItem',
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
  'dynamodb:ConditionCheckItem',
  'dynamodb:Query',
  'dynamodb:Scan',
  'dynamodb:DescribeTable',
];
const spActions = [
  'dynamodb:GetItem',
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
  'dynamodb:DescribeTable',
];
function evaluate(template, value, parameters) {
  const values = {
    ...Object.fromEntries(Object.entries(template.Parameters).map(([k, v]) => [k, v.Default])),
    ...parameters,
  };
  const visit = (v) => {
    if (Array.isArray(v)) return v.map(visit).filter((item) => item !== undefined);
    if (!v || typeof v !== 'object') return v;
    if (v.Ref) return v.Ref === 'AWS::NoValue' ? undefined : (values[v.Ref] ?? v);
    if (v.Condition) return visit(template.Conditions[v.Condition]);
    if (v['Fn::If']) {
      const [condition, yes, no] = v['Fn::If'];
      return visit(visit(template.Conditions[condition]) ? yes : no);
    }
    if (v['Fn::Equals']) return visit(v['Fn::Equals'][0]) === visit(v['Fn::Equals'][1]);
    if (v['Fn::Not']) return !visit(v['Fn::Not'][0]);
    if (v['Fn::And']) return v['Fn::And'].every(visit);
    if (v['Fn::Or']) return v['Fn::Or'].some(visit);
    return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, visit(item)]));
  };
  return visit(value);
}
function statements(resource) {
  if (resource.Properties.PolicyDocument) return resource.Properties.PolicyDocument.Statement;
  return resource.Properties.Policies.flatMap((policy) => policy.PolicyDocument.Statement);
}
function dynamoStatements(template, resourceName, parameters) {
  return evaluate(template, statements(template.Resources[resourceName]), parameters).filter(
    (statement) => JSON.stringify(statement.Action).includes('dynamodb:')
  );
}

test('PostgreSQL stays the default; DynamoDB table, routes and outputs require explicit selection', () => {
  const template = templates['saml-idp-foundation'];
  assert.equal(template.Parameters.AuthStateBackend.Default, 'postgresql');
  assert.deepEqual(template.Parameters.AuthStateBackend.AllowedValues, ['postgresql', 'dynamodb']);
  for (const backend of ['postgresql', 'dynamodb']) {
    const enabled = backend === 'dynamodb';
    const parameters = { AuthStateBackend: backend };
    for (const name of ['AuthStateTable', 'DynamoDbGatewayEndpoint', 'AuthStateBootstrapEgress']) {
      const condition = template.Resources[name].Condition;
      assert.equal(evaluate(template, { Condition: condition }, parameters), enabled);
    }
    for (const name of ['AuthStateTableArn', 'DynamoDbGatewayPrefixListId']) {
      assert.equal(
        evaluate(template, { Condition: template.Outputs[name].Condition }, parameters),
        enabled
      );
    }
  }
  for (const [backend, prefix, valid] of [
    ['postgresql', '', true],
    ['postgresql', 'pl-12345678', false],
    ['dynamodb', '', false],
    ['dynamodb', 'pl-12345678', true],
  ]) {
    const parameters = { AuthStateBackend: backend, DynamoDbGatewayPrefixListId: prefix };
    assert.equal(
      Object.values(template.Rules).every(
        (rule) =>
          !evaluate(template, rule.RuleCondition, parameters) ||
          rule.Assertions.every((assertion) => evaluate(template, assertion.Assert, parameters))
      ),
      valid
    );
  }
});

test('DynamoDB authentication state is retained, protected, encrypted and uses the runtime key/TTL contract', () => {
  const resource = templates['saml-idp-foundation'].Resources.AuthStateTable;
  assert.equal(resource.Type, 'AWS::DynamoDB::Table');
  assert.equal(resource.DeletionPolicy, 'Retain');
  assert.equal(resource.UpdateReplacePolicy, 'Retain');
  const properties = resource.Properties;
  assert.equal(properties.BillingMode, 'PAY_PER_REQUEST');
  assert.equal(properties.ProvisionedThroughput, undefined);
  assert.equal(properties.DeletionProtectionEnabled, true);
  assert.equal(properties.SSESpecification.SSEEnabled, true);
  assert.equal(properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, true);
  assert.deepEqual(properties.KeySchema, [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ]);
  assert.deepEqual(properties.AttributeDefinitions, [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'sk', AttributeType: 'S' },
  ]);
  assert.deepEqual(properties.TimeToLiveSpecification, { AttributeName: 'ttl', Enabled: true });
  assert.deepEqual(properties.TableName, { 'Fn::Sub': '${AWS::StackName}-auth-state' });
});

test('private endpoint and egress do not introduce internet routes or unrelated table access', () => {
  const foundation = templates['saml-idp-foundation'];
  const endpoint = foundation.Resources.DynamoDbGatewayEndpoint;
  assert.equal(endpoint.Properties.VpcEndpointType, 'Gateway');
  assert.deepEqual(endpoint.Properties.ServiceName, {
    'Fn::Sub': 'com.amazonaws.${AWS::Region}.dynamodb',
  });
  assert.deepEqual(endpoint.Properties.RouteTableIds, [
    { Ref: 'PrivateRouteTableA' },
    { Ref: 'PrivateRouteTableB' },
  ]);
  const statement = endpoint.Properties.PolicyDocument.Statement[0];
  assert.deepEqual(statement.Resource, { 'Fn::GetAtt': ['AuthStateTable', 'Arn'] });
  assert.deepEqual(statement.Condition.StringEquals['aws:PrincipalAccount'], {
    Ref: 'AWS::AccountId',
  });
  assert.deepEqual(statement.Action, dataActions);
  for (const [template, name, group] of [
    [foundation, 'AuthStateBootstrapEgress', 'BootstrapSecurityGroup'],
    [templates['saml-idp-workload'], 'AuthStateRuntimeEgress', 'RuntimeSecurityGroup'],
  ]) {
    const properties = template.Resources[name].Properties;
    assert.deepEqual(properties.GroupId, { Ref: group });
    assert.equal(properties.IpProtocol, 'tcp');
    assert.equal(properties.FromPort, 443);
    assert.equal(properties.ToPort, 443);
    assert.deepEqual(properties.DestinationPrefixListId, { Ref: 'DynamoDbGatewayPrefixListId' });
    assert.equal(properties.CidrIp, undefined);
    assert.equal(properties.CidrIpv6, undefined);
  }
  assert.ok(
    !Object.values(foundation.Resources).some((r) =>
      ['AWS::EC2::InternetGateway', 'AWS::EC2::NatGateway', 'AWS::EC2::Route'].includes(r.Type)
    )
  );
});

test('serving and maintenance roles and boundaries grant only selected-table operations when enabled', () => {
  for (const [name, resourceNames] of [
    ['saml-idp-bootstrap-roles', ['RuntimePermissionsBoundary', 'DbBootstrapPermissionsBoundary']],
    ['saml-browser-access', ['BrowserIdpPermissionsBoundary', 'DbBootstrapPermissionsBoundary']],
    ['saml-idp-db-bootstrap', ['JobRole']],
    ['saml-idp-workload', ['RuntimeRole']],
    ['saml-browser-workload', ['IdpRole']],
    ['saml-browser-access', ['BrowserSpPermissionsBoundary']],
    ['saml-browser-workload', ['SpRole']],
  ]) {
    const template = templates[name];
    assert.equal(template.Parameters.AuthStateTableArn.Default, '');
    for (const resource of resourceNames) {
      assert.deepEqual(dynamoStatements(template, resource, {}), []);
      assert.deepEqual(dynamoStatements(template, resource, { AuthStateTableArn: tableArn }), [
        {
          Sid: 'SelectedAuthState',
          Effect: 'Allow',
          Action: resource.includes('Sp') ? spActions : dataActions,
          Resource: tableArn,
        },
      ]);
    }
  }
});

test('foundation service role can manage only the stack-derived table and has no item access', () => {
  const template = templates['saml-idp-bootstrap-roles'];
  const statements = dynamoStatements(template, 'FoundationCfnServiceRole', {});
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].Resource, {
    'Fn::Sub':
      'arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${FoundationStackName}-auth-state',
  });
  assert.deepEqual(statements[0].Action, [
    'dynamodb:CreateTable',
    'dynamodb:DeleteTable',
    'dynamodb:UpdateTable',
    'dynamodb:DescribeTable',
    'dynamodb:DescribeContinuousBackups',
    'dynamodb:UpdateContinuousBackups',
    'dynamodb:DescribeTimeToLive',
    'dynamodb:UpdateTimeToLive',
    'dynamodb:ListTagsOfResource',
    'dynamodb:TagResource',
    'dynamodb:UntagResource',
  ]);
});

test('all templates remain within the inline CloudFormation size limit', () => {
  for (const [name, body] of Object.entries(bodies)) {
    assert.ok(Buffer.byteLength(body) <= 51_200, name);
    assert.equal(templates[name].Metadata.AWSToolsMetrics.AWSAgentToolkit, 'aws-cloudformation@3');
  }
});
