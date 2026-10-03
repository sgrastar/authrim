<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import type { AccountPageScreenField } from '$lib/api/account';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountScreenBlock from './AccountScreenBlock.svelte';
	import AccountScreenPlacement from './AccountScreenPlacement.svelte';

	const field = (overrides: Partial<AccountPageScreenField>): AccountPageScreenField => ({
		field: 'block',
		label: '',
		required: false,
		...overrides
	});

	const { Story } = defineMeta({
		title: 'Account/Screen blocks',
		component: AccountScreenBlock,
		tags: ['autodocs'],
		args: {
			field: field({
				block_type: 'heading',
				label: 'Manage your account',
				text: 'Review how you sign in and the apps you have allowed.'
			}),
			href: null
		},
		parameters: {
			docs: {
				description: {
					component:
						'The blocks a published account page composition draws besides the account widgets: a heading with optional text, text, a link and a divider. A link is drawn only with a target `safeAccountScreenHref` accepted: an anchor to a placement the page shows, a same-origin path or an https URL. A placement lays the blocks out in the account grid; the overview is a card of its own and a full-width placement has two columns.'
				}
			}
		}
	});
</script>

{#snippet single(args: Parameters<typeof AccountScreenBlock>[1])}
	<LoginUIFrame><AccountScreenBlock {...args} /></LoginUIFrame>
{/snippet}

<Story name="Heading">
	{#snippet template(args)}{@render single(args)}{/snippet}
</Story>

<Story
	name="Text"
	args={{
		field: field({
			block_type: 'text',
			text: 'Changes to your sign-in methods take effect on your next sign-in.'
		})
	}}
>
	{#snippet template(args)}{@render single(args)}{/snippet}
</Story>

<Story
	name="Link"
	args={{
		field: field({ block_type: 'link', label: 'Account help' }),
		href: 'https://help.example.com/account'
	}}
	play={async ({ canvasElement }) => {
		await expect(within(canvasElement).getByRole('link', { name: 'Account help' })).toHaveAttribute(
			'href',
			'https://help.example.com/account'
		);
	}}
>
	{#snippet template(args)}{@render single(args)}{/snippet}
</Story>

<Story
	name="Link left out"
	args={{ field: field({ block_type: 'link', label: 'Account help' }), href: null }}
	parameters={{
		docs: {
			description: {
				story: 'The configured target was not accepted (here `javascript:`), so nothing is drawn.'
			}
		}
	}}
	play={async ({ canvasElement }) => {
		await expect(within(canvasElement).queryByRole('link')).toBeNull();
	}}
>
	{#snippet template(args)}{@render single(args)}{/snippet}
</Story>

<Story name="Divider" args={{ field: field({ block_type: 'divider' }) }}>
	{#snippet template(args)}{@render single(args)}{/snippet}
</Story>

<Story name="Divider with text" args={{ field: field({ block_type: 'divider', text: 'More' }) }}>
	{#snippet template(args)}{@render single(args)}{/snippet}
</Story>

<Story
	name="Overview placement"
	parameters={{
		docs: {
			description: {
				story:
					'A full-width overview placement: a card with the heading across, then text in column 1 and a link in column 2 (one column on narrow screens).'
			}
		}
	}}
>
	{#snippet template()}
		<LoginUIFrame>
			<AccountScreenPlacement
				id="overview"
				full
				overview
				fields={[
					field({ field: 'heading', block_type: 'heading', label: 'Manage your account' }),
					field({
						field: 'text',
						block_type: 'text',
						text: 'Review how you sign in, the devices you use and the apps you have allowed.',
						layout_column: 1
					}),
					field({
						field: 'divider',
						block_type: 'divider',
						text: 'Help',
						layout_column: 2
					}),
					field({
						field: 'link',
						block_type: 'link',
						label: 'Account help',
						href: 'https://help.example.com/account',
						layout_column: 2
					})
				]}
			>
				{#snippet block(current)}
					<AccountScreenBlock field={current} href={current.href ?? null} />
				{/snippet}
			</AccountScreenPlacement>
		</LoginUIFrame>
	{/snippet}
</Story>
