<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { createFakeKeyringFactor } from '#lib/api/fake/keyring-factor-fake.js';
	import { createFakeSecondFactors } from '#lib/api/fake/second-factors-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SecurityKeys from './SecurityKeys.svelte';

	/**
	 * A clock that runs about six hours a second, started when the story mounts, shared by the
	 * fake (its request times) and the page.
	 */
	function fastClock() {
		const started = Date.now();
		return { started, now: () => started + (Date.now() - started) * 20_000 };
	}

	const { Story } = defineMeta({
		title: 'Pages/My account/Security keys',
		component: SecurityKeys,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'My account → Security keys: the step-up second factors confirmed in addition to the passkey before sensitive operations (L2). Only device-bound keys can be registered. The first key needs only a fresh passkey inside the one-time enrollment window; later keys need a step-up receipt, which the client obtains by itself. An admin who lost every key files a recovery request with a new key, or with Keyring (presenting their admin credential): it can be completed 24 hours later, and the admin or another admin of the tenant can cancel it until then.'
				}
			}
		}
	});
</script>

<Story
	name="Keys"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('YubiKey 5C (blue)');
		expect(canvas.getByText('YubiKey 5 NFC (spare)')).toBeTruthy();
	}}
>
	{#snippet template()}
		<SecurityKeys
			client={createFakeSecondFactors({
				keys: [{ label: 'YubiKey 5C (blue)' }, { label: 'YubiKey 5 NFC (spare)' }]
			})}
		/>
	{/snippet}
</Story>

<Story
	name="Security key and Keyring"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('iPhone (Keyring)');
		expect(canvas.getByText(t('kp.kind.keyring'))).toBeTruthy();
	}}
>
	{#snippet template()}
		<SecurityKeys
			client={createFakeSecondFactors({
				keys: [
					{ label: 'YubiKey 5C (blue)' },
					{ label: 'iPhone (Keyring)', kind: 'keyring_holder_key' }
				]
			})}
			keyring={createFakeKeyringFactor()}
		/>
	{/snippet}
</Story>

<Story
	name="Add Keyring"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('kp.enroll.add') }));
		await within(canvasElement.ownerDocument.body).findByText(t('kp.code.label'));
	}}
>
	{#snippet template()}
		<SecurityKeys
			client={createFakeSecondFactors({ keys: [{ label: 'YubiKey 5C (blue)' }] })}
			keyring={createFakeKeyringFactor({ answerAfterMs: 5_000 })}
		/>
	{/snippet}
</Story>

<Story
	name="One key"
	play={async ({ canvasElement }) => {
		// A single factor: the page suggests registering another one.
		await within(canvasElement).findByText(t('sk.onlyOne.title'));
	}}
>
	{#snippet template()}
		<SecurityKeys client={createFakeSecondFactors({ keys: [{ label: 'YubiKey 5C (blue)' }] })} />
	{/snippet}
</Story>

<Story
	name="Sole administrator"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Nobody could cancel a recovery: the page says so instead of offering one.
		await canvas.findByText(t('sk.recovery.soleAdmin'));
		expect(canvas.queryByRole('button', { name: t('kp.recover.add') })).toBeNull();
		expect(canvas.queryByRole('button', { name: t('sk.recover') })).toBeNull();
	}}
>
	{#snippet template()}
		<SecurityKeys
			client={createFakeSecondFactors({ keys: [{ label: 'YubiKey 5C (blue)' }], soleAdmin: true })}
		/>
	{/snippet}
</Story>

<Story
	name="Sole administrator with no usable key"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('sk.recoveryNeeded.title'));
		await canvas.findByText(t('sk.recovery.soleAdmin'));
		expect(canvas.queryByRole('button', { name: t('kp.recover.add') })).toBeNull();
	}}
>
	{#snippet template()}
		<SecurityKeys client={createFakeSecondFactors({ soleAdmin: true })} />
	{/snippet}
</Story>

<Story
	name="First key to register"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('sk.empty'));
	}}
>
	{#snippet template()}
		<SecurityKeys client={createFakeSecondFactors({ firstEnrollmentOpen: true })} />
	{/snippet}
</Story>

<Story name="Recovery needed">
	{#snippet template()}
		<SecurityKeys client={createFakeSecondFactors()} />
	{/snippet}
</Story>

<Story
	name="Recovery with Keyring"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('kp.recover.add') }));
		const page = within(canvasElement.ownerDocument.body);
		await page.findByText(t('kp.recover.title'));
		await page.findByText(t('kp.code.label'));
	}}
>
	{#snippet template()}
		<SecurityKeys
			client={createFakeSecondFactors()}
			keyring={createFakeKeyringFactor({ answerAfterMs: 5_000 })}
		/>
	{/snippet}
</Story>

<Story name="Recovery waiting">
	{#snippet template()}
		<SecurityKeys
			client={createFakeSecondFactors({
				keys: [{ label: 'YubiKey 5C (lost)' }],
				recovery: 'waiting'
			})}
		/>
	{/snippet}
</Story>

<Story name="Recovery ready">
	{#snippet template()}
		<SecurityKeys
			client={createFakeSecondFactors({
				keys: [{ label: 'YubiKey 5C (lost)' }],
				recovery: 'ready'
			})}
		/>
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<SecurityKeys client={createFakeSecondFactors({ delay: 1_000_000 })} />
	{/snippet}
</Story>

<Story name="Load failed">
	{#snippet template()}
		<SecurityKeys client={createFakeSecondFactors({ fail: 500 })} />
	{/snippet}
</Story>

<Story
	name="First-key window closes while open"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('sk.add') }));
		const dialog = within(canvasElement.ownerDocument.body);
		await userEvent.click(await dialog.findByRole('button', { name: t('sk.register') }));
		// Recovery is offered instead of a register button that can only fail.
		await canvas.findByText(t('sk.recoveryNeeded.title'));
		await expect(canvas.queryByRole('button', { name: t('sk.add') })).toBeNull();
	}}
>
	{#snippet template()}
		<SecurityKeys
			client={createFakeSecondFactors({ firstEnrollmentOpen: true, windowClosesOnRegister: true })}
		/>
	{/snippet}
</Story>

<Story
	name="Recovery becomes ready while open"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Waiting first: no way to complete yet.
		await canvas.findByText(t('sk.recovery.waiting.title'));
		await expect(canvas.queryByRole('button', { name: t('sk.recovery.complete') })).toBeNull();
		// The clock passes the waiting period without a reload.
		await canvas.findByRole('button', { name: t('sk.recovery.complete') }, { timeout: 8000 });
	}}
>
	{#snippet template()}
		{@const clock = fastClock()}
		<SecurityKeys
			client={createFakeSecondFactors({
				keys: [{ label: 'YubiKey 5C (lost)' }],
				recovery: 'waiting',
				now: clock.started
			})}
			now={clock.now}
			tickMs={100}
		/>
	{/snippet}
</Story>

<Story
	name="Recovery lapses while open"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: t('sk.recovery.complete') });
		// The page's clock passes the expiry first; the server lets go of the request a little
		// later, and the page catches up without a reload.
		await canvas.findByText(t('sk.recoveryNeeded.title'), {}, { timeout: 8000 });
		await expect(canvas.queryByRole('button', { name: t('sk.recovery.complete') })).toBeNull();
	}}
>
	{#snippet template()}
		{@const clock = fastClock()}
		<SecurityKeys
			client={createFakeSecondFactors({
				recovery: 'ready',
				now: clock.started,
				recoveryExpiresInMs: 6 * 60 * 60 * 1000,
				// The server runs three hours behind the page (longer than one answer takes).
				serverClock: () => clock.now() - 3 * 60 * 60 * 1000
			})}
			now={clock.now}
			tickMs={100}
		/>
	{/snippet}
</Story>
