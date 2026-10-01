<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { sample } from '../stories/sample';
	import IconButton from './IconButton.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Icon button',
		component: IconButton,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Icon-only action. `label` is required: it is the accessible name and the tooltip. `dot` marks something that needs attention.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<div style="display:flex;gap:8px">
			<IconButton icon="bell" label={sample('notifications')} dot />
			<IconButton icon="gear" label={sample('settings')} />
			<IconButton icon="close" label={sample('close')} />
		</div>
	{/snippet}
</Story>
