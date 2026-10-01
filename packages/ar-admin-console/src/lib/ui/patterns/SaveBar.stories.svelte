<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { fn } from 'storybook/test';
	import SaveBar from './SaveBar.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Save bar',
		component: SaveBar,
		tags: ['autodocs'],
		args: { dirty: true, saving: false, onsave: fn(), ondiscard: fn() },
		parameters: {
			docs: {
				description: {
					component:
						'Rises from the bottom of the viewport as soon as there are unsaved changes and sinks back once they are saved or discarded; it sticks to the bottom while the page scrolls, so long forms can always be saved or discarded. Pages do not place it themselves — SaveScope does (see Patterns / Save scope).'
				}
			}
		}
	});
</script>

<Story name="Unsaved changes" />

<Story name="Saving" args={{ saving: true }} />
