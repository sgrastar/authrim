<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import Spinner from './Spinner.svelte';

	const { Story } = defineMeta({
		title: 'Components/Spinner',
		component: Spinner,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component: 'Full-block loading indicator (`role="status"`) for consent and callback.'
				}
			}
		}
	});
</script>

<Story name="Sizes">
	{#snippet template()}
		<LoginUIFrame>
			<div style="display:flex;gap:24px;align-items:center">
				<Spinner size="sm" /><Spinner size="md" /><Spinner size="lg" /><Spinner size="xl" />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>
