import { describe, expect, it, vi } from 'vitest';

vi.mock('@simplewebauthn/browser', () => ({
	startAuthentication: vi.fn(),
	WebAuthnAbortService: { cancelCeremony: vi.fn() }
}));

import { ApiError } from './api-error';
import {
	STEP_UP_RECEIPT_HEADER,
	StepUpCancelledError,
	fetchStepUpRequirements,
	stepUpFactorsNeeded,
	stepUpHeaders,
	stepUpRequired,
	withStepUp,
	type StepUpPromptRequest,
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

describe('withStepUp asks before a step-up', () => {
	const freshAuth = () => new ApiError(403, 'admin_fresh_auth_required', 'x');
	const l2 = (missing: string[]) =>
		new ApiError(403, 'step_up_required', 'x', {
			step_up_id: 'asr_1',
			missing,
			required_level: 'L2'
		});
	const answering = (go: boolean) => {
		const asked: StepUpPromptRequest[] = [];
		const prompt = vi.fn(async (request: StepUpPromptRequest) => {
			asked.push(request);
			return go;
		});
		return { asked, prompt };
	};
	const requirementsOf = (
		level: 'L0' | 'L1' | 'L2',
		passkeyUntil: number | null = null,
		secondFactorUntil: number | null = null
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
			'webhook.destination.update': { level, catalog_level: 'L2', always_enforced: false }
		}
	});

	it('names L1 and the passkey on a fresh-auth refusal, and runs nothing when declined', async () => {
		const { asked, prompt } = answering(false);
		const flow = { ...steps(), prompt };
		const operation = vi.fn().mockRejectedValueOnce(freshAuth());
		await expect(withStepUp(operation, flow)).rejects.toBeInstanceOf(StepUpCancelledError);
		expect(asked).toEqual([{ level: 'L1', factors: ['passkey'] }]);
		expect(flow.reauthenticate).not.toHaveBeenCalled();
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('reports a declined step-up as a declined ceremony is reported', () => {
		expect(new StepUpCancelledError().name).toBe('NotAllowedError');
	});

	it('names the level and the missing checks of an L2 refusal, then makes them', async () => {
		const { asked, prompt } = answering(true);
		const flow = { ...steps(), prompt };
		const operation = vi
			.fn()
			.mockRejectedValueOnce(l2(['passkey', 'second_factor']))
			.mockResolvedValueOnce('done');
		await expect(withStepUp(operation, flow)).resolves.toBe('done');
		expect(asked).toEqual([{ level: 'L2', factors: ['passkey', 'second_factor'] }]);
		expect(flow.reauthenticate).toHaveBeenCalledOnce();
		expect(flow.verifySecondFactor).toHaveBeenCalledOnce();
		expect(operation).toHaveBeenLastCalledWith('asp_receipt');
	});

	it('does not ask when the refusal is missing nothing (the checks are still fresh)', async () => {
		const { prompt } = answering(false);
		const flow = { ...steps(), prompt };
		const operation = vi.fn().mockRejectedValueOnce(l2([])).mockResolvedValueOnce('done');
		await expect(withStepUp(operation, flow)).resolves.toBe('done');
		expect(prompt).not.toHaveBeenCalled();
	});

	it('asks before sending a named operation, makes the checks, then needs only the receipt', async () => {
		const { asked, prompt } = answering(true);
		const order: string[] = [];
		const flow: StepUpSteps = {
			reauthenticate: vi.fn(async () => order.push('passkey')),
			verifySecondFactor: vi.fn(async () => order.push('second_factor')),
			issueReceipt: vi.fn().mockResolvedValue('asp_receipt'),
			requirements: vi.fn().mockResolvedValue(requirementsOf('L2')),
			prompt
		};
		const operation = vi.fn(async (receipt?: string) => {
			order.push(receipt ? 'operation with receipt' : 'operation');
			if (!receipt) throw l2([]);
			return 'done';
		});
		await expect(
			withStepUp(operation, flow, { operation: 'webhook.destination.update' })
		).resolves.toBe('done');
		expect(asked).toEqual([{ level: 'L2', factors: ['passkey', 'second_factor'] }]);
		expect(order).toEqual(['passkey', 'second_factor', 'operation', 'operation with receipt']);
	});

	it('sends nothing when the admin declines beforehand', async () => {
		const { prompt } = answering(false);
		const flow = {
			...steps(),
			requirements: vi.fn().mockResolvedValue(requirementsOf('L2')),
			prompt
		};
		const operation = vi.fn();
		await expect(
			withStepUp(operation, flow, { operation: 'webhook.destination.update' })
		).rejects.toBeInstanceOf(StepUpCancelledError);
		expect(operation).not.toHaveBeenCalled();
		expect(flow.reauthenticate).not.toHaveBeenCalled();
	});

	it('does not ask beforehand for a level-0 operation or fresh checks, nor when the requirements fail', async () => {
		for (const requirements of [
			vi.fn().mockResolvedValue(requirementsOf('L0')),
			vi.fn().mockResolvedValue(requirementsOf('L2', Date.now() + 60_000, Date.now() + 60_000)),
			vi.fn().mockRejectedValue(new Error('offline'))
		]) {
			const { prompt } = answering(true);
			const flow = { ...steps(), requirements, prompt };
			const operation = vi.fn().mockResolvedValue('done');
			await expect(
				withStepUp(operation, flow, { operation: 'webhook.destination.update' })
			).resolves.toBe('done');
			expect(prompt).not.toHaveBeenCalled();
		}
	});

	it('falls back to the refusal when the requirements could not be loaded', async () => {
		const { asked, prompt } = answering(true);
		const flow = {
			...steps(),
			requirements: vi.fn().mockRejectedValue(new Error('offline')),
			prompt
		};
		const operation = vi
			.fn()
			.mockRejectedValueOnce(l2(['passkey']))
			.mockResolvedValueOnce('done');
		await expect(
			withStepUp(operation, flow, { operation: 'webhook.destination.update' })
		).resolves.toBe('done');
		expect(asked).toEqual([{ level: 'L2', factors: ['passkey'] }]);
	});

	it('asks again when the checks made beforehand went stale before the operation', async () => {
		const { asked, prompt } = answering(true);
		const flow = {
			...steps(),
			requirements: vi.fn().mockResolvedValue(requirementsOf('L2')),
			prompt
		};
		const operation = vi
			.fn()
			.mockRejectedValueOnce(l2(['passkey']))
			.mockResolvedValueOnce('done');
		await expect(
			withStepUp(operation, flow, { operation: 'webhook.destination.update' })
		).resolves.toBe('done');
		// Once beforehand (both checks), once more for the passkey that went stale.
		expect(asked).toEqual([
			{ level: 'L2', factors: ['passkey', 'second_factor'] },
			{ level: 'L2', factors: ['passkey'] }
		]);
		expect(flow.reauthenticate).toHaveBeenCalledTimes(2);
	});

	it('asks again on a fresh-auth refusal after the passkey was checked beforehand', async () => {
		const { asked, prompt } = answering(true);
		const flow = {
			...steps(),
			requirements: vi.fn().mockResolvedValue(requirementsOf('L1')),
			prompt
		};
		const operation = vi.fn().mockRejectedValueOnce(freshAuth()).mockResolvedValueOnce('done');
		await expect(
			withStepUp(operation, flow, { operation: 'webhook.destination.update' })
		).resolves.toBe('done');
		expect(asked).toEqual([
			{ level: 'L1', factors: ['passkey'] },
			{ level: 'L1', factors: ['passkey'] }
		]);
	});

	it('renews a step-up that expired while the admin was asked', async () => {
		const { asked, prompt } = answering(true);
		const flow = {
			...steps(),
			issueReceipt: vi
				.fn()
				.mockRejectedValueOnce(new ApiError(400, 'invalid_step_up', 'gone'))
				.mockResolvedValueOnce('asp_new'),
			prompt
		};
		const renewed = new ApiError(403, 'step_up_required', 'x', {
			step_up_id: 'asr_2',
			missing: [],
			required_level: 'L2'
		});
		const operation = vi
			.fn()
			.mockRejectedValueOnce(l2(['passkey']))
			.mockRejectedValueOnce(renewed)
			.mockResolvedValueOnce('done');
		await expect(withStepUp(operation, flow)).resolves.toBe('done');
		// Asked once: the renewed step-up is met by the checks just made.
		expect(asked).toHaveLength(1);
		expect(flow.issueReceipt).toHaveBeenNthCalledWith(2, 'asr_2');
		expect(operation).toHaveBeenLastCalledWith('asp_new');
	});

	const evidence = (missing: string[]) =>
		new ApiError(403, 'step_up_evidence_required', 'x', { missing });

	it('verifies a check that went stale while the admin answered, for the same step-up', async () => {
		const { asked, prompt } = answering(true);
		const flow = {
			...steps(),
			issueReceipt: vi
				.fn()
				.mockRejectedValueOnce(evidence(['second_factor']))
				.mockResolvedValueOnce('asp_receipt'),
			prompt
		};
		const operation = vi
			.fn()
			.mockRejectedValueOnce(l2(['passkey']))
			.mockResolvedValueOnce('done');
		await expect(withStepUp(operation, flow)).resolves.toBe('done');
		expect(asked).toEqual([
			{ level: 'L2', factors: ['passkey'] },
			{ level: 'L2', factors: ['second_factor'] }
		]);
		expect(flow.verifySecondFactor).toHaveBeenCalledOnce();
		expect(flow.issueReceipt.mock.calls).toEqual([['asr_1'], ['asr_1']]);
	});

	it('runs nothing more when the admin declines the stale check', async () => {
		let answers = [true, false];
		const prompt = vi.fn(async () => answers.shift() ?? false);
		const flow = {
			...steps(),
			issueReceipt: vi.fn().mockRejectedValueOnce(evidence(['second_factor'])),
			prompt
		};
		const operation = vi.fn().mockRejectedValueOnce(l2(['passkey']));
		await expect(withStepUp(operation, flow)).rejects.toBeInstanceOf(StepUpCancelledError);
		expect(flow.verifySecondFactor).not.toHaveBeenCalled();
		expect(operation).toHaveBeenCalledTimes(1);
		answers = [];
	});

	it('passes the refusal on after a bounded number of retries', async () => {
		const flow = {
			...steps(),
			issueReceipt: vi.fn().mockRejectedValue(evidence(['second_factor'])),
			prompt: null
		};
		const operation = vi.fn().mockRejectedValueOnce(l2(['passkey']));
		await expect(withStepUp(operation, flow)).rejects.toMatchObject({
			code: 'step_up_evidence_required'
		});
		expect(flow.issueReceipt).toHaveBeenCalledTimes(3);
	});

	it('reads the level a refusal names', () => {
		expect(stepUpRequired(l2(['passkey']))?.level).toBe('L2');
		expect(stepUpRequired(stepUp(['passkey']))?.level).toBeUndefined();
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
