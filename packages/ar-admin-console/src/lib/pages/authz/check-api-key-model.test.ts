import { describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api/api-error.js';
import {
	EMPTY_KEY_FORM,
	isCapabilityRefusal,
	keyInputOf,
	keyProblems,
	keyRefusalText,
	readKeyEnd,
	toggleOperation
} from './check-api-key-model';

const translate = (key: string) => key;

describe('the Create key form', () => {
	it('needs a name, a client and an operation', () => {
		expect(keyProblems({ name: ' ', client_id: '', operations: [] })).toEqual({
			name: 'az.keys.new.nameRequired',
			client_id: 'az.keys.new.clientRequired',
			operations: 'az.keys.new.operationsRequired'
		});
		expect(keyProblems({ name: 'Docs', client_id: 'docs', operations: ['check'] })).toEqual({});
		// The form opens with the one operation most keys need.
		expect(EMPTY_KEY_FORM.operations).toEqual(['check']);
	});

	it('builds the request: trimmed, operations in the offered order, the end as given', () => {
		expect(
			keyInputOf(
				{
					name: ' Docs ',
					client_id: ' docs-backend ',
					operations: ['subscribe', 'batch', 'check']
				},
				5
			)
		).toEqual({
			name: 'Docs',
			client_id: 'docs-backend',
			allowed_operations: ['check', 'batch', 'subscribe'],
			expires_at: 5
		});
	});

	it('ticks and unticks an operation without repeating it', () => {
		expect(toggleOperation(['check'], 'batch', true)).toEqual(['check', 'batch']);
		expect(toggleOperation(['check', 'batch'], 'check', true)).toEqual(['batch', 'check']);
		expect(toggleOperation(['check', 'batch'], 'check', false)).toEqual(['batch']);
	});
});

describe('the end of a key', () => {
	it('is none when empty, and refuses a past or half-typed time', () => {
		expect(readKeyEnd('', false, 'utc')).toEqual({});
		expect(readKeyEnd('', true, 'utc')).toEqual({ problem: 'az.keys.new.endsInvalid' });
		expect(readKeyEnd('x', false, 'utc')).toEqual({ problem: 'az.keys.new.endsInvalid' });
		const now = Date.UTC(2026, 10, 1);
		expect(readKeyEnd('2026-10-01T00:00', false, 'utc', now)).toEqual({
			problem: 'az.keys.new.endsPast'
		});
		expect(readKeyEnd('2026-12-01T00:00', false, 'utc', now)).toEqual({
			ms: Date.UTC(2026, 11, 1)
		});
	});
});

describe('when making a key is refused', () => {
	const capability = new ApiError(403, 'capability_disabled', 'off', {
		error: 'capability_disabled'
	});

	it('says the platform has machine credentials off', () => {
		expect(isCapabilityRefusal(capability)).toBe(true);
		expect(isCapabilityRefusal(new ApiError(403, 'forbidden', 'no', {}))).toBe(false);
		expect(keyRefusalText(capability, translate)).toBe('az.keys.new.capabilityOff');
	});

	it('keeps the API’s words for a value it does not take', () => {
		const invalid = new ApiError(400, 'invalid_request', 'expires_at must be in the future', {
			error: 'invalid_request',
			error_description: 'expires_at must be in the future'
		});
		expect(keyRefusalText(invalid, translate)).toBe(
			'az.error.invalid (expires_at must be in the future)'
		);
	});

	it('does not give away anything for an unknown failure', () => {
		expect(keyRefusalText(new Error('boom'), translate)).toBe('az.error.generic');
	});
});
