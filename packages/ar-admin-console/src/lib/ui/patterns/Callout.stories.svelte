<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { sample } from '../stories/sample';
	import Callout from './Callout.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Callout',
		component: Callout,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Inline message. `info` explains, `warning` asks for attention, `danger` reports a failure. Set `live` for messages that appear after an action so assistive tech announces them.'
				}
			}
		}
	});
</script>

<Story name="Tones">
	{#snippet template()}
		<div style="display:grid;gap:10px">
			<Callout title={sample('preview')}>{sample('previewBody')}</Callout>
			<Callout tone="warning" title={sample('requiredTitle')}>{sample('requiredBody')}</Callout>
			<Callout tone="danger">{sample('authFailed')}</Callout>
		</div>
	{/snippet}
</Story>
