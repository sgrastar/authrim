<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { sample } from '../stories/sample';
	import DangerZone from './DangerZone.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Danger zone',
		component: DangerZone,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Irreversible actions, kept at the end of a page and always behind a confirm dialog.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<DangerZone
			title={sample('deleteTenant')}
			description={sample('deleteTenantDesc')}
			actionLabel={sample('delete')}
			confirmTitle={sample('deleteConfirmTitle')}
			confirmBody={sample('deleteConfirmBody')}
			onconfirm={() => new Promise((resolve) => setTimeout(resolve, 600))}
		/>
	{/snippet}
</Story>
