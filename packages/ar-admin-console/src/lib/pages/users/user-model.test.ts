import { describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api/api-error.js';
import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
import { LegalHoldError, LifecycleConflictError } from '#lib/api/admin-users.js';
import {
	actionErrorKey,
	createErrorOf,
	deviceText,
	emailProblem,
	lockEnd,
	phoneProblem,
	profileChange,
	profileFormOf,
	reasonOptions,
	signOutErrorKey,
	suspendHours,
	userLabel
} from './user-model';
import { sampleUsers } from '#lib/api/fake/admin-users-fake.js';

describe('user model', () => {
	it('names a user by name, then address, then id', () => {
		expect(userLabel({ id: 'u1', name: 'A', email: 'a@example.com' })).toBe('A');
		expect(userLabel({ id: 'u1', name: null, email: 'a@example.com' })).toBe('a@example.com');
		expect(userLabel({ id: 'u1', name: null, email: null })).toBe('u1');
	});

	it('checks the address before sending', () => {
		expect(emailProblem('  ')).toBe('usr.new.emailRequired');
		expect(emailProblem('nope')).toBe('usr.new.emailInvalid');
		expect(emailProblem(' a@example.com ')).toBeNull();
	});

	it('puts a taken or malformed address on the email field', () => {
		expect(createErrorOf(new ApiError(409, 'conflict', 'x'))).toEqual({
			key: 'usr.new.emailTaken',
			field: 'email'
		});
		expect(
			createErrorOf(new ApiError(400, 'invalid_request', 'Email must be a valid email address'))
		).toEqual({ key: 'usr.new.emailInvalid', field: 'email' });
	});

	it('keeps other refusals in the dialog', () => {
		expect(
			createErrorOf(
				new ApiError(400, 'invalid_request', 'Missing', { missing_required_fields: [{}] })
			)
		).toEqual({ key: 'usr.new.fieldsRequired', field: null });
		expect(createErrorOf(new ApiError(503, 'temporarily_unavailable', 'x')).key).toBe(
			'usr.new.unavailable'
		);
		expect(createErrorOf(new ApiError(403, 'forbidden', 'x')).key).toBe('usr.new.forbidden');
		expect(createErrorOf(new Error('network')).key).toBe('usr.new.error');
	});
});

describe('user page model', () => {
	it('explains a refusal in the words of its kind', () => {
		expect(actionErrorKey(new LifecycleConflictError('x'))).toBe('usr.error.conflict');
		expect(actionErrorKey(new LegalHoldError('x'))).toBe('usr.error.legalHold');
		expect(actionErrorKey(new ApiError(403, 'forbidden', 'x'))).toBe('usr.error.forbidden');
		expect(actionErrorKey(new ApiError(404, 'not_found', 'x'))).toBe('usr.error.notFound');
		expect(actionErrorKey(new Error('network'))).toBe('usr.error.generic');
	});

	it('tells a declined or unmet step-up from other sign-out failures', () => {
		expect(signOutErrorKey(new StepUpCancelledError())).toBe('usr.d.signOut.cancelled');
		expect(
			signOutErrorKey(
				new ApiError(403, 'step_up_required', 'x', { step_up_id: 's', missing: ['passkey'] })
			)
		).toBe('usr.d.signOut.stepUp');
		expect(signOutErrorKey(new ApiError(403, 'forbidden', 'x'))).toBe('usr.error.forbidden');
		expect(signOutErrorKey(new ApiError(500, 'server_error', 'x'))).toBe('usr.d.signOut.error');
	});

	it('sends only the profile fields that changed, an emptied one as an empty string', () => {
		const user = {
			...sampleUsers()[0],
			name: 'A B',
			given_name: 'A',
			family_name: 'B',
			preferred_username: null,
			phone_number: '+81 90 1234 5678'
		};
		const form = {
			name: ' A B ',
			given_name: 'A',
			family_name: 'C',
			preferred_username: '',
			phone_number: ''
		};
		expect(profileChange(user, form)).toEqual({
			family_name: 'C',
			phone_number: '',
			phone_number_verified: false
		});
		expect(
			profileChange(user, { ...form, family_name: 'B', phone_number: user.phone_number! })
		).toEqual({});
	});

	it('sends the phone number as unverified when it changes, and only then', () => {
		const user = {
			...sampleUsers()[0]!,
			phone_number: '+81 90 1234 5678',
			phone_number_verified: true
		};
		const form = profileFormOf(user);
		expect(profileChange(user, { ...form, phone_number: '+81 90 0000 0000' })).toEqual({
			phone_number: '+81 90 0000 0000',
			phone_number_verified: false
		});
		expect(profileChange(user, { ...form, phone_number: '' })).toEqual({
			phone_number: '',
			phone_number_verified: false
		});
		expect(profileChange(user, { ...form, name: 'Someone else' })).not.toHaveProperty(
			'phone_number_verified'
		);
	});

	it('checks a phone number loosely, and lets it be empty', () => {
		expect(phoneProblem('')).toBeNull();
		expect(phoneProblem('+81 90 1234 5678')).toBeNull();
		expect(phoneProblem('(03) 1234-5678')).toBeNull();
		expect(phoneProblem('call me')).toBe('usr.d.edit.phoneInvalid');
	});

	it('labels every reason with the console’s words', () => {
		const options = reasonOptions(['brute_force', 'other'], (key) => `<${key}>`);
		expect(options).toEqual([
			{ value: 'brute_force', label: '<usr.reason.brute_force>' },
			{ value: 'other', label: '<usr.reason.other>' }
		]);
	});

	it('accepts whole hours from 1 to 8760', () => {
		expect(suspendHours(null)).toEqual({});
		expect(suspendHours(48)).toEqual({ hours: 48 });
		for (const bad of [0, 8761, 1.5, NaN]) {
			expect(suspendHours(bad)).toEqual({ problem: 'usr.suspend.hoursInvalid' });
		}
	});

	it('reads when a lock ends in the chosen zone, and refuses the past', () => {
		const now = Date.UTC(2026, 10, 12);
		expect(lockEnd('', false, 'utc', now)).toEqual({});
		expect(lockEnd('2026-11-13T09:30', false, 'utc', now)).toEqual({
			ms: Date.UTC(2026, 10, 13, 9, 30)
		});
		expect(lockEnd('2026-11-11T09:30', false, 'utc', now)).toEqual({
			problem: 'usr.lock.untilPast'
		});
		expect(lockEnd('2026-11', false, 'utc', now)).toEqual({ problem: 'usr.lock.untilInvalid' });
		expect(lockEnd('', true, 'utc', now)).toEqual({ problem: 'usr.lock.untilInvalid' });
	});

	it('shortens a user agent to browser and system, else to its start', () => {
		expect(
			deviceText(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'
			)
		).toBe('Safari · macOS');
		expect(deviceText('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130')).toBe(
			'Edge · Windows'
		);
		expect(deviceText('curl/8.4.0')).toBe('curl/8.4.0');
		expect(deviceText('x'.repeat(100))).toHaveLength(61);
		expect(deviceText(null)).toBeNull();
	});
});
