import { describe, expect, it } from 'vitest';
import { decideStepUpSettings } from '../routes/settings-v2/step-up-settings';

const KEY = 'machine_access.all_scope_excluded_tenants';
const decide = (before: Record<string, unknown>, after: Record<string, unknown>, inherited = {}) =>
  decideStepUpSettings({ scopeType: 'platform', before, after, inherited });
const RELAX = { kind: 'gate', operation: 'machine_access.excluded_tenants.relax' };

describe('what counts as loosening the excluded tenants of an all-tenants machine scope', () => {
  it.each([
    ['a tenant dropped', { [KEY]: 'default,acme' }, { [KEY]: 'default' }],
    ['the list emptied', { [KEY]: 'default' }, { [KEY]: '' }],
    ['the list replaced by another tenant', { [KEY]: 'default' }, { [KEY]: 'acme' }],
    ['the saved value cleared under an empty environment', { [KEY]: 'default' }, {}],
    // A stored null reads as every tenant excluded: moving away from it loosens.
    ['a stored null replaced by a list', { [KEY]: null }, { [KEY]: 'default' }],
    ['a stored null replaced by the empty list', { [KEY]: null }, { [KEY]: '' }],
    ['a stored null cleared', { [KEY]: null }, {}],
    ['a value that is not valid replaced by a list', { [KEY]: 'NOT VALID' }, { [KEY]: 'default' }],
  ])('needs the step-up: %s', (_name, before, after) => {
    expect(decide(before, after)).toMatchObject(RELAX);
  });

  it.each([
    ['a tenant added', { [KEY]: 'default' }, { [KEY]: 'default,acme' }],
    ['a list saved over none', {}, { [KEY]: 'default' }],
    ['the same list again', { [KEY]: 'default' }, { [KEY]: 'default' }],
    ['a list replaced by a null (every tenant)', { [KEY]: 'default' }, { [KEY]: null }],
    ['nothing over nothing', {}, { [KEY]: '' }],
  ])('needs no step-up: %s', (_name, before, after) => {
    expect(decide(before, after)).toEqual({ kind: 'none' });
  });

  it('judges a cleared saved value against what the scope inherits', () => {
    // The environment lists a tenant: clearing a saved empty list goes back to it (tighter).
    expect(decide({ [KEY]: '' }, {}, { [KEY]: 'default' })).toEqual({ kind: 'none' });
    // And saving an empty list over an environment list loosens.
    expect(decide({}, { [KEY]: '' }, { [KEY]: 'default' })).toMatchObject(RELAX);
  });
});
