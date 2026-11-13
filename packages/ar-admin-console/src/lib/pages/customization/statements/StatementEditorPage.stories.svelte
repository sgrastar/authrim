<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import {
		MOCK_CONSENT_STATEMENTS,
		createFakeConsentStatements
	} from '#lib/api/fake/consent-statements-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import StatementEditorPage from './StatementEditorPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Consent statement page',
		component: StatementEditorPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'A consent statement’s page (`…/statements/<id>`). Basics: the key and kind (`PUT /api/admin/consent-statements/:id`). Content: per language, a name, a description and the text or a link, with a preview beside it; only the draft version can be edited (`PUT …/versions/:vid/localizations/:lang`), a published one is shown read-only. Versions: the history with the current version marked; "Create a new version" makes a draft (`POST …/versions`, dated today by default, starting from the current texts), a draft is published with `POST …/versions/:vid/activate` where "Ask people who already agreed again" sets `reconsent`, or deleted. Details (closed): legal basis, withdrawal, retention, re-ask interval. Where it is used comes from `GET …/consent-statements/usage`. A statement can be turned off, and deleted (never used: deleted; otherwise retired with its records kept). Changes to the kind, details and draft texts wait for the save bar; version actions wait while there is unsaved work.'
				}
			}
		}
	});

	const common = {
		canWrite: true,
		listHref: '/admin/customization/statements',
		ondeleted: fn()
	};
	const fake = (extra = {}) =>
		createFakeConsentStatements({ ...structuredClone(MOCK_CONSENT_STATEMENTS), ...extra });
</script>

<!-- A published statement with a revision in draft: the draft is shown, editable. -->
<Story
	name="Published with a draft revision"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('textbox', { name: t('cs.content.name') });
		await expect(canvas.getByRole('table', { name: t('cs.versions.title') })).toBeInTheDocument();
		await expect(canvas.getAllByText(t('cs.versions.current'))).toHaveLength(1);
		// Where it is used: a flow and two services.
		await expect(canvas.getByText('Customer portal')).toBeInTheDocument();
		await expect(canvas.getByText('Learning system')).toBeInTheDocument();
		// The details are closed until opened.
		await expect(canvas.getByText(t('cs.details.title'))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<StatementEditorPage client={fake()} id="stmt_terms" {...common} />
		<Toaster />
	{/snippet}
</Story>

<Story
	name="Editing the draft"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: t('cs.content.name') });
		await userEvent.clear(name);
		await userEvent.type(name, 'Terms v3');
		await expect(canvas.getByRole('button', { name: t('cs.versions.new') })).toBeDisabled();
		await expect(canvas.getByRole('button', { name: t('cs.versions.publish') })).toBeDisabled();
		await userEvent.click(await canvas.findByRole('button', { name: t('common.save') }));
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: t('cs.versions.publish') })).toBeEnabled()
		);
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<StatementEditorPage client={fake()} id="stmt_terms" {...common} />
		<Toaster />
	{/snippet}
</Story>

<!-- Publishing asks whether people who agreed before are asked again. -->
<Story
	name="Publish a draft"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('cs.versions.publish') }));
		const dialog = await within(document.body).findByRole('dialog');
		const reconsent = within(dialog).getByRole('checkbox', {
			name: new RegExp(t('cs.publish.reconsent'))
		});
		await expect(reconsent).toBeChecked();
		await userEvent.click(reconsent);
		await expect(within(dialog).getByText(t('cs.publish.reconsentOff'))).toBeInTheDocument();
		await userEvent.click(reconsent);
		await userEvent.click(within(dialog).getByRole('button', { name: t('cs.publish.submit') }));
		await waitFor(() =>
			expect(canvas.getAllByText(t('cs.version.status.archived'))).toHaveLength(2)
		);
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<StatementEditorPage client={fake()} id="stmt_terms" {...common} />
		<Toaster />
	{/snippet}
</Story>

<!-- A statement with only a published version: a new version starts as a copy, as a draft. -->
<Story
	name="Create a new version"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('cs.versions.new') }));
		const dialog = await within(document.body).findByRole('dialog');
		const number = within(dialog).getByRole('textbox', { name: t('cs.versions.number') });
		await userEvent.clear(number);
		await userEvent.type(number, '20260230');
		await userEvent.click(within(dialog).getByRole('button', { name: t('cs.versions.newSubmit') }));
		await expect(await within(dialog).findByText(t('cs.error.versionFormat'))).toBeInTheDocument();
		await userEvent.clear(number);
		await userEvent.type(number, '20261201');
		await userEvent.click(within(dialog).getByRole('button', { name: t('cs.versions.newSubmit') }));
		await canvas.findByRole('textbox', { name: t('cs.content.name') });
		await expect(canvas.getByText('2026-12-01')).toBeInTheDocument();
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<StatementEditorPage client={fake()} id="stmt_privacy" {...common} />
		<Toaster />
	{/snippet}
</Story>

<!-- A link instead of a text: the content type of the draft. -->
<Story name="Draft only, text">
	{#snippet template()}
		<StatementEditorPage client={fake()} id="stmt_marketing" {...common} />
		<Toaster />
	{/snippet}
</Story>

<Story
	name="Published version is read-only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('cs.content.readOnly'));
		await expect(canvas.queryByRole('textbox', { name: t('cs.content.name') })).toBeNull();
		await expect(
			canvas.getByRole('link', { name: new RegExp(t('cs.content.openDocument')) })
		).toHaveAttribute('href', 'https://example.com/privacy');
	}}
>
	{#snippet template()}
		<StatementEditorPage client={fake()} id="stmt_privacy" {...common} />
	{/snippet}
</Story>

<Story
	name="Delete explains what happens"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			(await canvas.findAllByRole('button', { name: t('cs.editor.delete') }))[0]
		);
		const dialog = await within(document.body).findByRole('dialog');
		await expect(within(dialog).getByText(t('cs.editor.deleteBody'))).toBeInTheDocument();
		await userEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
	}}
>
	{#snippet template()}
		<StatementEditorPage client={fake()} id="stmt_terms" {...common} />
	{/snippet}
</Story>

<Story
	name="Usage unavailable"
	play={async ({ canvasElement }) => {
		await expect(await within(canvasElement).findByText(t('cs.usage.unknown'))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<StatementEditorPage client={fake({ usagesFail: true })} id="stmt_terms" {...common} />
	{/snippet}
</Story>

<Story name="Read only">
	{#snippet template()}
		<StatementEditorPage client={fake()} id="stmt_terms" {...common} canWrite={false} />
	{/snippet}
</Story>

<Story
	name="Retired"
	play={async ({ canvasElement }) => {
		await expect(
			await within(canvasElement).findByText(t('cs.editor.retiredNote'))
		).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<StatementEditorPage
			client={fake({
				statements: MOCK_CONSENT_STATEMENTS.statements.map((item) =>
					item.id === 'stmt_survey' ? { ...item, retired_at: 1_770_000_000_000 } : item
				)
			})}
			id="stmt_survey"
			{...common}
		/>
	{/snippet}
</Story>

<Story
	name="Not found"
	play={async ({ canvasElement }) => {
		await expect(
			await within(canvasElement).findByText(t('cs.editor.notFound'))
		).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<StatementEditorPage client={fake()} id="missing" {...common} />
	{/snippet}
</Story>
