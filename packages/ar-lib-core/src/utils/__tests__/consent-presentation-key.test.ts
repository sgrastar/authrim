import { describe, expect, it } from 'vitest';
import {
  consentPresentationKey,
  consentStepKey,
  destinationPresentationKey,
  type ConsentPresentationItem,
} from '../consent-presentation-key';

const item: ConsentPresentationItem = {
  statement_id: 'terms',
  version: '1',
  version_id: 'v1',
  is_required: true,
  checkbox_mode: 'required',
  content_mode: 'checkbox',
  binding_type: 'scope',
  binding_value: 'email',
  options: [{ value: 'once' }, { value: 'always' }],
};

describe('the key of what a consent step asks', () => {
  it('is the same for the same terms, however the items and the choices are ordered', () => {
    const other: ConsentPresentationItem = { ...item, statement_id: 'privacy' };
    expect(consentPresentationKey({ items: [item, other] })).toBe(
      consentPresentationKey({
        items: [other, { ...item, options: [{ value: 'always' }, { value: 'once' }] }],
      })
    );
  });

  // Every term the key judges: a change in any of them is a change in what is asked.
  it.each([
    ['version', { version: '2' }],
    ['version_id', { version_id: 'v2' }],
    ['is_required', { is_required: false }],
    ['checkbox_mode', { checkbox_mode: 'optional' }],
    ['content_mode', { content_mode: 'radio' }],
    ['binding_type', { binding_type: 'claim' }],
    ['binding_value', { binding_value: 'profile' }],
    ['options', { options: [{ value: 'once' }] }],
  ] as Array<[string, Partial<ConsentPresentationItem>]>)('changes with %s', (_term, change) => {
    expect(consentPresentationKey({ items: [{ ...item, ...change }] })).not.toBe(
      consentPresentationKey({ items: [item] })
    );
  });

  it('changes with the statements', () => {
    expect(
      consentPresentationKey({ items: [item, { ...item, statement_id: 'privacy' }] })
    ).not.toBe(consentPresentationKey({ items: [item] }));
  });

  it('judges a destination by its profile, consent version and required fields', () => {
    const destination = {
      profile_id: 'p',
      profile_version_id: 'pv',
      consent_version: '1',
      fields: [{ key: 'email', required: false }],
    };
    const key = destinationPresentationKey(destination);

    expect(destinationPresentationKey({ ...destination, profile_id: 'q' })).not.toBe(key);
    expect(destinationPresentationKey({ ...destination, profile_version_id: 'pw' })).not.toBe(key);
    expect(destinationPresentationKey({ ...destination, consent_version: '2' })).not.toBe(key);
    expect(
      destinationPresentationKey({ ...destination, fields: [{ key: 'email', required: true }] })
    ).not.toBe(key);
  });

  it('makes a step key of the policy and the destination, either of which may be absent', () => {
    expect(consentStepKey(null, null)).toBe(JSON.stringify([null, null]));
    expect(consentStepKey({ items: [item] }, null)).toBe(
      JSON.stringify([consentPresentationKey({ items: [item] }), null])
    );
  });
});
