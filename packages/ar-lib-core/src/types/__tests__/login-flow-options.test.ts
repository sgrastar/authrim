import { describe, expect, it } from 'vitest';
import {
  applyLoginFlowSpec,
  buildLoginFlowEditor,
  defaultLoginFlowSpec,
  readLoginFlowEditor,
} from '../login-flow-graph';
import { signInOptionsOfRuntime } from '../../services/flow-profile-refs';

describe('a sign-in Flow’s options', () => {
  it('starts from the safe defaults and writes nothing for them', () => {
    const editor = buildLoginFlowEditor(defaultLoginFlowSpec());
    const step = editor.nodes.find((node) => node.type === 'authentication');
    expect(step?.config).not.toHaveProperty('unregistered_signin');
    expect(step?.config).not.toHaveProperty('on_cancel');
    expect(readLoginFlowEditor(editor)).toMatchObject({
      unregistered: 'generic',
      onCancel: 'stay',
    });
  });

  it('saves what is chosen, reads it back, and clears it when set back', () => {
    const spec = { ...defaultLoginFlowSpec(), unregistered: 'guide', onCancel: 'error' } as const;
    const editor = buildLoginFlowEditor(spec);
    expect(readLoginFlowEditor(editor)).toMatchObject({ unregistered: 'guide', onCancel: 'error' });
    const back = applyLoginFlowSpec(editor, defaultLoginFlowSpec());
    const step = back?.nodes.find((node) => node.type === 'authentication');
    expect(step?.config).not.toHaveProperty('unregistered_signin');
    expect(step?.config).not.toHaveProperty('on_cancel');
  });

  it('reads them from a runtime contract, anything unknown as the safe default', () => {
    const runtime = (config: Record<string, unknown>) => ({
      ui: { steps: [{ component: 'authentication_method_selector', config }] },
    });
    expect(
      signInOptionsOfRuntime(runtime({ unregistered_signin: 'guide', on_cancel: 'error' }))
    ).toEqual({ unregistered: 'guide', onCancel: 'error' });
    expect(signInOptionsOfRuntime(runtime({ unregistered_signin: 'loud', on_cancel: 1 }))).toEqual({
      unregistered: 'generic',
      onCancel: 'stay',
    });
    expect(signInOptionsOfRuntime(null)).toEqual({ unregistered: 'generic', onCancel: 'stay' });
  });
});
