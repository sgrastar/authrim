<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import StatusBadge from './StatusBadge.svelte';

	const { Story } = defineMeta({
		title: 'Components/StatusBadge',
		component: StatusBadge,
		tags: ['autodocs'],
		args: { status: 'active', label: 'Active' },
		parameters: {
			docs: {
				description: {
					component: 'Small coloured pill with an optional dot. Used by the account page.'
				}
			}
		}
	});

	const statuses = [
		'active',
		'inactive',
		'success',
		'warning',
		'danger',
		'info',
		'neutral'
	] as const;
</script>

<Story name="All statuses">
	{#snippet template()}
		<LoginUIFrame>
			<div style="display:flex;gap:10px;flex-wrap:wrap">
				{#each statuses as status (status)}
					<StatusBadge {status} label={status} />
				{/each}
				<StatusBadge status="info" label="no dot" showDot={false} />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>
