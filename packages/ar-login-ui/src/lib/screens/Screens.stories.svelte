<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import LogoutCompletePage from '$lib/components/LogoutCompletePage.svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import ErrorPage from '../../routes/error/+page.svelte';

	const { Story } = defineMeta({
		title: 'Screens/Pages',
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Whole pages rendered from the real route components that need no server data. Every page that fetches or submits has its own section under **Screens** (login, sign-up, consent, device code, re-authentication, CIBA, callback, email code, discover and home): its route fetches and submits, and a view component draws what it is given. The parts those views share are catalogued under **Catalog**, **Runtime screen** and **Page shell**.'
				}
			}
		}
	});
</script>

<Story name="Logout complete">
	{#snippet template()}
		<LoginUIFrame fit="page"><LogoutCompletePage /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Error">
	{#snippet template()}
		<LoginUIFrame fit="page"><ErrorPage /></LoginUIFrame>
	{/snippet}
</Story>
