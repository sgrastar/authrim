<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import LoginUIFrame from '#lib/storybook/LoginUIFrame.svelte';
	import EnvironmentBanner from './EnvironmentBanner.svelte';

	const { Story } = defineMeta({
		title: 'Components/Environment banner',
		component: EnvironmentBanner,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The platform’s environment notice ("This is the staging environment"): a plain full-width band above the page, drawn once by the root layout (`src/routes/+layout.svelte`) on every Login UI page, the lite pages and error pages. Quiet warning tone (`--warning-light` fill, `--warning` bottom border, `--warning-fg` text), one small line that wraps on narrow screens, no coloured edge. A notice only, not a security control. The text arrives already in the page’s language; nothing is drawn while it is empty. The band sits outside the themed page boundary (as in the app), so it follows the scheme but not the palette. The look is the constant `.environment-banner` rule in `app.css` (and, for the lite pages, `lib/lite/lite.css`).'
				}
			}
		}
	});
</script>

<Story
	name="Short text"
	args={{ text: 'This is the staging environment.' }}
	play={async ({ canvasElement }) => {
		const band = within(canvasElement).getByRole('note');
		await expect(band).toHaveTextContent('This is the staging environment.');
		// Flat, in normal flow: nothing floats over the page.
		await expect(getComputedStyle(band).position).toBe('static');
	}}
>
	{#snippet template(args)}
		<LoginUIFrame fit="cell" height={160}>
			<div style="background:var(--bg-page);min-height:100%">
				<EnvironmentBanner text={args.text} />
				<p style="padding:16px">The page starts under the band.</p>
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Long text wraps"
	args={{
		text: 'This is the staging environment used to rehearse upgrades before they reach production. Accounts and settings created here are not copied anywhere, and the whole environment may be rebuilt without notice.'
	}}
>
	{#snippet template(args)}
		<LoginUIFrame fit="cell" height={200}>
			<div style="max-width:360px">
				<EnvironmentBanner text={args.text} />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story name="Dark scheme" args={{ text: 'This is the staging environment.' }}>
	{#snippet template(args)}
		<LoginUIFrame fit="cell" height={120} scheme="dark">
			<!-- The real page sits on the document background; the cell has none of its own. -->
			<div style="background:var(--bg-page);min-height:100%">
				<EnvironmentBanner text={args.text} />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Arabic (right to left)"
	args={{ text: 'هذه بيئة الاختبار، وقد تُعاد تهيئتها في أي وقت.' }}
>
	{#snippet template(args)}
		<LoginUIFrame fit="cell" height={120}>
			<div dir="rtl">
				<EnvironmentBanner text={args.text} />
			</div>
		</LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Nothing to show"
	args={{ text: '' }}
	play={async ({ canvasElement }) => {
		await expect(within(canvasElement).queryByRole('note')).toBeNull();
	}}
>
	{#snippet template(args)}
		<LoginUIFrame fit="cell" height={80}>
			<EnvironmentBanner text={args.text} />
		</LoginUIFrame>
	{/snippet}
</Story>
