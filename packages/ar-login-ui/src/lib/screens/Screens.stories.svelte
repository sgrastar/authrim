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
						'Whole pages rendered from the real route components that need no server data. Consent, device and re-authentication have their own sections (**Screens / Consent**, **Device code**, **Re-authentication**): their routes fetch and submit, and a view component draws what it is given. Login, signup, verify-email-code, ciba, callback, discover and the home page still fetch inside the route, so their parts are catalogued instead (see **Catalog**, **Runtime screen** and **Page shell**).'
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
