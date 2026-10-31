import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createAwsSetupPlan, verifyAwsSetupPlan } from './setup-plan.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'authrim-aws-setup-plan-test-'));
  directories.push(directory);
  const templates = {
    'saml-idp-bootstrap-roles.yaml': `AWSTemplateFormatVersion: '2010-09-09'\nParameters:\n  AccountId:\n    Type: String\nResources:\n  SetupRole:\n    Type: AWS::IAM::Role\n    Properties:\n      RoleName: setup-role\nOutputs:\n  ServiceRoleArn:\n    Value: example\n`,
    'saml-idp-foundation.yaml': `AWSTemplateFormatVersion: '2010-09-09'\nParameters:\n  RegionName:\n    Type: String\nResources:\n  PrivateNetwork:\n    Type: AWS::EC2::VPC\nOutputs:\n  VpcId:\n    Value: example\n`,
    'saml-idp-db-bootstrap.yaml': `AWSTemplateFormatVersion: '2010-09-09'\nParameters:\n  DatabaseHost:\n    Type: String\nResources:\n  BootstrapJob:\n    Type: AWS::Lambda::Function\nOutputs:\n  JobArn:\n    Value: example\n`,
    'saml-idp-workload.yaml': `AWSTemplateFormatVersion: '2010-09-09'\nParameters:\n  IssuerHost:\n    Type: String\nResources:\n  RuntimeRole:\n    Type: AWS::IAM::Role\n    Properties:\n      RoleName: runtime-role\nOutputs:\n  ApiId:\n    Value: example\n`,
  };
  for (const [name, body] of Object.entries(templates)) {
    await writeFile(join(directory, name), body);
  }
  return directory;
}

const target = {
  accountId: '123456789012',
  region: 'ap-northeast-1',
};
const planSha256 = (plan) =>
  createHash('sha256')
    .update(`${JSON.stringify(plan)}\n`)
    .digest('hex');

test('records exact template bytes and a pending issuer without contacting AWS', async () => {
  const templateDirectory = await fixture();
  const plan = await createAwsSetupPlan({ ...target, templateDirectory });
  assert.equal(plan.target.issuerHost, null);
  assert.deepEqual(
    plan.phases.map((phase) => phase.id),
    [
      'role_bootstrap',
      'foundation',
      'database_bootstrap',
      'role_bootstrap_bind',
      'offline_restore',
      'workload',
      'dns_cutover',
    ]
  );
  assert.ok(plan.phases[5].pending.includes('issuer_host'));
  assert.ok(plan.phases[3].pending.includes('exact_foundation_vpc_id'));
  assert.equal(plan.stacks.foundation, 'authrim-dr-foundation');
  assert.equal(plan.stacks.databaseBootstrap, 'authrim-dr-db-bootstrap');
  assert.equal(plan.phases[2].template, 'databaseBootstrap');
  assert.deepEqual(plan.templates.databaseBootstrap.resourceTypes, ['AWS::Lambda::Function']);
  assert.deepEqual(plan.templates.roleBootstrap.parameters, ['AccountId']);
  assert.deepEqual(plan.templates.roleBootstrap.outputs, ['ServiceRoleArn']);
  assert.deepEqual(plan.templates.roleBootstrap.resourceTypes, ['AWS::IAM::Role']);
  assert.deepEqual(plan.templates.roleBootstrap.capabilities, ['CAPABILITY_NAMED_IAM']);
  assert.deepEqual(plan.templates.workload.capabilities, ['CAPABILITY_NAMED_IAM']);
  const bytes = await readFile(plan.templates.foundation.path);
  assert.equal(plan.templates.foundation.sha256, createHash('sha256').update(bytes).digest('hex'));
  await verifyAwsSetupPlan(plan, { templateDirectory, expectedPlanSha256: planSha256(plan) });
});

test('rejects a changed template and a rewritten plan', async () => {
  const templateDirectory = await fixture();
  const plan = await createAwsSetupPlan({ ...target, templateDirectory });
  await writeFile(plan.templates.foundation.path, 'changed template');
  await assert.rejects(
    verifyAwsSetupPlan(plan, { templateDirectory, expectedPlanSha256: planSha256(plan) }),
    /aws_setup_plan_invalid/u
  );

  const fresh = await fixture();
  const clean = await createAwsSetupPlan({ ...target, templateDirectory: fresh });
  await assert.rejects(
    verifyAwsSetupPlan(clean, { templateDirectory: fresh }),
    /aws_setup_plan_invalid/u
  );
  await assert.rejects(
    verifyAwsSetupPlan(
      { ...clean, privateKey: 'must-not-enter-plan' },
      { templateDirectory: fresh, expectedPlanSha256: planSha256(clean) }
    ),
    /aws_setup_plan_invalid/u
  );
  await assert.rejects(
    verifyAwsSetupPlan(
      { ...clean, target: { ...clean.target, accountId: '999999999999' } },
      { templateDirectory: fresh, expectedPlanSha256: planSha256(clean) }
    ),
    /aws_setup_plan_invalid/u
  );
});

test('rejects secret-bearing fields, URL-shaped issuer, and malformed target identity', async () => {
  const templateDirectory = await fixture();
  for (const input of [
    { ...target, templateDirectory, databaseUrl: 'postgres://user:password@host/db' },
    { ...target, templateDirectory, issuerHost: 'https://issuer.example.test' },
    { ...target, templateDirectory, issuerHost: 'secret:private-key' },
    { ...target, templateDirectory, accountId: '000000000000; aws configure' },
    { ...target, templateDirectory, region: 'ap-northeast-1 --profile other' },
  ]) {
    await assert.rejects(createAwsSetupPlan(input), /aws_setup_plan_invalid/u);
  }
});
