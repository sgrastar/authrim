<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { getLocale } from '$i18n/i18n-svelte';
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
						'One consent statement on the consent step. A statement whose text is kept in Authrim shows its statement page (`/statements/<slug>/embed`) in a scrolling frame, with a "Read …" link that opens the full page; a statement kept at an external URL is linked from its description (HTML the admin writes, sanitized) only, with no link of its own. The checkbox always says "I agree to <title>". (In Storybook the frame has no page to show.)'
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
			// The frame and the link carry the language the step is drawn in.
			`/statements/terms/embed?version=20261113&lang=${getLocale()}`
		);
		await expect(canvas.getByRole('link')).toHaveAttribute(
			'href',
			`/statements/terms?version=20261113&lang=${getLocale()}`
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
			description:
				'I have read and agree to the <a href="https://example.com/privacy">Privacy Policy</a>.',
			inline_content: null,
			document_url: 'https://example.com/privacy'
		}
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// The one link is the description's; the document URL adds none.
		const links = canvas.getAllByRole('link');
		await expect(links).toHaveLength(1);
		await expect(links[0]).toHaveTextContent('Privacy Policy');
		await expect(links[0]).toHaveAttribute('href', 'https://example.com/privacy');
		await expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
		await expect(canvas.getByText('Privacy Policy', { selector: 'p' })).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- A choice of options drawn as a checkbox (a sign-up without its choices) keeps its link. -->
<Story
	name="Choice of options shown as a checkbox"
	args={{
		linkDocument: true,
		item: {
			...BASE,
			title: 'Information release',
			inline_content: null,
			document_url: 'https://example.com/release'
		}
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('link')).toHaveAttribute('href', 'https://example.com/release');
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- The consent widget's own presentation (`consent_statements` of the screen's part). -->
<Story
	name="Text in a box, scrolled to the end first"
	args={{ requireScroll: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// The checkbox waits for the end of the text (here the box scrolls, so it starts locked).
		await expect(canvas.getByRole('checkbox')).toBeDisabled();
		// The hint is in the language the story is drawn in: found by what it is, not its words.
		await expect(canvasElement.querySelector('.statement-consent-hint')).not.toBeNull();
	}}
>
	{#snippet template(args)}
		<LoginUIFrame>
			<div style="max-width: 28rem">
				<StatementConsentItem
					{...args}
					item={{ ...BASE, inline_content: BASE.inline_content.repeat(6) }}
				/>
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Text in a dialog"
	args={{ display: 'modal' }}
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		// The buttons' words follow the story's language: found by what they are.
		await userEvent.click(canvasElement.querySelector('.statement-consent-open') as HTMLElement);
		await userEvent.click(canvasElement.querySelector('.statement-consent-agree') as HTMLElement);
		await expect(args.onchange).toHaveBeenCalledWith(true);
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story
	name="Text in a dialog, scrolled to the end first"
	args={{ display: 'modal', requireScroll: true }}
>
	{#snippet template(args)}
		<LoginUIFrame>
			<div style="max-width: 28rem">
				<StatementConsentItem
					{...args}
					item={{ ...BASE, inline_content: BASE.inline_content.repeat(6) }}
				/>
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Shown only"
	args={{ asks: false, item: { ...BASE, description: 'Read before you continue.' } }}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>
