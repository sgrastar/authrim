<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ConnectionMappingHarness from './ConnectionMappingHarness.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Connection mapping',
		component: ConnectionMappingHarness,
		parameters: { layout: 'fullscreen' },
		tags: ['autodocs']
	});
	async function openMapping(root: HTMLElement) {
		const canvas = within(root);
		const node = canvas.getByRole('button', { name: new RegExp(`^${t('sf.part.mapping-sets')}`) });
		if (node.getAttribute('aria-current') !== 'step') {
			await expect(canvas.queryByRole('button', { name: /^email/ })).toBeNull();
			await userEvent.click(node);
		}
		await waitFor(() =>
			expect(
				canvas.getByRole('combobox', { name: new RegExp(`^${t('sf.row.mappingSet')}`) })
			).toBeVisible()
		);
	}

	async function openDisclosure(root: HTMLElement, title: string) {
		const heading = within(root).getByText(title, { selector: '.disclosure__title' });
		const details = heading.closest('details');
		if (!details) throw new Error('Expected the disclosure');
		await userEvent.click(heading);
		await waitFor(() => expect(details).toHaveAttribute('open'));
		await waitFor(() => expect(details.getAnimations({ subtree: true })).toHaveLength(0));
		return details;
	}
	async function edit(root: HTMLElement) {
		await openMapping(root);
		const canvas = within(root);
		await canvas.findByRole('button', { name: /^email/ });
		const details = await openDisclosure(root, 'Mapping Set settings');
		await userEvent.type(canvas.getByRole('textbox', { name: 'Name' }), ' updated');
		await userEvent.click(
			canvas.getByText('Mapping Set settings', { selector: '.disclosure__title' })
		);
		await waitFor(() => expect(details).not.toHaveAttribute('open'));
		await waitFor(() => expect(details.getAnimations({ subtree: true })).toHaveLength(0));
		await expect(canvas.getAllByText('Changed').length).toBeGreaterThan(0);
		await userEvent.click(canvas.getByRole('button', { name: 'Save and use for this connection' }));
	}
</script>

<Story
	name="OIDC RP shared set"
	play={async ({ canvasElement }) => {
		await openMapping(canvasElement);
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: /^email/ });
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: /Mapping set$/ }),
			'set-shared'
		);
		await canvas.findByRole('button', { name: /^email/ });
		await userEvent.click(canvas.getByRole('button', { name: /^email/ }));
		await userEvent.click(canvas.getByRole('button', { name: t('map.addStep') }));
		const picker = within(await canvas.findByRole('dialog', { name: t('map.pickStep') }));
		await userEvent.click(picker.getByRole('button', { name: new RegExp(`^${t('map.t.trim')}`) }));
		await userEvent.click(await picker.findByRole('button', { name: t('map.pick.add') }));
		await expect(
			canvas.getByRole('button', { name: 'Save and use for this connection' })
		).toBeEnabled();
		await expect(canvas.queryByRole('table', { name: /recipient|schema/i })).toBeNull();
	}}
/>
<Story
	name="Impact confirmation"
	args={{ scenario: 'impact' }}
	play={async ({ canvasElement }) => {
		await edit(canvasElement);
		const dialog = within(
			await within(canvasElement.ownerDocument.body).findByRole('dialog', {
				name: 'Update a shared Mapping Set?'
			})
		);
		await expect(dialog.getByText(/3 references/)).toBeInTheDocument();
		await userEvent.click(dialog.getByRole('button', { name: 'Update shared set' }));
		await within(canvasElement).findByText('Mapping Set saved and bound to this connection.');
	}}
/>
<Story
	name="Conflict"
	args={{ scenario: 'conflict' }}
	play={async ({ canvasElement }) => {
		await edit(canvasElement);
		await within(canvasElement).findByText(/The set changed on the server/);
	}}
/>
<Story
	name="Stage failed"
	args={{ scenario: 'stage' }}
	play={async ({ canvasElement }) => {
		await edit(canvasElement);
		await within(canvasElement).findByText(/Set activation did not complete/);
	}}
/>
<Story
	name="Unknown outcome"
	args={{ scenario: 'unknown' }}
	play={async ({ canvasElement }) => {
		await edit(canvasElement);
		await within(canvasElement).findByText(/The save result is unknown/);
	}}
/>
<Story
	name="Binding only retry"
	args={{ scenario: 'binding' }}
	play={async ({ canvasElement }) => {
		await openMapping(canvasElement);
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: /^email/ });
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: /Mapping set$/ }),
			'set-shared'
		);
		await edit(canvasElement);
		await canvas.findByText(/The set is saved, but binding/);
		await userEvent.click(canvas.getByRole('button', { name: 'Retry binding only' }));
		await canvas.findByText('Mapping Set saved and bound to this connection.');
		await openDisclosure(canvasElement, t('cm.options'));
		await userEvent.type(canvas.getByRole('textbox', { name: t('sf.row.name') }), ' re-edited');
		await waitFor(() => expect(canvas.queryByText(t('cm.saved'))).toBeNull());
	}}
/>
<Story
	name="Test user explanation"
	play={async ({ canvasElement }) => {
		await openMapping(canvasElement);
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: /^email/ });
		await openDisclosure(canvasElement, 'Test conditions');
		await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Test user' }), 'test-user');
		await userEvent.click(canvas.getByRole('button', { name: 'Check sent information' }));
		await canvas.findByRole('table', { name: 'By claim' });
	}}
/>
<Story
	name="SAML SP deferred identifier"
	args={{ protocol: 'saml' }}
	play={async ({ canvasElement }) => {
		await openMapping(canvasElement);
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: /^email/ });
		await openDisclosure(canvasElement, 'Test conditions');
		await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Test user' }), 'test-user');
		await userEvent.click(canvas.getByRole('button', { name: 'Check sent information' }));
		await canvas.findByText(/Identifiers that require account material/);
	}}
/>
<Story name="Unsupported set read only" args={{ scenario: 'readonly' }} />

<Story
	name="Mapping edits survive staying on the detail"
	play={async ({ canvasElement }) => {
		await openMapping(canvasElement);
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: /^email/ });
		await openDisclosure(canvasElement, t('cm.options'));
		await userEvent.type(canvas.getByRole('textbox', { name: t('sf.row.name') }), ' updated');
		await userEvent.click(canvas.getAllByRole('button', { name: t('af.general') })[0]);
		await expect(
			canvas.queryByRole('combobox', { name: new RegExp(`^${t('sf.row.mappingSet')}`) })
		).toBeNull();
		await expect(canvas.queryByRole('button', { name: /^email/ })).toBeNull();
		await openMapping(canvasElement);
		await expect(canvas.getByRole('textbox', { name: new RegExp(t('sf.row.name')) })).toHaveValue(
			'Portal mapping updated'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.detail.back') }));
		const dialog = within(
			await within(canvasElement.ownerDocument.body).findByRole('dialog', {
				name: t('sf.unsaved.title')
			})
		);
		await userEvent.click(dialog.getByRole('button', { name: t('sf.unsaved.keep') }));
		await expect(canvas.getByRole('textbox', { name: new RegExp(t('sf.row.name')) })).toHaveValue(
			'Portal mapping updated'
		);
	}}
/>

<Story
	name="Make the output source while making a mapping set"
	args={{ protocol: 'saml' }}
	play={async ({ canvasElement }) => {
		await openMapping(canvasElement);
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('cm.create') }));
		// Nothing suits: the output source is made here, from a template, and is then the one chosen.
		await userEvent.click(await canvas.findByRole('button', { name: t('sf.dp.field.create') }));
		await userEvent.click(canvas.getByRole('button', { name: /Academic federation/ }));
		await userEvent.click(canvas.getByRole('button', { name: /REFEDS Research and Scholarship/ }));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.template.use') }));
		await canvas.findByDisplayValue('eduPersonPrincipalName');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		const field = await canvas.findByRole('combobox', { name: t('sf.dp.field.label') });
		await waitFor(() => expect(field).toHaveDisplayValue('REFEDS Research and Scholarship'));
	}}
/>
