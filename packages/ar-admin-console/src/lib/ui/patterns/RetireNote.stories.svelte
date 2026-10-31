<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { sample } from '../stories/sample';
	import RetireNote from './RetireNote.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Retire note',
		component: RetireNote,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'On an area scheduled for removal: what must be resolved before it can go. The area stays in the navigation until then so the work is not forgotten.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<RetireNote
			title={sample('retireTitle')}
			description={sample('retireDesc')}
			items={[
				{ title: sample('retire1t'), detail: sample('retire1d') },
				{ title: sample('retire2t'), detail: sample('retire2d') }
			]}
			footnote={sample('retireFoot')}
		/>
	{/snippet}
</Story>
