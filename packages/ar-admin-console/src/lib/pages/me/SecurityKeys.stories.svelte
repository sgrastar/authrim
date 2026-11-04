<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { createFakeSecondFactors } from '#lib/api/fake/second-factors-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SecurityKeys from './SecurityKeys.svelte';

	const { Story } = defineMeta({
		title: 'Pages/My account/Security keys',
		component: SecurityKeys,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'My account → Security keys: the step-up second factors confirmed in addition to the passkey before sensitive operations (L2). Only device-bound keys can be registered. The first key needs only a fresh passkey inside the one-time enrollment window; later keys need a step-up receipt, which the client obtains by itself. An admin who lost every key files a recovery request with a new key: it can be completed 24 hours later, and the admin or another admin of the tenant can cancel it until then.'
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

<Story name="One key">
	{#snippet template()}
		<SecurityKeys client={createFakeSecondFactors({ keys: [{ label: 'YubiKey 5C (blue)' }] })} />
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
