<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import AuthPageShell from '#lib/components/AuthPageShell.svelte';
	import LoginUIFrame from '#lib/storybook/LoginUIFrame.svelte';
	import FederationPickerView, { type FederationIdP } from './FederationPickerView.svelte';

	const { Story } = defineMeta({
		title: 'Screens/Federation institution picker',
		component: FederationPickerView,
		tags: ['autodocs'],
		args: {
			federationName: 'Research Federation',
			items: [],
			query: '',
			loading: false,
			loadFailed: false,
			truncated: false,
			onSelect: fn(),
			onQuery: fn()
		},
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						"Where a person picks their institution when a tenant signs people in through a SAML federation (`src/routes/(main)/login/federation/[sourceId]`). The route owns the search (a public, rate-limited read of the federation's verified inventory) and the hand-over to the SAML start; this view draws the box, the results and the states."
				}
			}
		}
	});

	const institutions: FederationIdP[] = [
		{ entityId: 'https://idp.u-alpha.example/idp', displayName: 'Alpha University', logoUrl: null },
		{ entityId: 'https://idp.beta-inst.example/idp', displayName: 'Beta Institute', logoUrl: null },
		{ entityId: 'https://idp.gamma.example/idp', displayName: 'Gamma College', logoUrl: null }
	];
</script>

{#snippet page(args: Parameters<typeof FederationPickerView>[1])}
	<LoginUIFrame fit="page">
		<AuthPageShell><FederationPickerView {...args} /></AuthPageShell>
	</LoginUIFrame>
{/snippet}

<Story
	name="Choose an institution"
	args={{ items: institutions }}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: /Beta Institute/ }));
		await expect(args.onSelect).toHaveBeenCalledWith('https://idp.beta-inst.example/idp');
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Searching"
	args={{ items: institutions.slice(0, 1) }}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await userEvent.type(await canvas.findByRole('searchbox'), 'alp');
		await expect(args.onQuery).toHaveBeenLastCalledWith('alp');
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Many matches" args={{ items: institutions, truncated: true }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Nothing matches" args={{ items: [], query: 'zzz' }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Could not load the list" args={{ items: [], loadFailed: true }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>
