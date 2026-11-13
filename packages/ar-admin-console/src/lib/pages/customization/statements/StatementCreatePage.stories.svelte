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
	import StatementCreatePage from './StatementCreatePage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Consent statement creation',
		component: StatementCreatePage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Makes a consent statement (`…/statements/new`): `POST /api/admin/consent-statements` with the key and kind, then a first version dated today (`POST …/versions`) with the text in the admin’s language (`PUT …/localizations/:lang`). The version is a draft; the statement’s page is where it is checked and published. A key already in use (409) and fields that are missing are shown on the page.'
				}
			}
		}
	});

	const oncreated = fn();
	const common = { canWrite: true, listHref: '/admin/customization/statements', oncreated };
	const fake = () => createFakeConsentStatements(structuredClone(MOCK_CONSENT_STATEMENTS));
</script>

<Story
	name="New statement"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: t('cs.create.submit') }));
		await expect(canvas.getByText(t('cs.error.field.slug'))).toBeInTheDocument();
		await userEvent.type(canvas.getByRole('textbox', { name: t('cs.create.slug') }), 'terms-new');
		await userEvent.type(canvas.getByRole('textbox', { name: t('cs.content.name') }), 'Terms');
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('cs.content.summary') }),
			'Conditions'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('cs.create.submit') }));
		await waitFor(() => expect(oncreated).toHaveBeenCalled());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<StatementCreatePage client={fake()} {...common} />
		<Toaster />
	{/snippet}
</Story>

<Story
	name="Key already used"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('cs.create.slug') }),
			'terms-of-service'
		);
		await userEvent.type(canvas.getByRole('textbox', { name: t('cs.content.name') }), 'Terms');
		await userEvent.type(
			canvas.getByRole('textbox', { name: t('cs.content.summary') }),
			'Conditions'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('cs.create.submit') }));
		await expect(await canvas.findByText(t('cs.error.slugTaken'))).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<StatementCreatePage client={fake()} {...common} />
	{/snippet}
</Story>

<Story name="Read only">
	{#snippet template()}
		<StatementCreatePage client={fake()} {...common} canWrite={false} />
	{/snippet}
</Story>
