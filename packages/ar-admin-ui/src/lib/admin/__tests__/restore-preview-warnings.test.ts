import { describe, expect, it } from 'vitest';
import {
	restorePlatformProfileCheckIncomplete,
	restorePlatformProfileWarnings
} from '../restore-preview-warnings';

const entry = (id: string, kind: string, status: 'resolved' | 'unresolved', required = false) => ({
	id,
	kind,
	status,
	required
});

describe('restorePlatformProfileWarnings', () => {
	it('lists unresolved, non-required platform profiles by kind', () => {
		expect(
			restorePlatformProfileWarnings([
				entry('pmp_a', 'platform_method_profile', 'unresolved'),
				entry('psp_b', 'platform_session_profile', 'unresolved'),
				entry('pmp_ok', 'platform_method_profile', 'resolved'),
				entry('kms/key', 'key_material', 'unresolved'),
				entry('pmp_req', 'platform_method_profile', 'unresolved', true)
			])
		).toEqual([
			{ kind: 'method', id: 'pmp_a' },
			{ kind: 'session', id: 'psp_b' }
		]);
	});

	it('is empty for a preview stored before these warnings existed', () => {
		expect(restorePlatformProfileWarnings([])).toEqual([]);
	});
});

describe('restorePlatformProfileCheckIncomplete', () => {
	it('tells a check that stopped at its limit', () => {
		const entry = { id: 'platform_profiles', status: 'unresolved' as const, required: false };
		expect(
			restorePlatformProfileCheckIncomplete([{ ...entry, kind: 'platform_profile_check' }])
		).toBe(true);
		expect(restorePlatformProfileCheckIncomplete([{ ...entry, kind: 'key_material' }])).toBe(false);
	});
});
