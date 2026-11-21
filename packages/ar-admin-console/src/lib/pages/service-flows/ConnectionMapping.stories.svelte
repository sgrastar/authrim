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
	/** Opens the input-and-output node: the output source only, none of the mapping. */
	async function openOutput(root: HTMLElement) {
		const canvas = within(root);
		await userEvent.click(
			canvas.getByRole('button', { name: new RegExp(`^${t('sf.part.mapping-schemas')}`) })
		);
		await canvas.findByRole('heading', { name: t('sf.group.schemas') });
		await expect(
			canvas.queryByRole('combobox', { name: new RegExp(`^${t('sf.row.mappingSet')}`) })
		).toBeNull();
	}
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
	name="The sample user features are hidden for now"
	args={{ protocol: 'saml' }}
	play={async ({ canvasElement }) => {
		await openMapping(canvasElement);
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: /^email/ });
		// No test conditions, no test user, and no sample value under an attribute.
		await expect(canvas.queryByText('Test conditions')).toBeNull();
		await expect(canvas.queryByRole('combobox', { name: 'Test user' })).toBeNull();
		await expect(canvas.queryByRole('combobox', { name: t('mc.ch.sample') })).toBeNull();
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
		// The mapping node holds only the mapping; the output source is in the node before it.
		await expect(canvas.queryByRole('button', { name: t('sf.dp.field.create') })).toBeNull();
		await openOutput(canvasElement);
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

<Story
	name="Nothing bound yet: the output source is made first, then a set that sends into it"
	args={{ scenario: 'unbound', protocol: 'saml' }}
	play={async ({ canvasElement }) => {
		await openOutput(canvasElement);
		const canvas = within(canvasElement);
		// No set to open and no need to start one: the output source can be made right here.
		await userEvent.click(await canvas.findByRole('button', { name: t('sf.dp.field.create') }));
		await userEvent.click(canvas.getByRole('button', { name: /Academic federation/ }));
		await userEvent.click(canvas.getByRole('button', { name: /REFEDS Research and Scholarship/ }));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.template.use') }));
		await canvas.findByDisplayValue('eduPersonPrincipalName');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		// A new set is open, and it sends into the output source that was just made.
		const field = await canvas.findByRole('combobox', { name: t('sf.dp.field.label') });
		await waitFor(() => expect(field).toHaveDisplayValue('REFEDS Research and Scholarship'));
	}}
/>

<Story
	name="An output source being edited keeps its draft while the mapping node is open"
	args={{ protocol: 'saml' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await openOutput(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('sf.dp.field.edit') }));
		const title = await canvas.findByRole('textbox', { name: new RegExp(`^${t('sf.dp.name')}`) });
		await userEvent.clear(title);
		await userEvent.type(title, 'Edited on the way');
		// Out to the mapping and back: the editor is still the one that was being typed in.
		await userEvent.click(
			canvas.getByRole('button', { name: new RegExp(`^${t('sf.part.mapping-sets')}`) })
		);
		await expect(
			canvas.queryByRole('textbox', { name: new RegExp(`^${t('sf.dp.name')}`) })
		).toBeNull();
		await userEvent.click(
			canvas.getByRole('button', { name: new RegExp(`^${t('sf.part.mapping-schemas')}`) })
		);
		await expect(
			await canvas.findByRole('textbox', { name: new RegExp(`^${t('sf.dp.name')}`) })
		).toHaveValue('Edited on the way');
	}}
/>

<Story
	name="A new output source is made from the input and output node, from a template"
	args={{ protocol: 'saml' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await openOutput(canvasElement);
		// A set is already in use, yet an output source can be made here: a button in its own right.
		await userEvent.click(await canvas.findByRole('button', { name: t('sf.dp.field.create') }));
		// The editor opens with "from a template" chosen, and the template browser shown.
		await expect(canvas.getByRole('radio', { name: t('sf.dp.method.template') })).toBeChecked();
		await canvas.findByRole('group', { name: t('sf.dp.templates') });
		await expect(canvas.getByRole('radio', { name: t('sf.dp.method.manual') })).not.toBeChecked();
		// The mapping node has no such button.
		await userEvent.click(
			canvas.getByRole('button', { name: new RegExp(`^${t('sf.part.mapping-sets')}`) })
		);
		await expect(canvas.queryByRole('button', { name: t('sf.dp.field.create') })).toBeNull();
	}}
/>

<Story
	name="The mapping node is the mapping set screen: the changes can be seen before saving"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await openMapping(canvasElement);
		await canvas.findByRole('button', { name: /^email/ });
		// The same cards as the mapping sets page: the claim mapping and "See the changes".
		await canvas.findByRole('heading', { name: t('mc.ch.check') });
		await userEvent.click(canvas.getByRole('button', { name: t('mc.ch.check') }));
		const result = await canvas.findByRole('table', { name: t('mc.ch.result') });
		await within(result).findByText('Staff portal');
		// Nothing of the output source is on this node.
		await expect(canvas.queryByRole('button', { name: t('sf.dp.field.create') })).toBeNull();
	}}
/>

<Story
	name="The save bar rises while the mapping has unsaved changes, and Discard puts the bound set back"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await openMapping(canvasElement);
		await canvas.findByRole('button', { name: /^email/ });
		await expect(canvas.queryByRole('region', { name: t('common.unsaved') })).toBeNull();
		const field = canvas.getByRole('combobox', { name: /Mapping set$/ });
		const bound = (field as HTMLSelectElement).value;
		await userEvent.selectOptions(field, 'set-shared');
		const bar = await canvas.findByRole('region', { name: t('common.unsaved') });
		await expect(within(bar).getByRole('button', { name: t('cm.saveBind') })).toBeEnabled();
		await userEvent.click(within(bar).getByRole('button', { name: t('common.discard') }));
		await waitFor(() =>
			expect(canvas.queryByRole('region', { name: t('common.unsaved') })).toBeNull()
		);
		await waitFor(() => expect(field).toHaveValue(bound));
	}}
/>

<Story
	name="While an output source is being changed, the mapping waits"
	args={{ protocol: 'saml' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await openOutput(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('sf.dp.field.edit') }));
		await userEvent.click(
			canvas.getByRole('button', { name: new RegExp(`^${t('sf.part.mapping-sets')}`) })
		);
		await canvas.findByText(t('cm.finishOutputFirst'));
		await expect(canvas.getByRole('combobox', { name: /Mapping set$/ })).toBeDisabled();
		await expect(canvas.getByRole('button', { name: t('cm.create') })).toBeDisabled();
	}}
/>
