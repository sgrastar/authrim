<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { sample } from '../stories/sample';
	import LoadingState from './LoadingState.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Loading state',
		component: LoadingState,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Placeholder while data loads. The label is announced; the spinner is decorative. `text` adds a visible line above (`textPosition="top"`) or below (default) the spinner, and is announced as well.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}<LoadingState label={sample('loading')} />{/snippet}
</Story>

<Story name="With text below">
	{#snippet template()}
		<LoadingState label={sample('loading')} text={sample('loadingDetail')} />
	{/snippet}
</Story>

<Story name="With text above">
	{#snippet template()}
		<LoadingState label={sample('loading')} text={sample('loadingDetail')} textPosition="top" />
	{/snippet}
</Story>
