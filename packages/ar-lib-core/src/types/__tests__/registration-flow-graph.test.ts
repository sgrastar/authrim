import { describe, expect, it } from 'vitest';
import { validateFlowEditorState } from '../../schemas/flow-runtime';
import {
  buildRegistrationFlowEditor,
  defaultRegistrationFlowSpec,
  readRegistrationFlowEditor,
  type RegistrationFlowSpec,
} from '../registration-flow-graph';

const errorsOf = (editor: unknown) =>
  validateFlowEditorState(editor, { for_publish: true }).filter((issue) => issue.level === 'error');

describe('a sign-up Flow’s graph', () => {
  it('builds the default as a Flow that can be published', () => {
    const editor = buildRegistrationFlowEditor(defaultRegistrationFlowSpec());
    expect(editor.nodes.map((node) => node.id)).toEqual([
      'request',
      'registration',
      'email-check',
      'account-create',
      'output',
    ]);
    expect(errorsOf(editor)).toEqual([]);
    // The method chosen goes on by order: no edge is tied to a method.
    expect(editor.edges.some((edge) => edge.source === 'registration')).toBe(false);
  });

  it('reads back the spec it was built from', () => {
    const spec: RegistrationFlowSpec = {
      ...defaultRegistrationFlowSpec(),
      profileRef: 'members',
      screenKey: 'registration_custom',
      screenTitle: 'Your details',
      screens: [
        {
          n: 1,
          screenKey: 'survey',
          exits: { social: 'complete', skipped: 'screen:2', submitted: 'complete' },
        },
        { n: 2, screenKey: 'more', title: 'Last step', exits: {} },
      ],
    };
    spec.policy.email_check = 'later';
    const editor = buildRegistrationFlowEditor(spec);
    expect(editor.nodes.map((node) => node.id)).toEqual([
      'request',
      'registration',
      'screen-1',
      'screen-2',
      'account-create',
      'output',
    ]);
    expect(errorsOf(editor)).toEqual([]);
    expect(readRegistrationFlowEditor(editor)).toEqual(spec);
  });

  it('leaves out an exit to nowhere it knows', () => {
    const spec: RegistrationFlowSpec = {
      ...defaultRegistrationFlowSpec(),
      screens: [{ n: 1, screenKey: 'survey', exits: { social: 'screen:9', Bad: 'complete' } }],
    };
    const edges = buildRegistrationFlowEditor(spec).edges.filter(
      (edge) => edge.source === 'screen-1'
    );
    expect(edges.map((edge) => edge.source_handle)).toEqual(['submitted']);
  });

  it('reads nothing from a graph of another shape', () => {
    expect(readRegistrationFlowEditor({ nodes: [], edges: [] })).toBeNull();
    expect(readRegistrationFlowEditor(null)).toBeNull();
  });
});
