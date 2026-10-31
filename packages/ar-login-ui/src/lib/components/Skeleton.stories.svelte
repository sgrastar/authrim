<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import Skeleton from './Skeleton.svelte';

	const { Story } = defineMeta({
		title: 'Components/Skeleton',
		component: Skeleton,
		tags: ['autodocs'],
		parameters: {
			docs: { description: { component: 'Pulsing placeholder for content that is still loading.' } }
		}
	});
</script>

<Story name="Lines">
	{#snippet template()}
		<LoginUIFrame>
			<div style="display:grid;gap:10px;max-width:360px">
				<Skeleton width="40%" height="0.75rem" />
				<Skeleton height="1rem" />
				<Skeleton width="70%" height="1rem" />
				<Skeleton width="3rem" height="3rem" radius="9999px" />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>
