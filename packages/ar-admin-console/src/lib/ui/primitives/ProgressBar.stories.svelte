<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import ProgressDemo from '../stories/ProgressDemo.svelte';
	import { sample } from '../stories/sample';
	import ProgressBar from './ProgressBar.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Progress bar',
		component: ProgressBar,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Progress of a task. Without `value` it loops (unknown duration); with `value` (0–100) it fills, and `showValue` adds a locale-formatted percentage. The loop travels in the reading direction and turns into a gentle pulse under reduced motion.'
				}
			}
		}
	});
</script>

<Story name="Loop (unknown duration)">
	{#snippet template()}
		<div style="max-width:420px"><ProgressBar label={sample('preparing')} showLabel /></div>
	{/snippet}
</Story>

<Story name="Progress">
	{#snippet template()}
		<div style="display:grid;gap:14px;max-width:420px">
			<ProgressBar label={sample('importing')} value={35} />
			<ProgressBar label={sample('importing')} value={100} tone="success" size="sm" />
		</div>
	{/snippet}
</Story>

<Story name="Progress with percentage">
	{#snippet template()}
		<div style="max-width:420px">
			<ProgressBar label={sample('uploading')} value={62} showLabel showValue />
		</div>
	{/snippet}
</Story>

<Story name="Live">
	{#snippet template()}<ProgressDemo />{/snippet}
</Story>
