<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import {
		createFakeDestinationProfiles,
		mockProfile
	} from '#lib/api/fake/destination-profiles-fake.js';
	import { createFakeSourceProfiles, mockSource } from '#lib/api/fake/source-profiles-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import {
		formFromSchema,
		schemaFromForm
	} from '#lib/pages/service-flows/destination-profile/destination-profile-model.js';
	import { templatesFor } from '#lib/pages/service-flows/destination-profile/templates/index.js';
	import ProfilesPage from './ProfilesPage.svelte';
	import { emptySourceForm, emptySourceRow, sourceSchemaFromForm } from './source-profile-model';

	const { Story } = defineMeta({
		title: 'Pages/Profiles/Profiles',
		component: ProfilesPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'The tenant’s output sources (SAML attributes, OIDC claims) and input sources (SCIM attributes, CSV columns): listed together, made and changed with the editor a service flow opens in place, and deleted. A save switches the profile on; there are no versions or releases here.'
				}
			}
		}
	});

	const samlSchema = schemaFromForm(formFromSchema('saml', '', templatesFor('saml')[0].schema));
	const csvForm = emptySourceForm('csv');
	csvForm.rows = [{ ...emptySourceRow(), key: 'Employee ID' }];
	const world = (inUse: string[] = []) => {
		const destinations = createFakeDestinationProfiles([
			mockProfile('saml', 'saml-1', 'Portal attributes', samlSchema),
			mockProfile(
				'oidc',
				'oidc-1',
				'Portal claims',
				{ destinationType: 'oidc', claims: [] },
				'draft'
			)
		]);
		const sources = createFakeSourceProfiles(
			[mockSource('csv', 'csv-1', 'Staff file', sourceSchemaFromForm(csvForm))],
			{ inUse }
		);
		return {
			destinations,
			sources,
			args: { tenantId: 'demo', destinations, sources, canWrite: true }
		};
	};
	const listed = world();
	const created = world();
	const changed = world();
	const removed = world();
	const inUse = world(['csv-1']);
	const readOnly = world();
</script>

<Story
	name="All the profiles in one list"
	args={listed.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Portal attributes');
		await expect(canvas.getByText('Portal claims')).toBeVisible();
		await expect(canvas.getByText('Staff file')).toBeVisible();
		await expect(canvas.getByText(t('pf.kind.saml'))).toBeVisible();
		await expect(canvas.getByText(t('pf.kind.csv'))).toBeVisible();
		// What is not switched on yet says so.
		await expect(canvas.getByText(t('pf.state.draft'))).toBeVisible();
	}}
/>

<Story
	name="A new output source is made from a template and appears in the list"
	args={created.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Portal attributes');
		await userEvent.click(canvas.getByRole('button', { name: t('pf.create.saml') }));
		await userEvent.click(await canvas.findByRole('button', { name: /Academic federation/ }));
		await userEvent.click(canvas.getByRole('button', { name: /REFEDS Research and Scholarship/ }));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.template.use') }));
		await canvas.findByDisplayValue('eduPersonPrincipalName');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		await canvas.findByText(t('pf.saved'));
		await canvas.findByText('REFEDS Research and Scholarship');
		await expect(created.destinations.saved).toHaveLength(1);
	}}
/>

<Story
	name="An input source is changed in place"
	args={changed.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Staff file');
		await userEvent.click(
			canvas.getByRole('button', { name: t('pf.actionsFor', { name: 'Staff file' }) })
		);
		await userEvent.click(await canvas.findByRole('menuitem', { name: t('pf.edit') }));
		const title = await canvas.findByRole('textbox', { name: new RegExp(`^${t('sf.sp.name')}`) });
		await userEvent.clear(title);
		await userEvent.type(title, 'Staff file (2026)');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		await canvas.findByText('Staff file (2026)');
		await expect(changed.sources.saved[0]).toMatchObject({ id: 'csv-1' });
	}}
/>

<Story
	name="Deleting asks first"
	args={removed.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Portal attributes');
		await userEvent.click(
			canvas.getByRole('button', { name: t('pf.actionsFor', { name: 'Portal attributes' }) })
		);
		await userEvent.click(await canvas.findByRole('menuitem', { name: t('pf.delete') }));
		const dialog = await within(document.body).findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: t('pf.delete') }));
		await waitFor(() => expect(removed.destinations.removed).toEqual(['saml-1']));
		await canvas.findByText(t('pf.deleted'));
		await waitFor(() => expect(canvas.queryByText('Portal attributes')).toBeNull());
		// An input source is offered for deletion too.
		await userEvent.click(
			canvas.getByRole('button', { name: t('pf.actionsFor', { name: 'Staff file' }) })
		);
		await userEvent.click(await canvas.findByRole('menuitem', { name: t('pf.delete') }));
		const second = await within(document.body).findByRole('dialog');
		await userEvent.click(within(second).getByRole('button', { name: t('pf.delete') }));
		await waitFor(() => expect(removed.sources.removed).toEqual(['csv-1']));
		await waitFor(() => expect(canvas.queryByText('Staff file')).toBeNull());
	}}
/>

<Story
	name="An input source still in use is not deleted; the reason is shown"
	args={inUse.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Staff file');
		await userEvent.click(
			canvas.getByRole('button', { name: t('pf.actionsFor', { name: 'Staff file' }) })
		);
		await userEvent.click(await canvas.findByRole('menuitem', { name: t('pf.delete') }));
		const dialog = await within(document.body).findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: t('pf.delete') }));
		await within(dialog).findByText('This input source is still used by a mapping set.');
		await expect(inUse.sources.removed).toEqual([]);
		await expect(canvas.getByText('Staff file')).toBeTruthy();
	}}
/>

<Story
	name="Read only: nothing to make, change or delete"
	args={{ ...readOnly.args, canWrite: false }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Portal attributes');
		await expect(canvas.queryByRole('button', { name: t('pf.create.saml') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: /^Actions for/ })).toBeNull();
	}}
/>
