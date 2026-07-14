import type {
  FlowRuntimeComponent,
  FlowRuntimeContract,
  FlowRuntimeStep,
} from '../schemas/flow-runtime';

export interface ServerFlowStepResult {
  handle: string;
}

export type ServerFlowStepHandler<State> = (input: {
  step: FlowRuntimeStep;
  state: State;
}) => Promise<ServerFlowStepResult> | ServerFlowStepResult;

export interface ExecuteServerFlowInput<State> {
  contract: FlowRuntimeContract;
  expectedKind: 'credential_issuance' | 'attribute_elevation';
  state: State;
  handlers: Partial<Record<FlowRuntimeComponent, ServerFlowStepHandler<State>>>;
}

/**
 * Executes non-rendering VC system steps in immutable published order.
 * Interactive LoginUI components are rejected rather than silently skipped.
 */
export async function executeServerFlow<State>(
  input: ExecuteServerFlowInput<State>
): Promise<Array<{ stepId: string; component: FlowRuntimeComponent; handle: string }>> {
  if (input.contract.flow_kind !== input.expectedKind) throw new Error('server_flow_kind_mismatch');
  const results: Array<{ stepId: string; component: FlowRuntimeComponent; handle: string }> = [];
  for (const step of input.contract.ui.steps) {
    if (step.component === 'completion') continue;
    if (step.render) throw new Error('server_flow_interactive_step_not_supported');
    const handler = input.handlers[step.component];
    if (!handler) throw new Error(`server_flow_handler_missing:${step.component}`);
    const result = await handler({ step, state: input.state });
    if (!result.handle) throw new Error('server_flow_empty_handle');
    results.push({ stepId: step.id, component: step.component, handle: result.handle });
  }
  if (results.length === 0) throw new Error('server_flow_has_no_executable_steps');
  return results;
}
