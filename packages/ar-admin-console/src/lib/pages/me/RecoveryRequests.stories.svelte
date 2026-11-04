<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { createFakeSecondFactors } from '#lib/api/fake/second-factors-fake.js';
	import RecoveryRequests from './RecoveryRequests.svelte';

	const { Story } = defineMeta({
		title: 'Pages/My account/Recovery requests of other admins',
		component: RecoveryRequests,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The open security-key recovery requests of the tenant’s other admins, each of which can be cancelled during its 24-hour wait (admin users write permission and a fresh passkey). The card shows only while there is a request; an admin who may not read the tenant’s admins sees nothing.'
				}
			}
		}
	});
</script>

<Story name="Open requests">
	{#snippet template()}
		<RecoveryRequests
			client={createFakeSecondFactors({
				tenantRequests: [
					{ email: 'hanako.sato@example.com', waitingHours: 3 },
					{ email: 'ops-admin@example.com', waitingHours: 20 }
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
