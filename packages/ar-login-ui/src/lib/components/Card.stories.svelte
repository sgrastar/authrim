<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import Button from './Button.svelte';
	import Card from './Card.svelte';

	const { Story } = defineMeta({
		title: 'Components/Card',
		component: Card,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The surface every form and status page sits on. Its radius, background and blur come from the theme (square and frosted on Full-bleed glass), and the split layout flattens it into the panel.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<LoginUIFrame>
			<div style="max-width:400px">
				<Card>
					<h2 class="auth-section-title">Title</h2>
					<p class="auth-section-subtitle">Body of the card.</p>
					<Button class="w-full">Continue</Button>
				</Card>
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story name="Header and footer">
	{#snippet template()}
		<LoginUIFrame>
			<div style="max-width:400px">
				<Card>
					{#snippet header()}<strong>Header</strong>{/snippet}
					Body of the card.
					{#snippet footer()}<small>Footer</small>{/snippet}
				</Card>
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>
