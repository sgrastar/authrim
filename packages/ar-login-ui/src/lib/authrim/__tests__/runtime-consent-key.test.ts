import { describe, expect, it } from 'vitest';
import { consentInputKey, destinationInputKey } from '../runtime-consent-key';

const item = {
	statement_id: 'terms',
	binding_type: 'scope',
	binding_value: 'email',
	version: '1',
	version_id: 'v1',
	is_required: true,
	checkbox_mode: 'required',
	content_mode: 'checkbox',
	options: []
};

describe('the key of what has been ticked on a consent step', () => {
	it('is the same for the same terms', () => {
		expect(consentInputKey('auth:step', { items: [item] })).toBe(
			consentInputKey('auth:step', { items: [{ ...item }] })
		);
	});

	it.each([
		['another version', { version: '2', version_id: 'v2' }],
		['other terms of agreeing', { is_required: false, checkbox_mode: 'optional' }],
		['a choice withdrawn', { content_mode: 'radio', options: [{ value: 'once' }] }],
		['what it applies to', { binding_type: 'scope', binding_value: 'profile' }],
		['the kind of binding', { binding_type: 'claim' }]
	])('changes with %s of a statement that keeps its id', (_label, change) => {
		expect(consentInputKey('auth:step', { items: [{ ...item, ...change }] })).not.toBe(
			consentInputKey('auth:step', { items: [item] })
		);
	});

	it('changes with the step', () => {
		expect(consentInputKey('a', { items: [item] })).not.toBe(
			consentInputKey('b', { items: [item] })
		);
	});

	it('changes for a destination with its consent version and its fields', () => {
		const destination = {
			profile_id: 'p',
			profile_version_id: 'pv',
			consent_version: '1',
			fields: [{ key: 'email', required: false }]
		};
		const key = destinationInputKey('step', destination);

		expect(destinationInputKey('step', { ...destination })).toBe(key);
		expect(destinationInputKey('step', { ...destination, consent_version: '2' })).not.toBe(key);
		expect(
			destinationInputKey('step', { ...destination, fields: [{ key: 'email', required: true }] })
		).not.toBe(key);
	});
});
