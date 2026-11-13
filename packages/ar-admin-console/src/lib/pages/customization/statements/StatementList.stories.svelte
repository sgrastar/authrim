<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import {
		MOCK_CONSENT_STATEMENTS,
		createFakeConsentStatements
	} from '#lib/api/fake/consent-statements-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import StatementList from './StatementList.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Consent statements',
		component: StatementList,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Customization → Consent statements (`GET /api/admin/consent-statements`, with the versions and texts of each to name it, and `GET /api/admin/consent-statements/usage` for where each is used). Each row shows the name (the title of the current version in the admin’s language), the kind (terms of service, privacy policy, other), the current version with its date, the status (on, off, draft only) and how many flows and services use it. A row opens the statement’s page. When the usage call cannot answer, the list says so and shows a dash; when a stored document could not be read, counts read "at least".'
				}
			}
		}
	});

	const onopen = fn();
	const hrefOf = (id: string) => `/admin/customization/statements/${id}`;
	const fake = (extra = {}) =>
		createFakeConsentStatements({ ...structuredClone(MOCK_CONSENT_STATEMENTS), ...extra });
</script>

<Story
	name="Statements"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const table = await canvas.findByRole('table', { name: t('cs.list.title') });
		await expect(within(table).getAllByRole('row')).toHaveLength(5);
		await expect(within(table).getByText('terms-of-service')).toBeInTheDocument();
		await expect(within(table).getAllByText(t('cs.status.draftOnly'))).toHaveLength(1);
		await expect(within(table).getAllByText(t('cs.status.inactive'))).toHaveLength(1);
		await expect(within(table).getByText(t('cs.usage.count', { n: 3 }))).toBeInTheDocument();
		await expect(within(table).getByText('2026-04-01')).toBeInTheDocument();
		await userEvent.click(within(table).getByText('terms-of-service'));
		await waitFor(() => expect(onopen).toHaveBeenCalledWith('stmt_terms'));
		// The list narrows by name or key.
		await userEvent.type(canvas.getByRole('searchbox', { name: t('cs.list.search') }), 'privacy');
		await waitFor(() => expect(canvas.queryByText('terms-of-service')).toBeNull());
		await expect(canvas.getByText('privacy-policy')).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<StatementList client={fake()} canWrite {hrefOf} {onopen} />
	{/snippet}
</Story>

<Story
	name="Usage unavailable"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('table', { name: t('cs.list.title') });
		await expect(canvas.getByText(t('cs.usage.unknown'))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<StatementList client={fake({ usagesFail: true })} canWrite {hrefOf} {onopen} />
	{/snippet}
</Story>

<Story
	name="Usage incomplete"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('table', { name: t('cs.list.title') });
		await expect(canvas.getByText(t('cs.usage.incomplete'))).toBeInTheDocument();
		await expect(
			canvas.getByText(t('cs.usage.atLeast', { count: t('cs.usage.count', { n: 3 }) }))
		).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<StatementList client={fake({ usagesComplete: false })} canWrite {hrefOf} {onopen} />
	{/snippet}
</Story>

<Story
	name="Empty"
	play={async ({ canvasElement }) => {
		await expect(await within(canvasElement).findByText(t('cs.list.empty'))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<StatementList client={createFakeConsentStatements()} canWrite {hrefOf} {onopen} />
	{/snippet}
</Story>

<Story
	name="Read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('table', { name: t('cs.list.title') });
		await expect(canvas.queryByRole('link', { name: t('cs.list.create') })).toBeNull();
	}}
>
	{#snippet template()}
		<StatementList client={fake()} canWrite={false} {hrefOf} {onopen} />
	{/snippet}
</Story>
