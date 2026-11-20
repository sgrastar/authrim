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
