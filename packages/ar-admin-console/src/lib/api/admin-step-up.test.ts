import { describe, expect, it, vi } from 'vitest';

vi.mock('@simplewebauthn/browser', () => ({
	startAuthentication: vi.fn(),
	WebAuthnAbortService: { cancelCeremony: vi.fn() }
}));

import { ApiError } from './api-error';
import {
	STEP_UP_RECEIPT_HEADER,
	fetchStepUpRequirements,
	stepUpFactorsNeeded,
	stepUpHeaders,
	stepUpRequired,
	withStepUp,
	type StepUpRequirements,
	type StepUpSteps
} from './admin-step-up';

const stepUp = (missing: unknown, stepUpId: unknown = 'asr_1') =>
	new ApiError(403, 'step_up_required', 'x', { step_up_id: stepUpId, missing });

function steps(): StepUpSteps & {
	reauthenticate: ReturnType<typeof vi.fn>;
	verifySecondFactor: ReturnType<typeof vi.fn>;
	issueReceipt: ReturnType<typeof vi.fn>;
} {
	return {
		reauthenticate: vi.fn().mockResolvedValue(undefined),
		verifySecondFactor: vi.fn().mockResolvedValue(undefined),
		issueReceipt: vi.fn().mockResolvedValue('asp_receipt')
	};
}

describe('stepUpRequired', () => {
	it('reads the step-up and the factors it is missing', () => {
		expect(stepUpRequired(stepUp(['passkey', 'second_factor', 'retina']))).toEqual({
			stepUpId: 'asr_1',
			missing: ['passkey', 'second_factor']
		});
		expect(stepUpRequired(stepUp('nope'))).toEqual({ stepUpId: 'asr_1', missing: [] });
	});

	it.each([
		['another 403', new ApiError(403, 'forbidden', 'x', { step_up_id: 'asr_1' })],
		['a 401', new ApiError(401, 'step_up_required', 'x', { step_up_id: 'asr_1' })],
		['no step-up id', stepUp(['passkey'], '')],
		['a plain error', new Error('step_up_required')]
	])('ignores %s', (_label, error) => {
		expect(stepUpRequired(error)).toBeNull();
	});
});

describe('withStepUp', () => {
	it('runs an operation that needs no step-up once, without a receipt', async () => {
		const flow = steps();
		const operation = vi.fn().mockResolvedValue('done');
		await expect(withStepUp(operation, flow)).resolves.toBe('done');
		expect(operation).toHaveBeenCalledExactlyOnceWith();
		expect(flow.issueReceipt).not.toHaveBeenCalled();
	});

	it('verifies what is missing in order, then repeats with the receipt', async () => {
		const flow = steps();
		const order: string[] = [];
		flow.reauthenticate.mockImplementation(async () => void order.push('passkey'));
		flow.verifySecondFactor.mockImplementation(async () => void order.push('key'));
		flow.issueReceipt.mockImplementation(async (id: string) => {
			order.push(`receipt:${id}`);
			return 'asp_receipt';
		});
		const operation = vi
			.fn()
			.mockRejectedValueOnce(stepUp(['second_factor', 'passkey']))
			.mockResolvedValueOnce('done');

		await expect(withStepUp(operation, flow)).resolves.toBe('done');
		expect(order).toEqual(['passkey', 'key', 'receipt:asr_1']);
		expect(operation).toHaveBeenLastCalledWith('asp_receipt');
	});

	it('asks only for the factor that is missing', async () => {
		const flow = steps();
		const operation = vi
			.fn()
			.mockRejectedValueOnce(stepUp(['second_factor']))
			.mockResolvedValueOnce('done');
		await withStepUp(operation, flow);
		expect(flow.reauthenticate).not.toHaveBeenCalled();
		expect(flow.verifySecondFactor).toHaveBeenCalledOnce();
	});

	it('re-authenticates for an L1 refusal and repeats without a receipt', async () => {
		const flow = steps();
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(403, 'admin_fresh_auth_required', 'x'))
			.mockResolvedValueOnce('done');
		await expect(withStepUp(operation, flow)).resolves.toBe('done');
		expect(flow.reauthenticate).toHaveBeenCalledOnce();
		expect(flow.issueReceipt).not.toHaveBeenCalled();
		expect(operation).toHaveBeenLastCalledWith();
	});

	it('goes on to the step-up a route asks for after a fresh sign-in', async () => {
		const flow = steps();
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(403, 'wallet_credential_fresh_auth_required', 'x'))
			.mockRejectedValueOnce(stepUp(['passkey', 'second_factor']))
			.mockResolvedValueOnce('done');
		await expect(withStepUp(operation, flow)).resolves.toBe('done');
		// The passkey was just confirmed: only the second factor is asked for.
		expect(flow.reauthenticate).toHaveBeenCalledOnce();
		expect(flow.verifySecondFactor).toHaveBeenCalledOnce();
		expect(flow.issueReceipt).toHaveBeenCalledWith('asr_1');
		expect(operation).toHaveBeenLastCalledWith('asp_receipt');
		expect(operation).toHaveBeenCalledTimes(3);
	});

	it('passes on a second fresh sign-in refusal', async () => {
		const flow = steps();
		const again = new ApiError(403, 'admin_fresh_auth_required', 'again');
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(403, 'admin_fresh_auth_required', 'x'))
			.mockRejectedValueOnce(again);
		await expect(withStepUp(operation, flow)).rejects.toBe(again);
		expect(flow.reauthenticate).toHaveBeenCalledOnce();
		expect(flow.issueReceipt).not.toHaveBeenCalled();
	});

	it('passes a second refusal on without asking again', async () => {
		const flow = steps();
		const again = stepUp(['passkey'], 'asr_2');
		const operation = vi
			.fn()
			.mockRejectedValueOnce(stepUp(['passkey']))
			.mockRejectedValueOnce(again);
		await expect(withStepUp(operation, flow)).rejects.toBe(again);
		expect(flow.reauthenticate).toHaveBeenCalledOnce();
		expect(flow.issueReceipt).toHaveBeenCalledOnce();
	});

	it('passes other errors on untouched', async () => {
		const flow = steps();
		const failure = new ApiError(409, 'second_factor_minimum', 'x');
		await expect(withStepUp(vi.fn().mockRejectedValue(failure), flow)).rejects.toBe(failure);
		expect(flow.reauthenticate).not.toHaveBeenCalled();
	});

	it('stops when a verification is cancelled', async () => {
		const flow = steps();
		const cancelled = new DOMException('cancelled', 'NotAllowedError');
		flow.verifySecondFactor.mockRejectedValue(cancelled);
		const operation = vi.fn().mockRejectedValueOnce(stepUp(['second_factor']));
		await expect(withStepUp(operation, flow)).rejects.toBe(cancelled);
		expect(flow.issueReceipt).not.toHaveBeenCalled();
		expect(operation).toHaveBeenCalledOnce();
	});
});

describe('stepUpHeaders', () => {
	it('carries a receipt only when there is one', () => {
		expect(stepUpHeaders('asp_1')).toEqual({ [STEP_UP_RECEIPT_HEADER]: 'asp_1' });
		expect(stepUpHeaders()).toEqual({});
	});
});

describe('stepUpFactorsNeeded', () => {
	const now = 1_000_000;
	const requirements = (
		passkeyUntil: number | null,
		secondFactorUntil: number | null
	): StepUpRequirements => ({
		tenant_id: 'tenant-a',
		enforced: true,
		evidence_window_seconds: 300,
		evidence: {
			passkey_fresh_until: passkeyUntil,
			second_factor_fresh_until: secondFactorUntil
		},
		second_factor_registered: true,
		operations: {
			'sessions.revoke_all': { level: 'L1', catalog_level: 'L1', always_enforced: false },
			'tenant.delete': { level: 'L2', catalog_level: 'L2', always_enforced: false },
			'dr.restore': { level: 'L0', catalog_level: 'L2', always_enforced: false }
		}
	});

	it('asks for nothing for an L0 or unlisted operation', () => {
		expect(stepUpFactorsNeeded(requirements(null, null), 'dr.restore', now)).toEqual([]);
		expect(stepUpFactorsNeeded(requirements(null, null), 'users.list', now)).toEqual([]);
	});

	it('asks only for what is not fresh', () => {
		expect(stepUpFactorsNeeded(requirements(null, null), 'sessions.revoke_all', now)).toEqual([
			'passkey'
		]);
		expect(stepUpFactorsNeeded(requirements(now + 1, null), 'sessions.revoke_all', now)).toEqual(
			[]
		);
		expect(stepUpFactorsNeeded(requirements(null, null), 'tenant.delete', now)).toEqual([
			'passkey',
			'second_factor'
		]);
		expect(stepUpFactorsNeeded(requirements(now + 1, now + 1), 'tenant.delete', now)).toEqual([]);
		// Freshness that has run out by `now` counts as missing.
		expect(stepUpFactorsNeeded(requirements(now, now + 1), 'tenant.delete', now)).toEqual([
			'passkey'
		]);
	});
});

describe('fetchStepUpRequirements', () => {
	it('reads the requirements and turns a refusal into an ApiError', async () => {
		const body = { tenant_id: 'tenant-a', operations: {} };
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: 'step_up_unavailable' }), { status: 503 })
			);
		vi.stubGlobal('fetch', fetchMock);
		try {
			await expect(fetchStepUpRequirements()).resolves.toEqual(body);
			expect(String(fetchMock.mock.calls[0][0])).toContain('/api/admin/me/step-up/requirements');
			await expect(fetchStepUpRequirements()).rejects.toMatchObject({
				status: 503,
				code: 'step_up_unavailable'
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
