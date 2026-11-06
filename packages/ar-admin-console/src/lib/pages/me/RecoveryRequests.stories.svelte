<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { createFakeSecondFactors } from '#lib/api/fake/second-factors-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import RecoveryRequests from './RecoveryRequests.svelte';

	const { Story } = defineMeta({
		title: 'Pages/My account/Recovery requests of other admins',
		component: RecoveryRequests,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The open second-factor recovery requests of the tenant’s other admins (a new security key or Keyring), with the kind of factor each would install, each of which can be cancelled during its 24-hour wait (admin users write permission and a fresh passkey). The card shows only while there is a request; an admin who may not read the tenant’s admins sees nothing.'
				}
			}
		}
	});
</script>

<Story
	name="Open requests"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('hanako.sato@example.com');
		await expect(canvas.getAllByRole('button', { name: t('sk.others.cancel') })).toHaveLength(2);
		// Which kind of factor each request would install.
		await expect(canvas.getByText(t('kp.kind.keyring'))).toBeInTheDocument();
		await expect(canvas.getByText(t('kp.kind.securityKey'))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<RecoveryRequests
			canCancel
			client={createFakeSecondFactors({
				tenantRequests: [
					{ email: 'hanako.sato@example.com', waitingHours: 3 },
					{ email: 'ops-admin@example.com', waitingHours: 20, kind: 'keyring_holder_key' }
				]
			})}
		/>
	{/snippet}
</Story>

<Story name="Load failed">
	{#snippet template()}
		<RecoveryRequests client={createFakeSecondFactors({ fail: 500 })} />
	{/snippet}
</Story>

<Story
	name="View only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('hanako.sato@example.com');
		// Reading the tenant's admins is not cancelling their requests.
		await expect(canvas.queryByRole('button', { name: t('sk.others.cancel') })).toBeNull();
	}}
>
	{#snippet template()}
		<RecoveryRequests
			client={createFakeSecondFactors({
				tenantRequests: [{ email: 'hanako.sato@example.com', waitingHours: 3 }]
			})}
		/>
	{/snippet}
</Story>
