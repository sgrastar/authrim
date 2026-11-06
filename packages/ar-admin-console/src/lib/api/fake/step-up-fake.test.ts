import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@simplewebauthn/browser', () => ({
	startAuthentication: vi.fn(),
	WebAuthnAbortService: { cancelCeremony: vi.fn() }
}));

import { setStepUpPrompt, StepUpCancelledError, type StepUpPromptRequest } from '../admin-step-up';
import { createFakeNoticeDelivery } from './notice-delivery-fake';
import { createFakeStepUp } from './step-up-fake';

let unregister: (() => void) | undefined;
afterEach(() => unregister?.());

function answering(go: boolean) {
	const asked: StepUpPromptRequest[] = [];
	unregister = setStepUpPrompt(async (request) => {
		asked.push(request);
		return go;
	});
	return asked;
}

describe('createFakeStepUp', () => {
	it('asks through the registered dialog, then runs the operation; fresh checks ask nothing', async () => {
		const asked = answering(true);
		const stepUp = createFakeStepUp();
		const perform = vi.fn().mockResolvedValue('done');
		await expect(stepUp.run('webhook.destination.update', perform)).resolves.toBe('done');
		expect(asked).toEqual([{ level: 'L2', factors: ['passkey', 'second_factor'] }]);
		// Within the window the checks still hold.
		await expect(stepUp.run('webhook.destination.update', perform)).resolves.toBe('done');
		expect(asked).toHaveLength(1);
		expect(perform).toHaveBeenCalledTimes(2);
	});

	it('runs nothing when declined, and nothing is asked for an L0 operation', async () => {
		answering(false);
		const stepUp = createFakeStepUp();
		const perform = vi.fn().mockResolvedValue('done');
		await expect(stepUp.run('webhook.destination.update', perform)).rejects.toBeInstanceOf(
			StepUpCancelledError
		);
		expect(perform).not.toHaveBeenCalled();
		await expect(stepUp.run('notice.preferences.update', perform)).resolves.toBe('done');
	});

	it('asks again once the window has passed, or after expire()', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(Date.UTC(2026, 10, 6));
			const asked = answering(true);
			const stepUp = createFakeStepUp({ windowMs: 60_000 });
			const perform = async () => 'done';
			await stepUp.run('webhook.destination.update', perform);
			vi.setSystemTime(Date.UTC(2026, 10, 6) + 59_000);
			await stepUp.run('webhook.destination.update', perform);
			expect(asked).toHaveLength(1);
			vi.setSystemTime(Date.UTC(2026, 10, 6) + 61_000);
			await stepUp.run('webhook.destination.update', perform);
			expect(asked).toHaveLength(2);
			stepUp.expire();
			await stepUp.run('webhook.destination.update', perform);
			expect(asked).toHaveLength(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it('asks for an L1 operation’s passkey alone', async () => {
		const asked = answering(true);
		await createFakeStepUp().run('admin.passkey.add', async () => 'done');
		expect(asked).toEqual([{ level: 'L1', factors: ['passkey'] }]);
	});
});

describe('the fake notice delivery with step-up', () => {
	it('changes a webhook URL only after the step-up', async () => {
		const asked = answering(true);
		const client = createFakeNoticeDelivery({ stepUp: createFakeStepUp() });
		const [channel] = await client.listChannels();
		const changed = await client.replaceWebhookUrl(
			channel.id,
			'https://hooks.slack.com/services/T000/B000/newOne'
		);
		expect(asked).toHaveLength(1);
		expect(changed.webhook_url_hint).toBe('…wOne');
	});
});
