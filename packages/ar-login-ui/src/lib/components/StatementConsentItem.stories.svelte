<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import LoginUIFrame from '#lib/storybook/LoginUIFrame.svelte';
	import StatementConsentItem from './StatementConsentItem.svelte';

	const BASE = {
		statement_id: 'st-terms',
		slug: 'terms',
		title: 'Terms of Service',
		description: '',
		version: '20261113',
		document_url: null,
		inline_content:
			'<p><strong>1. Scope.</strong> These terms apply to every service we provide.</p><p><strong>2. Your account.</strong> You are responsible for what is done with your account, and you keep your sign-in details to yourself.</p><p><strong>3. Changes.</strong> We tell you before these terms change.</p><p><strong>4. Ending.</strong> You can close your account at any time from the account page.</p>'
	};

	const { Story } = defineMeta({
		title: 'Components/StatementConsentItem',
		component: StatementConsentItem,
		tags: ['autodocs'],
		args: { item: BASE, asks: true, required: true, onchange: fn() },
		parameters: {
			docs: {
				description: {
					component:
						'One consent statement on the consent step. A statement whose text is kept in Authrim shows its statement page (`/statements/<slug>/embed`) in a scrolling frame, with a "Read …" link that opens the full page; a statement kept at an external URL is a "Read …" link to that document. The checkbox always says "I agree to <title>". (In Storybook the frame has no page to show.)'
				}
			}
		}
	});
</script>

{#snippet frame(args: Parameters<typeof StatementConsentItem>[1])}
	<LoginUIFrame><div style="max-width: 28rem"><StatementConsentItem {...args} /></div></LoginUIFrame
	>
{/snippet}

<Story
	name="Text kept in Authrim"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTitle('Terms of Service')).toHaveAttribute(
			'src',
			'/statements/terms/embed?version=20261113'
		);
		await expect(canvas.getByRole('link')).toHaveAttribute(
			'href',
			'/statements/terms?version=20261113'
		);
		await userEvent.click(canvas.getByRole('checkbox'));
		await expect(args.onchange).toHaveBeenCalledWith(true);
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story
	name="External document"
	args={{
		item: {
			...BASE,
			title: 'Privacy Policy',
			inline_content: null,
			document_url: 'https://example.com/privacy'
		}
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story
	name="Shown only"
	args={{ asks: false, item: { ...BASE, description: 'Read before you continue.' } }}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>
