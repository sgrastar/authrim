<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeSourceProfiles, mockSource } from '#lib/api/fake/source-profiles-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SourceProfileEditor from './SourceProfileEditor.svelte';
	import { sourceSchemaFromForm, emptySourceForm, emptySourceRow } from './source-profile-model';

	const { Story } = defineMeta({
		title: 'Pages/Profiles/Input source editor',
		component: SourceProfileEditor,
		tags: ['autodocs'],
		parameters: {
			layout: 'padded',
			docs: {
				description: {
					component:
						'Makes or changes an input source (a SCIM user schema or the columns of a CSV file): a title that can be changed, a start from a template (SCIM), a copy of an existing one or nothing, and the attributes (columns) as a table edited in place. One save writes, reviews and switches it on.'
				}
			}
		}
	});

	const csvForm = emptySourceForm('csv');
	csvForm.rows = [{ ...emptySourceRow(), key: 'Employee ID' }];
	const existing = mockSource('csv', 'csv-1', 'Staff file', sourceSchemaFromForm(csvForm));
	const ready = (kind: 'scim' | 'csv') => {
		const fake = createFakeSourceProfiles([existing]);
		const onsaved = fn();
		return {
			fake,
			onsaved,
			args: {
				kind,
				tenantId: 'demo',
				client: fake,
				profiles: [existing].filter((row) => row.sourceType === kind),
				onsaved,
				oncancel: fn()
			}
		};
	};
	const scim = ready('scim');
	const csv = ready('csv');
</script>

<Story
	name="SCIM: from a template, the title is changed, saved"
	args={scim.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('radio', { name: t('sf.dp.method.template') })).toBeChecked();
		await userEvent.click(canvas.getByRole('button', { name: /Workforce/ }));
		await userEvent.click(canvas.getByRole('button', { name: /SCIM Enterprise User/ }));
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.template.use') }));
		await canvas.findByDisplayValue('enterprise.employeeNumber');
		const title = canvas.getByRole('textbox', { name: new RegExp(`^${t('sf.sp.name')}`) });
		await expect(title).toHaveValue('SCIM Enterprise User');
		await userEvent.clear(title);
		await userEvent.type(title, 'Directory feed');
		await userEvent.click(canvas.getByRole('button', { name: t('sf.dp.save') }));
		await waitFor(() => expect(scim.onsaved).toHaveBeenCalled());
		await expect(scim.fake.saved[0]).toMatchObject({
			sourceType: 'scim',
			displayName: 'Directory feed'
		});
		await expect(scim.fake.saved[0].profileKey).toMatch(/^directory_feed_/);
	}}
/>

<Story
	name="CSV: columns are added by hand"
	args={csv.args}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// A CSV has no template: it starts empty, or as a copy of one that exists.
		await expect(canvas.getByRole('radio', { name: t('sf.dp.method.manual') })).toBeChecked();
		await expect(canvas.queryByRole('radio', { name: t('sf.dp.method.template') })).toBeNull();
		const save = canvas.getByRole('button', { name: t('sf.dp.save') });
		await expect(save).toBeDisabled();
		await userEvent.type(
			canvas.getByRole('textbox', { name: new RegExp(`^${t('sf.sp.name')}`) }),
			'Payroll'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.sp.addColumn') }));
		await userEvent.type(canvas.getAllByRole('textbox', { name: /Header/ })[0], 'Employee ID');
		await userEvent.click(save);
		await waitFor(() => expect(csv.onsaved).toHaveBeenCalled());
		await expect(csv.fake.saved[0].schema).toMatchObject({
			sourceType: 'csv',
			columns: [{ headerName: 'Employee ID' }]
		});
	}}
/>
