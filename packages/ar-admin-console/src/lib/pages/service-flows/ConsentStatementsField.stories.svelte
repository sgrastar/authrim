<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ConsentStatementsFieldHarness from './ConsentStatementsFieldHarness.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Consent statements choice',
		component: ConsentStatementsFieldHarness,
		tags: ['autodocs', 'draft'],
		parameters: {
			docs: {
				description: {
					component:
						'The consent statements a sign-up or sign-in flow asks, in the order they are shown. Statements are added from the tenant’s own (only those turned on and with a published version), each required or optional, moved up and down, or removed. A statement that is no longer there (deleted or retired) or not published stays in the list, flagged, so it can be removed. A chosen statement’s current text can be read in place, in each of its languages. A new statement can be made here, as a sign-in method profile can: its key, kind and text in every language, published at once and chosen (its other settings and later versions are on its own page). A list that cannot be read is told in the field and the rest of the page carries on.'
				}
			}
		}
	});
</script>

<!-- Only statements that can be asked now are offered. -->
<Story
	name="Choosing"
	args={{ answer: 'some' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const add = await canvas.findByRole('combobox', { name: t('af.consent.add') });
		await expect([...(add as HTMLSelectElement).options].map((o) => o.value)).toEqual([
			'',
			'stmt_terms',
			'stmt_privacy'
		]);
		await userEvent.selectOptions(add, 'stmt_terms');
		await userEvent.click(canvas.getByRole('button', { name: t('af.consent.add') }));
		await expect(canvas.getByTestId('value')).toHaveTextContent('stmt_terms:required');
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('af.consent.add') }),
			'stmt_privacy'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('af.consent.add') }));
		await expect(canvas.getByTestId('value')).toHaveTextContent(
			'stmt_terms:required | stmt_privacy:required'
		);
		await expect(canvas.getByRole('link', { name: t('af.consent.manage') })).toHaveAttribute(
			'href',
			'/admin/customization/statements'
		);
		await expect(
			canvas.getByRole('button', { name: t('af.consent.new.open') })
		).toBeInTheDocument();
	}}
></Story>

<!-- The text the person is asked to agree to, read without leaving the flow. -->
<Story
	name="Reading a chosen statement"
	args={{ answer: 'some', initial: ['stmt_terms:required'] }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('af.consent.peek.show') }));
		await expect(
			await canvas.findByRole('heading', { name: 'Terms of service' })
		).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('button', { name: t('af.consent.peek.hide') }));
		await waitFor(() =>
			expect(canvas.queryByRole('heading', { name: 'Terms of service' })).toBeNull()
		);
	}}
></Story>

<!-- Made, published and chosen from the flow, as a sign-in method profile is. -->
<Story
	name="Making one here"
	args={{ answer: 'none' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('af.consent.new.open') }));
		const publish = canvas.getByRole('button', { name: t('af.consent.new.publish') });
		// Nothing is made until the key and the text are there.
		await userEvent.click(publish);
		await expect(await canvas.findByText(t('cs.error.fix'))).toBeInTheDocument();
		await userEvent.type(canvas.getByLabelText(t('cs.create.slug')), 'newsletter');
		await userEvent.type(canvas.getByLabelText(t('cs.content.name')), 'Newsletter');
		await userEvent.type(canvas.getByLabelText(t('cs.content.summary')), 'News by email.');
		await userEvent.type(canvas.getByLabelText(t('cs.content.body')), 'We send news monthly.');
		await userEvent.click(publish);
		await waitFor(() => expect(canvas.getByTestId('value')).toHaveTextContent(/:required$/u));
		await expect(canvas.getByText('Newsletter')).toBeInTheDocument();
		await expect(canvas.queryByText(t('af.consent.unpublished'))).toBeNull();
	}}
></Story>

<Story
	name="Without permission to make one"
	args={{ answer: 'some', canCreate: false }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('combobox', { name: t('af.consent.add') });
		await expect(canvas.queryByRole('button', { name: t('af.consent.new.open') })).toBeNull();
	}}
></Story>

<Story
	name="Required, order and removal"
	args={{ answer: 'some', initial: ['stmt_terms:required', 'stmt_privacy:required'] }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const privacy = await canvas.findByRole('group', { name: 'Privacy policy' });
		await userEvent.click(within(privacy).getByRole('checkbox'));
		await expect(canvas.getByTestId('value')).toHaveTextContent(
			'stmt_terms:required | stmt_privacy:optional'
		);
		await userEvent.click(
			canvas.getByRole('button', { name: t('af.consent.moveUp', { name: 'Privacy policy' }) })
		);
		await expect(canvas.getByTestId('value')).toHaveTextContent(
			'stmt_privacy:optional | stmt_terms:required'
		);
		await userEvent.click(
			canvas.getByRole('button', { name: t('af.consent.remove', { name: 'Privacy policy' }) })
		);
		await expect(canvas.getByTestId('value')).toHaveTextContent(/^stmt_terms:required$/u);
		await expect(
			canvas.getByRole('button', { name: t('af.consent.moveUp', { name: 'Terms of service' }) })
		).toBeDisabled();
	}}
></Story>

<!-- Deleted or retired, or not published any more: still listed so it can be removed. -->
<Story
	name="Unknown and unpublished statements"
	args={{
		answer: 'some',
		initial: ['gone-statement:required', 'stmt_marketing:optional', 'stmt_terms:required']
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText('gone-statement')).toBeInTheDocument();
		await expect(canvas.getByText(t('af.consent.unknown'))).toBeInTheDocument();
		await expect(canvas.getByText(t('af.consent.unpublished'))).toBeInTheDocument();
		await userEvent.click(
			canvas.getByRole('button', { name: t('af.consent.remove', { name: 'gone-statement' }) })
		);
		await waitFor(() => expect(canvas.queryByText(t('af.consent.unknown'))).toBeNull());
	}}
></Story>

<Story
	name="No statements yet"
	args={{ answer: 'none' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText(t('af.consent.none'))).toBeInTheDocument();
		await expect(canvas.queryByRole('combobox')).toBeNull();
	}}
></Story>

<Story
	name="Could not be read"
	args={{ answer: 'failed', initial: ['stmt_terms:required'] }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText(t('af.consent.loadFailed'))).toBeInTheDocument();
		await expect(canvas.getByRole('button', { name: t('common.retry') })).toBeInTheDocument();
		// What the flow already asks is kept, and can still be removed.
		await expect(canvas.getByText('stmt_terms')).toBeInTheDocument();
	}}
></Story>

<!-- A sign-in built in the Flow editor, with nowhere to put consent. -->
<Story
	name="Not available in this flow"
	args={{ answer: 'some', unavailable: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText(t('af.consent.unavailable'))).toBeInTheDocument();
		await expect(canvas.queryByRole('combobox')).toBeNull();
	}}
></Story>
