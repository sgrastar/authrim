import { AwsSetupError } from './setup-aws-cli.mjs';
import { canonicalSetupJson, setupDigest } from './setup-execution-state.mjs';

const fail = (code) => {
  throw new AwsSetupError(`aws_setup_${code}`);
};
const complete = (status) =>
  ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE'].includes(status);
const pending = (status) => typeof status === 'string' && status.endsWith('_IN_PROGRESS');

export async function assertSetupIdentity(aws, expected, target) {
  const identity = await aws('sts', 'get-caller-identity');
  if (identity.Account !== target.accountId) fail('account_mismatch');
  if (expected.principalArn.includes(':role/')) {
    const name = expected.principalArn.split('/').at(-1);
    const result = await aws('iam', 'get-role', { RoleName: name });
    if (
      result.Role?.Arn !== expected.principalArn ||
      !result.Role.RoleId ||
      !identity.UserId?.startsWith(`${result.Role.RoleId}:`) ||
      !identity.Arn?.startsWith(`arn:aws:sts::${target.accountId}:assumed-role/${name}/`)
    )
      fail('principal_mismatch');
  } else if (identity.Arn !== expected.principalArn) fail('principal_mismatch');
  return { accountId: target.accountId, principalArn: expected.principalArn };
}

export function validateSetupChanges(changes, body) {
  const resources = body.split('\nResources:\n')[1]?.split(/\n[A-Za-z][A-Za-z0-9]*:/u)[0];
  if (!resources || !Array.isArray(changes)) fail('change_set_invalid');
  const allowed = new Map(
    [
      ...resources.matchAll(
        /^  ([A-Za-z0-9]+):\n(?:[^\n]*\n)*?    Type: ['"]?(AWS::[A-Za-z0-9:]+)['"]?\s*$/gmu
      ),
    ].map((match) => [match[1], match[2]])
  );
  for (const change of changes) {
    const resource = change.ResourceChange;
    if (
      change.Type !== 'Resource' ||
      !resource ||
      allowed.get(resource.LogicalResourceId) !== resource.ResourceType ||
      !['Add', 'Modify'].includes(resource.Action) ||
      (resource.Action === 'Modify' && resource.Replacement !== 'False')
    )
      fail('destructive_or_unknown_change');
  }
}

function templateBody(value) {
  if (typeof value !== 'string') fail('template_response_invalid');
  return value;
}
function outputRecord(stack, body) {
  const section = body.split('\nOutputs:\n')[1] ?? '';
  const allowed = new Set([...section.matchAll(/^  ([A-Za-z0-9]+):/gmu)].map((match) => match[1]));
  return Object.fromEntries(
    (stack.Outputs ?? [])
      .filter((item) => allowed.has(item.OutputKey))
      .map((item) => {
        if (typeof item.OutputValue !== 'string' || item.OutputValue.length > 2048)
          fail('stack_output_invalid');
        return [item.OutputKey, item.OutputValue];
      })
  );
}
async function stackOrMissing(aws, name) {
  try {
    const result = await aws('cloudformation', 'describe-stacks', { StackName: name });
    if (result.Stacks?.length !== 1) fail('stack_response_invalid');
    return result.Stacks[0];
  } catch (error) {
    if (error.code === 'aws_setup_not_found') return undefined;
    throw error;
  }
}

/** One bounded observation per call. Resume reconciles the same named change set; never deletes or rolls back. */
export async function executeSetupStack({
  aws,
  state,
  stage,
  save,
  spec,
  body,
  parameters,
  roleArn,
  allowUpdate = false,
  expectedStackId,
}) {
  const inputHash = setupDigest(
    canonicalSetupJson({
      template: setupDigest(body),
      parameters,
      roleArn: roleArn ?? null,
      stack: spec.name,
    })
  );
  let record = state.stages[stage];
  if (record && record.inputHash !== inputHash) fail('stage_inputs_changed');
  if (spec.disposition === 'reuse' && !allowUpdate) {
    const stack = await stackOrMissing(aws, spec.stackId);
    if (!stack || stack.StackId !== spec.stackId || !complete(stack.StackStatus))
      fail('reuse_stack_not_ready');
    const template = await aws('cloudformation', 'get-template', {
      StackName: stack.StackId,
      TemplateStage: 'Original',
    });
    if (setupDigest(templateBody(template.TemplateBody)) !== spec.templateSha256)
      fail('reuse_template_changed');
    const actual = Object.fromEntries(
      (stack.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue])
    );
    for (const [key, value] of Object.entries(spec.parameters ?? {}))
      if (actual[key] !== value) fail('reuse_parameters_changed');
    record = {
      status: 'complete',
      inputHash,
      stackId: stack.StackId,
      parameters: actual,
      outputs: outputRecord(stack, body),
    };
    state.stages[stage] = record;
    await save();
    return record;
  }
  let stack = await stackOrMissing(aws, record?.stackId ?? expectedStackId ?? spec.name);
  if (!record) {
    if (stack && (!allowUpdate || !expectedStackId || stack.StackId !== expectedStackId))
      fail('stack_already_exists');
    if (stack && !complete(stack.StackStatus)) fail('stack_not_ready');
    const requestId = setupDigest(`${state.operationId}:${stage}:${inputHash}`).slice(0, 48);
    record = {
      status: 'preparing',
      inputHash,
      changeSetName: `authrim-${stage}-${requestId}`,
      requestId,
      changeSetType: stack ? 'UPDATE' : 'CREATE',
      ...(stack ? { stackId: stack.StackId } : {}),
    };
    state.stages[stage] = record;
    await save();
  }
  if (stack && record.stackId && stack.StackId !== record.stackId) fail('stack_identity_changed');
  let change;
  try {
    change = await aws('cloudformation', 'describe-change-set', {
      StackName: record.stackId ?? spec.name,
      ChangeSetName: record.changeSetName,
    });
  } catch (error) {
    if (error.code !== 'aws_setup_not_found') throw error;
    if (record.status !== 'preparing') fail('change_set_missing');
    await aws('cloudformation', 'validate-template', { TemplateBody: body });
    const result = await aws('cloudformation', 'create-change-set', {
      StackName: record.stackId ?? spec.name,
      ChangeSetName: record.changeSetName,
      ChangeSetType: record.changeSetType,
      ClientToken: record.requestId,
      TemplateBody: body,
      Parameters: Object.entries(parameters)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
      Capabilities: ['CAPABILITY_NAMED_IAM'],
      ...(roleArn ? { RoleARN: roleArn } : {}),
      Description: `Authrim ${stage}; pinned input ${inputHash}`,
    });
    if (typeof result.StackId !== 'string' || typeof result.Id !== 'string')
      fail('change_set_response_invalid');
    record.stackId = result.StackId;
    record.changeSetId = result.Id;
    await save();
    return { ...record, status: 'inProgress' };
  }
  if (change.StackId !== record.stackId && record.stackId) fail('change_set_stack_mismatch');
  // DescribeChangeSet does not return RoleARN. Pin the submitted request and exact description,
  // then verify the stack's service role after execution; never invent a response field.
  if (
    change.ChangeSetName !== record.changeSetName ||
    change.Description !== `Authrim ${stage}; pinned input ${inputHash}`
  )
    fail('change_set_identity_mismatch');
  record.stackId = change.StackId;
  record.changeSetId = change.ChangeSetId;
  if (change.NextToken) fail('change_set_too_large');
  if (change.Status === 'CREATE_PENDING' || change.Status === 'CREATE_IN_PROGRESS')
    return { ...record, status: 'inProgress' };
  if (change.Status === 'FAILED') {
    if (!/didn.t contain changes|No updates are to be performed/iu.test(change.StatusReason ?? ''))
      fail('change_set_failed');
  } else {
    if (change.Status !== 'CREATE_COMPLETE') fail('change_set_failed');
    validateSetupChanges(change.Changes, body);
    const actualParameters = Object.fromEntries(
      (change.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue])
    );
    for (const [key, value] of Object.entries(parameters))
      if (actualParameters[key] !== value) fail('change_set_parameters_mismatch');
    const template = await aws('cloudformation', 'get-template', {
      StackName: record.stackId,
      ChangeSetName: record.changeSetId,
      TemplateStage: 'Original',
    });
    if (templateBody(template.TemplateBody) !== body) fail('change_set_template_mismatch');
    if (change.ExecutionStatus === 'AVAILABLE') {
      record.status = 'executing';
      await save();
      await aws('cloudformation', 'execute-change-set', {
        StackName: record.stackId,
        ChangeSetName: record.changeSetId,
        ClientRequestToken: record.requestId,
        DisableRollback: true,
      });
      return { ...record, status: 'inProgress' };
    }
    if (!['EXECUTE_IN_PROGRESS', 'EXECUTE_COMPLETE'].includes(change.ExecutionStatus))
      fail('change_set_execution_failed');
  }
  stack = await stackOrMissing(aws, record.stackId);
  if (!stack) fail('stack_missing');
  if (pending(stack.StackStatus)) return { ...record, status: 'inProgress' };
  if (!complete(stack.StackStatus)) fail('stack_failed_requires_review');
  if (roleArn && stack.RoleARN !== roleArn) fail('stack_role_changed');
  const deployed = await aws('cloudformation', 'get-template', {
    StackName: record.stackId,
    TemplateStage: 'Original',
  });
  if (templateBody(deployed.TemplateBody) !== body) fail('deployed_template_changed');
  const actual = Object.fromEntries(
    (stack.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue])
  );
  for (const [key, value] of Object.entries(parameters))
    if (actual[key] !== value) fail('deployed_parameters_changed');
  record.status = 'complete';
  record.parameters = actual;
  record.outputs = outputRecord(stack, body);
  await save();
  return record;
}
