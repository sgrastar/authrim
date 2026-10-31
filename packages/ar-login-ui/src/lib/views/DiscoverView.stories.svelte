<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, within } from 'storybook/test';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import DiscoverView, { type DiscoveryCandidate } from './DiscoverView.svelte';

	const { Story } = defineMeta({
		title: 'Screens/Tenant discovery',
		component: DiscoverView,
		tags: ['autodocs'],
		args: {
			kickerText: 'Sign in',
			titleText: 'Find your organisation',
			subtitleText: 'Use your work email, or the code your organisation gave you.',
			showTenantChooser: true,
			interactiveMethods: ['email_exact'],
			postSelections: false,
			hidden: {},
			selectedMode: 'email',
			value: '',
			onSubmit: fn()
		},
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Where a person on the common entry host finds their organisation before signing in. The route (`src/routes/discover`) holds the configuration and the form results; this view draws them inside the shared shell. Forms post to `/discover?/resolve`; a tenant elsewhere is a validated link.'
				}
			}
		}
	});

	const tenant = (code: string, name: string): DiscoveryCandidate => ({
		tenant_id: `t-${code}`,
		tenant_code: code,
		display_name: name,
		logo_url: null,
		login_url: `https://${code}.id.example.com/login`,
		source: 'email'
	});
</script>

{#snippet page(args: Parameters<typeof DiscoverView>[1])}
	<LoginUIFrame fit="page">
		<AuthPageShell><DiscoverView {...args} /></AuthPageShell>
	</LoginUIFrame>
{/snippet}

<Story name="Find by email">
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Choose how to find it"
	args={{
		interactiveMethods: ['email_exact', 'tenant_code', 'tenant_slug'],
		selectedMode: 'tenant_code'
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Email code sent"
	args={{ value: 'taro@acme.example', hidden: { emailChallengeId: 'challenge-1' } }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Several organisations"
	args={{
		value: 'taro@acme.example',
		candidates: [tenant('acme', 'Acme Corporation'), tenant('acme-labs', 'Acme Labs')]
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const link = canvas.getByRole('link', { name: /Acme Labs/ });
		await expect(link.getAttribute('href')).toContain('https://acme-labs.id.example.com/login');
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Several organisations, chosen here"
	args={{
		postSelections: true,
		candidates: [tenant('acme', 'Acme Corporation'), tenant('acme-labs', 'Acme Labs')]
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Signed in here before"
	args={{ rememberedCandidate: tenant('acme', 'Acme Corporation') }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Pick from a list (WAYF)"
	args={{
		interactiveMethods: ['wayf'],
		wayfOnly: true,
		selectedMode: 'wayf',
		wayfCandidates: [tenant('acme', 'Acme Corporation'), tenant('globex', 'Globex University')]
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Not found"
	args={{ value: 'nobody@example.com', errorMessage: 'No organisation uses this email.' }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Manual entry only"
	args={{ manualOnly: true, interactiveMethods: ['tenant_code'], selectedMode: 'tenant_code' }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>
