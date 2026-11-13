<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import LoginUIFrame from '#lib/storybook/LoginUIFrame.svelte';
	import type { StatementPageData } from '#lib/api/statement-page.js';
	import StatementPageView from './StatementPageView.svelte';

	const { Story } = defineMeta({
		title: 'Screens/Statement page',
		component: StatementPageView,
		tags: ['autodocs'],
		args: { result: null },
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'The public page of one consent statement (`/statements/<slug>`), linked from the consent step when a statement is shown "on its own page". It shows the version read, a note on an earlier version, and the other published versions. The route (`src/routes/(main)/statements/[slug]`) reads the public statement API; the lite page draws the same content without scripts.'
				}
			}
		}
	});

	const TERMS: StatementPageData = {
		slug: 'terms',
		title: 'Terms of Service',
		description: 'The terms that apply when you use the service.',
		language: 'en',
		inlineContent:
			'<p><strong>1. Scope.</strong> These terms apply to every service we provide.</p><p><strong>2. Your account.</strong> You are responsible for what is done with your account.</p><p><strong>3. Changes.</strong> We tell you before these terms change. See the <a href="https://example.com/help">help pages</a>.</p>',
		documentUrl: null,
		version: { version: '20261113', effectiveAt: 0, isCurrent: true },
		versions: [
			{ version: '20261113', effectiveAt: 0, isCurrent: true },
			{ version: '20260401', effectiveAt: 0, isCurrent: false }
		]
	};
</script>

{#snippet page(args: Parameters<typeof StatementPageView>[1])}
	<LoginUIFrame fit="page"><StatementPageView {...args} /></LoginUIFrame>
{/snippet}

<Story name="Loading">
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Current version"
	args={{ result: { ok: true, statement: TERMS } }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeVisible();
		await expect(canvas.getByRole('navigation')).toBeVisible();
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Earlier version"
	args={{
		result: {
			ok: true,
			statement: {
				...TERMS,
				version: { version: '20260401', effectiveAt: 0, isCurrent: false }
			}
		}
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="External document"
	args={{
		result: {
			ok: true,
			statement: {
				...TERMS,
				title: 'Privacy Policy',
				inlineContent: null,
				documentUrl: 'https://example.com/privacy',
				versions: [TERMS.versions[0]]
			}
		}
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Not found" args={{ result: { ok: false, reason: 'not_found' } }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Unavailable" args={{ result: { ok: false, reason: 'unavailable' } }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>
