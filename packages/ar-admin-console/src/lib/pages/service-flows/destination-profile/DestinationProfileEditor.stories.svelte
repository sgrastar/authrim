<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import {
		createFakeDestinationProfiles,
		mockProfile
	} from '#lib/api/fake/destination-profiles-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import DestinationProfileEditor from './DestinationProfileEditor.svelte';
	import { schemaFromForm, formFromSchema } from './destination-profile-model';
	import { templatesFor } from './templates';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Output source editor',
		component: DestinationProfileEditor,
		tags: ['autodocs'],
		parameters: {
			layout: 'padded',
			docs: {
				description: {
					component:
						'Makes or changes an output source (a destination profile) from a service flow: a title that can be changed, a way to start (a template from the catalogue, a copy of an existing output source, or manual) and the attributes (SAML) or claims (OIDC) as a table edited in place. One Save writes, reviews and switches the profile on, so there are no versions to manage; a profile that mapping sets already send into asks first, naming them.'
				}
			}
		}
	});

	const gakunin = templatesFor('saml').find(
		(template) => template.displayName === 'GakuNin application standard'
	)!;
	const existing = mockProfile(
		'saml',
		'saml-profile-1',
		'Standard SAML attributes',
		schemaFromForm(formFromSchema('saml', '', templatesFor('saml')[0].schema))
	);
	const ready = (fake = createFakeDestinationProfiles([existing])) => {
		const onsaved = fn();
		const oncancel = fn();
		return {
			fake,
			onsaved,
			oncancel,
			args: {
				protocol: 'saml' as const,
				tenantId: 'demo',
				client: fake,
				profiles: [existing],
				onsaved,
				oncancel
			}
		};
	};
	const fromTemplate = ready();
	const manual = ready();
	const copy = ready();
	const inUse = ready();
	const retry = ready(
		createFakeDestinationProfiles([existing], { blockReview: 'blocking warning' })
	);
	const draft = ready(
		createFakeDestinationProfiles([existing], { blockReview: 'blocking warning' })
	);
	const oidc = ready();
	const stopped = ready(
		createFakeDestinationProfiles([existing], { blockReview: 'blocking warning' })
	);
</script>

<Story
	name="From a template: pick it, change the title, edit the table, save"
	args={fromTemplate.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// The template catalogue is the default way to start, in the old screen's categories.
		await expect(canvas.getByRole('radio', { name: t('sf.dp.method.template') })).toBeChecked();
		await userEvent.click(canvas.getByRole('button', { name: /Academic federation/ }));
		await userEvent.click(canvas.getByRole('button', { name: /GakuNin application standard/ }));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.template.use') }));
		// The table holds the template's attributes; the title took its name and can be changed.
		await canvas.findByDisplayValue('eduPersonPrincipalName');
		const title = canvas.getByRole('textbox', { name: new RegExp(`^${t('sf.dp.name')}`) });
		await expect(title).toHaveValue('GakuNin application standard');
		await userEvent.clear(title);
		await userEvent.type(title, 'Research service');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		await waitFor(() => expect(fromTemplate.onsaved).toHaveBeenCalled());
		const saved = fromTemplate.fake.saved[0];
		await expect(saved).toMatchObject({ destinationType: 'saml', displayName: 'Research service' });
		await expect(saved.id).toBeUndefined();
		await expect(saved.profileKey).toMatch(/^research_service_/);
		await expect((saved.schema.attributes as unknown[]).length).toBe(
			(gakunin.schema.attributes as unknown[]).length
		);
	}}
/>

<Story
	name="Manual: an empty table to fill in"
	args={manual.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.dp.method.manual') }));
		const save = canvas.getByRole('button', { name: t('sf.dp.save') });
		await expect(save).toBeDisabled();
		await userEvent.type(
			canvas.getByRole('textbox', { name: new RegExp(`^${t('sf.dp.name')}`) }),
			'Mine'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.addAttribute') }));
		await userEvent.type(canvas.getAllByRole('textbox', { name: /Attribute/ })[0], 'mail');
		await expect(save).toBeEnabled();
		await userEvent.click(save);
		await waitFor(() => expect(manual.onsaved).toHaveBeenCalled());
		await expect(manual.fake.saved[0].schema).toMatchObject({
			destinationType: 'saml',
			attributes: [{ name: 'mail' }]
		});
	}}
/>

<Story
	name="From an existing output source: a copy with a title of its own"
	args={copy.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.dp.method.existing') }));
		await userEvent.selectOptions(
			await canvas.findByRole('combobox', { name: t('sf.dp.existing.choose') }),
			'saml-profile-1'
		);
		await expect(
			canvas.getByRole('textbox', { name: new RegExp(`^${t('sf.dp.name')}`) })
		).toHaveValue(t('sf.dp.existing.copy', { name: 'Standard SAML attributes' }));
		await canvas.findByDisplayValue('mail');
	}}
/>

<Story
	name="One that mapping sets send into asks first, naming them"
	args={{ ...inUse.args, profile: existing, usedBy: ['Staff attributes', 'Partner attributes'] }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByDisplayValue('mail');
		// A change is saved in place (the profile is switched on again), after the impact is shown.
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		const dialog = await within(document.body).findByRole('dialog');
		await expect(dialog).toHaveTextContent('Staff attributes, Partner attributes');
		await expect(inUse.fake.saved).toHaveLength(0);
		await userEvent.click(within(dialog).getByRole('button', { name: t('sf.dp.impact.confirm') }));
		await waitFor(() => expect(inUse.onsaved).toHaveBeenCalled());
		await expect(inUse.fake.saved[0]).toMatchObject({ id: 'saml-profile-1' });
	}}
/>

<Story
	name="A review that stops it keeps a draft and says so"
	args={draft.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.dp.method.manual') }));
		await userEvent.type(
			canvas.getByRole('textbox', { name: new RegExp(`^${t('sf.dp.name')}`) }),
			'Mine'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.addAttribute') }));
		await userEvent.type(canvas.getAllByRole('textbox', { name: /Attribute/ })[0], 'mail');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		await canvas.findByText(t('sf.dp.draft.title'));
		await expect(canvas.getByText('blocking warning')).toBeVisible();
		await expect(draft.onsaved).not.toHaveBeenCalled();
		// Saving again goes on with the profile that was written; it does not make another.
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		await waitFor(() => expect(draft.fake.saved).toHaveLength(2));
		await expect(draft.fake.saved[0].id).toBeUndefined();
		await expect(draft.fake.saved[1].id).toBe('profile-2');
		await expect(draft.fake.saved[1].profileKey).toBeUndefined();
	}}
/>

<Story
	name="OIDC: claims with where they are released"
	args={{ ...oidc.args, protocol: 'oidc' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: /General settings/ }));
		await userEvent.click(canvas.getByRole('button', { name: /Standard OIDC claims/ }));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.template.use') }));
		await canvas.findByDisplayValue('given_name');
		await expect(canvas.getAllByRole('checkbox', { name: /ID token/ }).length).toBeGreaterThan(0);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		await waitFor(() => expect(oidc.onsaved).toHaveBeenCalled());
		await expect(oidc.fake.saved[0].schema).toMatchObject({ destinationType: 'oidc' });
	}}
/>

<Story
	name="When what sends into it cannot be checked, it is treated as in use"
	args={{ ...ready().args, profile: existing, usageUnknown: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByDisplayValue('mail');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		const dialog = await within(document.body).findByRole('dialog');
		await expect(dialog).toHaveTextContent(t('sf.dp.impact.unknown'));
	}}
/>

<Story
	name="Changing one that is serving: a stopped save leaves the previous version in use"
	args={{ ...stopped.args, profile: existing }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByDisplayValue('mail');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		await canvas.findByText(t('sf.dp.draft.title'));
		await expect(canvas.getByText(t('sf.dp.draft.editWarning'))).toBeVisible();
		await expect(stopped.onsaved).not.toHaveBeenCalled();
	}}
/>

<Story
	name="A template's preview lists its attributes as labels"
	args={ready().args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: /Academic federation/ }));
		await userEvent.click(canvas.getByRole('button', { name: /GakuNin application standard/ }));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.template.preview') }));
		const count = (gakunin.schema.attributes as unknown[]).length;
		await canvas.findByText(t('sf.dp.template.attributes', { count }));
		// One label for each attribute, named as a person knows it, with the attribute's own name as
		// its hover text; not one run-on line of identifiers.
		const labels = canvas.getAllByRole('listitem').filter((item) => item.hasAttribute('title'));
		await expect(labels).toHaveLength(count);
		await expect(labels.some((item) => item.getAttribute('title')?.startsWith('urn:oid:'))).toBe(
			true
		);
		await expect(
			labels.every((item) => !(item.textContent ?? '').trim().startsWith('urn:oid:'))
		).toBe(true);
	}}
/>

<Story
	name="The title comes after the way to start, right above the NameID settings"
	args={ready().args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const title = canvas.getByRole('textbox', { name: new RegExp(`^${t('sf.dp.name')}`) });
		const method = canvas.getByRole('radio', { name: t('sf.dp.method.template') });
		const format = canvas.getByRole('combobox', { name: t('sf.dp.nameId.format') });
		const follows = (a: Element, b: Element) =>
			Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
		await expect(follows(method, title)).toBe(true);
		await expect(follows(title, format)).toBe(true);
	}}
/>

<Story
	name="A draft that was not switched on can be switched on again without being written again"
	args={retry.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.dp.method.manual') }));
		await userEvent.type(
			canvas.getByRole('textbox', { name: new RegExp(`^${t('sf.dp.name')}`) }),
			'Mine'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.addAttribute') }));
		await userEvent.type(canvas.getAllByRole('textbox', { name: /Attribute/ })[0], 'mail');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		await canvas.findByText(t('sf.dp.draft.title'));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.draft.retry') }));
		await waitFor(() => expect(retry.onsaved).toHaveBeenCalled());
		await expect(retry.fake.activated).toHaveLength(1);
		// Nothing was written a second time.
		await expect(retry.fake.saved).toHaveLength(1);
	}}
/>

<Story
	name="Switching on again is offered only for the draft as it was written"
	args={ready(createFakeDestinationProfiles([existing], { blockReview: 'blocking warning' })).args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('radio', { name: t('sf.dp.method.manual') }));
		const title = canvas.getByRole('textbox', { name: new RegExp(`^${t('sf.dp.name')}`) });
		await userEvent.type(title, 'Mine');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.addAttribute') }));
		await userEvent.type(canvas.getAllByRole('textbox', { name: /Attribute/ })[0], 'mail');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		await canvas.findByRole('button', { name: t('sf.dp.draft.retry') });
		// A change to the form is a new draft to write: it is saved, not switched on from the old one.
		await userEvent.type(title, ' changed');
		await waitFor(() =>
			expect(canvas.queryByRole('button', { name: t('sf.dp.draft.retry') })).toBeNull()
		);
	}}
/>

<Story
	name="Taking a template closes its preview, and the table shows sample values and the identifier's type"
	args={ready().args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: /Academic federation/ }));
		await userEvent.click(canvas.getByRole('button', { name: /GakuNin application standard/ }));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.template.preview') }));
		const count = (gakunin.schema.attributes as unknown[]).length;
		await canvas.findByText(t('sf.dp.template.attributes', { count }));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.template.use') }));
		await canvas.findByDisplayValue('eduPersonPrincipalName');
		// The preview is gone with the choice.
		await expect(canvas.queryByText(t('sf.dp.template.attributes', { count }))).toBeNull();
		// The sample values are a column again, in the federation's own words (Japanese names here).
		await canvas.findByRole('columnheader', { name: new RegExp(t('sf.dp.col.examples')) });
		await canvas.findByDisplayValue('山田');
		// eduPersonTargetedID's own kind of value has a name of its own, not a blank.
		const persistent = canvas
			.getAllByRole('combobox')
			.filter((field) => (field as HTMLSelectElement).value === 'saml:persistent-nameid');
		await expect(persistent).toHaveLength(1);
		await expect(persistent[0]).toHaveDisplayValue(t('sf.dp.type.persistentId'));
	}}
/>
