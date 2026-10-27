import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';

const template = parse(
  await readFile(new URL('../deploy/saml-browser-workload.yaml', import.meta.url), 'utf8')
);
const access = parse(
  await readFile(new URL('../deploy/saml-browser-access.yaml', import.meta.url), 'utf8')
);
const resources = template.Resources;
const issuerTemplateBody = await readFile(
  new URL('../deploy/saml-idp-workload.yaml', import.meta.url),
  'utf8'
);
const bootstrapBody = await readFile(
  new URL('../deploy/saml-idp-bootstrap-roles.yaml', import.meta.url),
  'utf8'
);
const bootstrapOperator = parse(
  bootstrapBody.slice(bootstrapBody.indexOf('  DbBootstrapOperatorPolicy:')).split('\nOutputs:')[0],
  {
    customTags: [
      { tag: '!Ref', resolve: (value) => ({ Ref: value }) },
      { tag: '!Sub', resolve: (value) => ({ 'Fn::Sub': value }) },
      { tag: '!GetAtt', resolve: (value) => ({ 'Fn::GetAtt': value.split('.') }) },
    ],
  }
).DbBootstrapOperatorPolicy.Properties.PolicyDocument.Statement;

test('setup upload and verification reads are granted only on the configured resources', () => {
  const browser = access.Resources.BrowserOperatorPolicy.Properties.PolicyDocument.Statement;
  for (const [statements, bucket] of [
    [browser, 'AssetsBucketName'],
    [bootstrapOperator, 'DbBootstrapAssetsBucketName'],
  ]) {
    assert.deepEqual(
      statements.filter((statement) => statement.Action === 's3:GetBucketVersioning'),
      [
        {
          Effect: 'Allow',
          Action: 's3:GetBucketVersioning',
          Resource: { 'Fn::Sub': `arn:\${AWS::Partition}:s3:::\${${bucket}}` },
        },
      ]
    );
    assert.ok(
      !statements.some((statement) =>
        (JSON.stringify(statement.Action) ?? '').includes('secretsmanager:GetSecretValue')
      )
    );
  }
  assert.deepEqual(
    bootstrapOperator.find((statement) =>
      (JSON.stringify(statement.Action) ?? '').includes('secretsmanager:DescribeSecret')
    ),
    {
      Effect: 'Allow',
      Action: ['secretsmanager:PutSecretValue', 'secretsmanager:DescribeSecret'],
      Resource: { Ref: 'DbBootstrapJobConfigSecretArn' },
    }
  );
  assert.deepEqual(
    bootstrapOperator.find((statement) => statement.Action === 'lambda:GetFunctionConfiguration'),
    {
      Effect: 'Allow',
      Action: 'lambda:GetFunctionConfiguration',
      Resource: {
        'Fn::Sub':
          'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:${WorkloadStackName}-*',
      },
    }
  );
  assert.ok(Buffer.byteLength(bootstrapBody) <= 51_200);
});
const routes = Object.entries(resources).filter(
  ([, resource]) => resource.Type === 'AWS::ApiGatewayV2::Route'
);

test('existing-issuer ingress forwards preflight to the same strict runtime route filter', () => {
  // This stack already forwards all methods; tenant-specific CORS is owned by ar-auth.
  assert.match(issuerTemplateBody, /RouteKey: \$default/u);
  assert.match(issuerTemplateBody, /Target: !Join \['', \['integrations\/', !Ref LambdaIntegration\]\]/u);
  assert.ok(!issuerTemplateBody.includes('CorsConfiguration:'));
  assert.equal(resources.BrowserApi.Properties.CorsConfiguration, undefined);
});

test('browser API exposes only the approved routes and exact authentication preflight paths', () => {
  const expected = [
    'GET /health/ready',
    'GET /login',
    'GET /reauth',
    'GET /api/auth/health',
    'GET /auth/login-challenge',
    'GET /api/sessions/status',
    'POST /api/v1/auth/direct/passkey/login/start',
    'POST /api/v1/auth/direct/passkey/login/finish',
    'POST /api/v1/auth/direct/session',
    'POST /api/v1/login/interactions/start',
    'POST /api/v1/login/interactions/{interactionId}/submit',
    'OPTIONS /api/auth/health',
    'OPTIONS /auth/login-challenge',
    'OPTIONS /api/sessions/status',
    'OPTIONS /api/v1/auth/direct/passkey/login/start',
    'OPTIONS /api/v1/auth/direct/passkey/login/finish',
    'OPTIONS /api/v1/auth/direct/session',
    'OPTIONS /api/v1/login/interactions/start',
    'OPTIONS /api/v1/login/interactions/{interactionId}/submit',
    'GET /saml/idp/metadata',
    'GET /saml/idp/sso',
    'POST /saml/idp/sso',
    'GET /saml/idp/attribute-release-consent',
    'POST /saml/idp/attribute-release-consent',
    'GET /idp/profile/SAML2/Redirect/SSO',
    'POST /idp/profile/SAML2/Redirect/SSO',
    'GET /idp/profile/SAML2/POST/SSO',
    'POST /idp/profile/SAML2/POST/SSO',
    'GET /test-sp/start',
    'POST /test-sp/start',
    'GET /test-sp/metadata',
    'POST /test-sp/acs',
  ];
  for (const [name, route] of routes) {
    const key = route.Properties.RouteKey;
    assert.match(key, /^(GET|POST|OPTIONS) \/[^\s]+$/u, name);
    const path = key.slice(key.indexOf(' ') + 1);
    assert.ok(path.slice(1).split('/').every(Boolean), `${name} has an empty API path segment`);
    assert.ok(!path.includes('+') && !path.includes('*'), `${name} must not be a catch-all`);
    assert.deepEqual(route.Properties.ApiId, { Ref: 'BrowserApi' });
    const integration = path.startsWith('/test-sp/') ? 'SpIntegration' : 'IdpIntegration';
    assert.deepEqual(route.Properties.Target, {
      'Fn::Join': ['', ['integrations/', { Ref: integration }]],
    });
  }
  assert.deepEqual(routes.map(([, route]) => route.Properties.RouteKey).sort(), expected.sort());
  assert.deepEqual(template.Outputs.TestSpUrl.Value, {
    'Fn::Sub': '${BrowserApi.ApiEndpoint}/test-sp/start',
  });
});

test('the publishing stage waits for every route and both restricted invocation permissions', () => {
  assert.deepEqual(
    [...resources.BrowserStage.DependsOn].sort(),
    [...routes.map(([name]) => name), 'IdpInvokePermission', 'SpInvokePermission'].sort()
  );
  assert.equal(resources.BrowserStage.Condition, 'HasWorkload');
  assert.equal(resources.BrowserStage.Properties.StageName, '$default');
  for (const name of ['IdpInvokePermission', 'SpInvokePermission']) {
    const permission = resources[name].Properties;
    assert.equal(permission.Principal, 'apigateway.amazonaws.com');
    assert.deepEqual(permission.SourceAccount, { Ref: 'AWS::AccountId' });
    assert.deepEqual(permission.SourceArn, {
      'Fn::Sub':
        'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${BrowserApi}/*/*',
    });
  }
});

test('endpoint preparation and log recovery cannot publish serving resources', () => {
  assert.equal(template.Parameters.DeployWorkload.Default, 'false');
  assert.deepEqual(template.Conditions.HasWorkload, {
    'Fn::Equals': [{ Ref: 'DeployWorkload' }, 'true'],
  });
  assert.deepEqual(
    Object.entries(resources)
      .filter(([, resource]) => !resource.Condition)
      .map(([name]) => name)
      .sort(),
    ['BrowserApi', 'IdpLogGroup', 'SpLogGroup']
  );
  for (const [name, resource] of Object.entries(resources)) {
    if (!['BrowserApi', 'IdpLogGroup', 'SpLogGroup'].includes(name)) {
      assert.equal(resource.Condition, 'HasWorkload', name);
    }
  }
  const api = resources.BrowserApi.Properties;
  assert.equal(api.ProtocolType, 'HTTP');
  assert.equal(api.DisableExecuteApiEndpoint, false);
  for (const property of ['Target', 'RouteKey', 'Body', 'BodyS3Location']) {
    assert.equal(api[property], undefined, `${property} must not enable API quick-create/import`);
  }
});

test('diagnostic logs retain their names and ownership independently of serving rollback', () => {
  for (const [name, suffix] of [
    ['IdpLogGroup', 'idp'],
    ['SpLogGroup', 'sp'],
  ]) {
    const group = resources[name];
    assert.equal(group.Type, 'AWS::Logs::LogGroup');
    assert.equal(group.Condition, undefined);
    assert.equal(group.DeletionPolicy, 'Retain');
    assert.equal(group.UpdateReplacePolicy, 'Retain');
    assert.equal(group.Properties.RetentionInDays, 14);
    assert.deepEqual(group.Properties.LogGroupName, {
      'Fn::Sub': `/authrim/aws-browser/\${AWS::StackName}/${suffix}`,
    });
  }
});

test('create-time tagging permission is limited to the bound browser API stage collection', () => {
  const statements = access.Resources.BrowserCfnServiceRole.Properties.Policies.flatMap(
    (policy) => policy.PolicyDocument.Statement
  );
  const tagging = statements.filter((statement) =>
    JSON.stringify(statement).includes('apigateway:TagResource')
  );
  assert.deepEqual(tagging, [
    {
      'Fn::If': [
        'HasApiId',
        {
          Effect: 'Allow',
          Action: 'apigateway:TagResource',
          Resource: {
            'Fn::Sub': 'arn:${AWS::Partition}:apigateway:${AWS::Region}::/apis/${ApiId}/stages',
          },
        },
        { Ref: 'AWS::NoValue' },
      ],
    },
  ]);
  assert.ok(!JSON.stringify(statements).includes('%2Fstages%2F*'));
  assert.ok(!JSON.stringify(statements).includes('/stages/*'));
});

test('browser-stack retry and rollback require its dedicated CloudFormation service role', () => {
  const statements = access.Resources.BrowserOperatorPolicy.Properties.PolicyDocument.Statement;
  const retry = statements.filter((statement) =>
    /cloudformation:(UpdateStack|RollbackStack)/u.test(JSON.stringify(statement))
  );
  assert.deepEqual(retry, [
    {
      Effect: 'Allow',
      Action: [
        'cloudformation:CreateChangeSet',
        'cloudformation:UpdateStack',
        'cloudformation:RollbackStack',
      ],
      Resource: {
        'Fn::Sub':
          'arn:${AWS::Partition}:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/${BrowserStackName}/*',
      },
      Condition: {
        ArnEquals: {
          'cloudformation:RoleArn': { 'Fn::GetAtt': ['BrowserCfnServiceRole', 'Arn'] },
        },
      },
    },
  ]);
});
