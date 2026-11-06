<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { createFakeKeyringFactor } from '#lib/api/fake/keyring-factor-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import KeyringPresentationPanel from './KeyringPresentationPanel.svelte';
	import PresentationPanelDemo from './stories/PresentationPanelDemo.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Keyring presentation',
		component: KeyringPresentationPanel,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Keyring as a step-up second factor (OpenID4VP, cross-device). The admin scans the QR code with Authrim Keyring, checks what is being approved, types the two-digit number shown here and confirms with Face ID. The number is never in the QR code, so a photo of the screen is not enough to approve another request; a wrong number ends the request for good. Shown inside the step-up dialog and when registering Keyring; the flow polls every two seconds while the page is visible.'
				}
			}
		}
	});
</script>

<Story
	name="Waiting"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('kp.code.label'));
		expect(canvas.getByText(t('kp.step.scan'))).toBeTruthy();
	}}
>
	{#snippet template()}
		<PresentationPanelDemo client={createFakeKeyringFactor({ outcome: 'pending' })} />
	{/snippet}
</Story>

<Story name="Answered and confirmed">
	{#snippet template()}
		<PresentationPanelDemo client={createFakeKeyringFactor({ answerAfterMs: 3_000 })} />
	{/snippet}
</Story>

<Story
	name="Wrong number"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('kp.failed.matchCode'), undefined, {
			timeout: 8_000
		});
	}}
>
	{#snippet template()}
		<PresentationPanelDemo
			client={createFakeKeyringFactor({
				outcome: 'match_code_mismatch',
				answerAfterMs: 1_000,
				checkMs: 1_000
			})}
		/>
	{/snippet}
</Story>

<Story name="Credential revoked">
	{#snippet template()}
		<PresentationPanelDemo
			client={createFakeKeyringFactor({
				outcome: 'credential_not_active',
				answerAfterMs: 1_000,
				checkMs: 1_000
			})}
		/>
	{/snippet}
</Story>

<Story name="Time ran out">
	{#snippet template()}
		<PresentationPanelDemo client={createFakeKeyringFactor({ outcome: 'pending', ttlMs: 5_000 })} />
	{/snippet}
</Story>

<Story
	name="No Keyring registered"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('kp.error.notRegistered'));
	}}
>
	{#snippet template()}
		<PresentationPanelDemo client={createFakeKeyringFactor({ refuse: 'keyring_not_registered' })} />
	{/snippet}
</Story>
