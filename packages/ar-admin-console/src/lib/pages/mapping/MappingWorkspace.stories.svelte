<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeIdentityMapping, DEMO_TENANT } from '$lib/api/fake/identity-mapping-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import MappingWorkspace from './MappingWorkspace.svelte';

	const previewSettled = fn();
	const slowPreview = () => {
		const client = createFakeIdentityMapping();
		return {
			...client,
			bulkPreview: async (...args: Parameters<typeof client.bulkPreview>) => {
				const answer = await client.bulkPreview(...args);
				await new Promise((resolve) => setTimeout(resolve, 1200));
				previewSettled();
				return answer;
			}
		};
	};

	const { Story } = defineMeta({
		title: 'Pages/Mapping/Navigation',
		component: MappingWorkspace,
		tags: ['autodocs', 'draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Shared tenant lists, application details and mapping-set details. MAP-01 uses selection and bulk actions on the tenant list; MAP-03, MAP-04 and MAP-08 share application tabs; MAP-05 uses the set editor and its optional preview. Every story uses the same navigation and in-memory client. These are UI prototypes, not deployed API integrations.'
				}
			}
		}
	});
</script>

<Story name="Applications">
	{#snippet template()}<MappingWorkspace
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			tenantName="Aster"
		/>{/snippet}
</Story>

<Story
	name="Late impact results cannot replace a revisited page"
	play={async ({ canvasElement }) => {
		previewSettled.mockClear();
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('checkbox', { name: t('table.selectRow', { name: 'Birch' }) })
		);
		await userEvent.click(canvas.getByRole('button', { name: t('mc.nav.changeDefault') }));
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('mc.ro.setLabel') }),
			'fms_affil'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('mc.ro.check') }));
		await userEvent.click(canvas.getByRole('button', { name: 'Aster' }));
		await canvas.findByRole('table', { name: t('mc.hist.title') });
		await userEvent.click(canvas.getByRole('button', { name: t('mc.nav.back') }));
		await waitFor(() => expect(previewSettled).toHaveBeenCalled(), { timeout: 5000 });
		expect(canvas.queryByRole('button', { name: t('mc.ro.run', { count: 1 }) })).toBeNull();
		await expect(canvas.getByRole('button', { name: t('mc.ro.check') })).toBeEnabled();
	}}
>
	{#snippet template()}<MappingWorkspace page="tenants" client={slowPreview()} />{/snippet}
</Story>

<Story
	name="Restoring a tenant refreshes the tenant list (MAP-08)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: 'Aster' }));
		await userEvent.click(
			(await canvas.findAllByRole('button', { name: t('mc.hist.restore') }))[0]
		);
		const dialog = within(await within(document.body).findByRole('dialog'));
		await userEvent.click(dialog.getByRole('button', { name: t('mc.hist.dialog.submit') }));
		await canvas.findByText(t('mc.hist.via.restore'));
		await userEvent.click(canvas.getByRole('button', { name: t('mc.nav.back') }));
		await waitFor(() => {
			const row = canvas.getByRole('row', { name: /Aster/ });
			expect(within(row).queryByText('Aster campus claims')).toBeNull();
			expect(within(row).getAllByText('Affiliation claims').length).toBeGreaterThan(0);
		});
	}}
>
	{#snippet template()}<MappingWorkspace
			page="tenants"
			client={createFakeIdentityMapping()}
		/>{/snippet}
</Story>

<Story
	name="Tenant history remains available while an app list is pending"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('mc.nav.tenants') }));
		await userEvent.click(await canvas.findByRole('button', { name: 'Aster' }));
		await canvas.findByRole('table', { name: t('mc.hist.title') });
		await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Aster');
	}}
>
	{#snippet template()}<MappingWorkspace
			client={{ ...createFakeIdentityMapping(), apps: () => new Promise(() => {}) }}
			tenantId={DEMO_TENANT}
		/>{/snippet}
</Story>

<Story
	name="Saving locks application navigation"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(`^${t('mc.app.none')}`) })
		);
		await userEvent.click(
			await within(document.body).findByRole('button', { name: t('common.save') })
		);
		await waitFor(() => expect(canvas.getByRole('tab', { name: t('mc.nav.test') })).toBeDisabled());
		await expect(canvas.getByRole('button', { name: t('mc.nav.tenants') })).toBeDisabled();
		await canvas.findAllByText(t('mc.none.client_opt_out'), {}, { timeout: 5000 });
		await waitFor(() => expect(canvas.getByRole('tab', { name: t('mc.nav.test') })).toBeEnabled());
	}}
>
	{#snippet template()}<MappingWorkspace
			page="app"
			clientId="app_library"
			client={createFakeIdentityMapping({ delay: 400 })}
			tenantId={DEMO_TENANT}
		/>{/snippet}
</Story>

<Story name="Mapping sets">
	{#snippet template()}<MappingWorkspace
			page="sets"
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			tenantName="Aster"
		/>{/snippet}
</Story>

<Story
	name="App context across mapping and test (MAP-03, MAP-04)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			await canvas.findByRole('textbox', { name: t('mc.nav.searchApps') }),
			'Library'
		);
		await userEvent.click(canvas.getByRole('button', { name: 'Library portal' }));
		await userEvent.click(await canvas.findByRole('tab', { name: t('mc.nav.test') }));
		expect(canvas.queryByRole('combobox', { name: t('mc.ex.app') })).toBeNull();
		await userEvent.selectOptions(
			await canvas.findByRole('combobox', { name: t('mc.ex.user') }),
			'test_no_affiliation'
		);
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('mc.ex.surface') }),
			'userinfo'
		);
		await userEvent.click(canvas.getByRole('radio', { name: t('mc.ex.consentChoice.none') }));
		await userEvent.click(canvas.getByRole('button', { name: t('mc.ex.run') }));
		await canvas.findByText(t('mc.ex.reason.value_missing'));
		await userEvent.click(canvas.getByRole('tab', { name: t('mc.nav.mapping') }));
		await canvas.findByRole('radio', { name: new RegExp(`^${t('mc.app.follow')}`) });
		await userEvent.click(canvas.getByRole('tab', { name: t('mc.nav.test') }));
		await expect(await canvas.findByRole('combobox', { name: t('mc.ex.user') })).toHaveValue(
			'test_no_affiliation'
		);
		await expect(canvas.getByRole('combobox', { name: t('mc.ex.surface') })).toHaveValue(
			'userinfo'
		);
		await expect(canvas.getByRole('radio', { name: t('mc.ex.consentChoice.none') })).toBeChecked();
		await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Library portal');
	}}
>
	{#snippet template()}<MappingWorkspace
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			tenantName="Aster"
		/>{/snippet}
</Story>

<Story
	name="Unsaved changes stay on the application"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(`^${t('mc.app.none')}`) })
		);
		await userEvent.click(canvas.getByRole('tab', { name: t('mc.nav.test') }));
		const dialog = within(await within(document.body).findByRole('dialog'));
		await userEvent.click(dialog.getByRole('button', { name: t('unsaved.stay') }));
		await expect(canvas.getByRole('tab', { name: t('mc.nav.mapping') })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(
			canvas.getByRole('radio', { name: new RegExp(`^${t('mc.app.none')}`) })
		).toBeChecked();
		await userEvent.click(canvas.getByRole('tab', { name: t('mc.nav.test') }));
		await userEvent.click(
			within(await within(document.body).findByRole('dialog')).getByRole('button', {
				name: t('unsaved.leave')
			})
		);
		await canvas.findByRole('combobox', { name: t('mc.ex.user') });
		await userEvent.click(canvas.getByRole('tab', { name: t('mc.nav.mapping') }));
		await expect(
			await canvas.findByRole('radio', { name: new RegExp(`^${t('mc.app.follow')}`) })
		).toBeChecked();
	}}
>
	{#snippet template()}<MappingWorkspace
			page="app"
			clientId="app_library"
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			tenantName="Aster"
		/>{/snippet}
</Story>

<Story
	name="Saved choice appears in the same app history (MAP-08)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(`^${t('mc.app.none')}`) })
		);
		await userEvent.click(
			await within(document.body).findByRole('button', { name: t('common.save') })
		);
		await canvas.findAllByText(t('mc.none.client_opt_out'));
		await waitFor(() =>
			expect(canvas.getByRole('tab', { name: t('mc.nav.history') })).toBeEnabled()
		);
		await userEvent.click(canvas.getByRole('tab', { name: t('mc.nav.history') }));
		const history = within(await canvas.findByRole('table', { name: t('mc.hist.title') }));
		await history.findByText(t('mc.hist.level.client', { app: 'Library portal' }));
		expect(history.queryByText(t('mc.hist.level.tenant_default'))).toBeNull();
		await userEvent.click(history.getAllByRole('button', { name: t('mc.hist.restore') })[0]);
		const dialog = within(await within(document.body).findByRole('dialog'));
		await userEvent.click(dialog.getByRole('button', { name: t('mc.hist.dialog.submit') }));
		await canvas.findByText(t('mc.hist.via.restore'));
		await userEvent.click(canvas.getByRole('tab', { name: t('mc.nav.mapping') }));
		await expect(
			await canvas.findByRole('radio', { name: new RegExp(`^${t('mc.app.follow')}`) })
		).toBeChecked();
	}}
>
	{#snippet template()}<MappingWorkspace
			page="app"
			clientId="app_library"
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			tenantName="Aster"
		/>{/snippet}
</Story>

<Story
	name="Tenant selection survives opening a set (MAP-01, MAP-05)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('checkbox', { name: t('table.selectRow', { name: 'Birch' }) })
		);
		await userEvent.click(canvas.getByRole('button', { name: t('mc.nav.changeDefault') }));
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('mc.ro.setLabel') }),
			'fms_affil'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('mc.ro.check') }));
		await userEvent.click(await canvas.findByRole('button', { name: t('mc.ro.impact.preview') }));
		await canvas.findByRole('button', { name: t('mc.ch.check') });
		await userEvent.click(canvas.getByRole('button', { name: t('mc.nav.back') }));
		await expect(
			canvas.getByRole('checkbox', { name: t('table.selectRow', { name: 'Birch' }) })
		).toBeChecked();
		await expect(canvas.getByRole('combobox', { name: t('mc.ro.setLabel') })).toHaveValue(
			'fms_affil'
		);
		await canvas.findByRole('button', { name: t('mc.ro.run', { count: 1 }) });
	}}
>
	{#snippet template()}<MappingWorkspace
			page="tenants"
			client={createFakeIdentityMapping()}
		/>{/snippet}
</Story>
