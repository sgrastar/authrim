<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import type { AdminAccess } from '$lib/access/access';
	import { createFakeSchemaSetting } from '$lib/api/fake/schema-setting-fake';
	import { createFakeSettings } from '$lib/api/fake/settings-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import SchemaSetting from './SchemaSetting.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Access/Schema setting',
		component: SchemaSetting,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Access → Attribute schema: every attribute a person can have, the base ones (the OIDC standard, added from a preset) and the tenant’s own, in one list. The list is **one table**, sorted by key to begin with, **up to 250 rows a page** (the API gives 100 at once, so a page is put together from several calls), with **sortable headers** (the API has no sort, so the page sorts the rows itself, and only when all of them are on the page), **kind (base / custom), PII and required / optional as badges in columns of their own**. There are no selectable rows: the API has no bulk operation, and a delete runs through every person\u2019s stored values, so each attribute is changed on its own page. The attribute\u2019s own page is a box of independent settings, so its rows are **ruled** (a line between them, as in the settings pages). A row opens the attribute: its settings (confirmed with Save, sending only what changed), where it is relied on, its history, and the two actions that move or remove people’s saved values, changing the key and deleting. Built on `/api/admin/custom-claims/*`; the stories use an in-memory API.'
				}
			}
		}
	});

	const TENANT = 'acme';
	const EDITOR: AdminAccess = {
		platform: false,
		roles: ['tenant_admin'],
		permissions: ['admin:settings:read', 'admin:settings:write']
	};
	const VIEWER: AdminAccess = {
		platform: false,
		roles: ['tenant_admin'],
		permissions: ['admin:settings:read']
	};
	const body = () => within(document.body);
	/** Waits for a text that may be on screen more than once (a key in a row and in its label). */
	const seen = async (scope: ReturnType<typeof within>, text: string) =>
		(await scope.findAllByText(text))[0];
</script>

<Story
	name="List"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await seen(canvas, 'employee_id');
		// Base and own attributes are in one list, in the groups the sign-up screen uses.
		await seen(canvas, 'name');
		// A key is an identifier: monospace, at the size of the name beside it.
		const keyCell = canvasElement.querySelector('tbody code') as HTMLElement;
		const nameCell = keyCell.closest('tr')!.querySelectorAll('td')[1] as HTMLElement;
		await expect(getComputedStyle(keyCell).fontSize).toBe(getComputedStyle(nameCell).fontSize);
		await expect(getComputedStyle(keyCell).fontFamily).not.toBe(
			getComputedStyle(nameCell).fontFamily
		);
		// One table for all of them.
		await expect(canvas.getAllByRole('table')).toHaveLength(1);
		// No group column, and no group heading: the attributes are not grouped.
		await expect(canvas.queryAllByText('Workforce')).toHaveLength(0);
		// Kind (base / custom) is a column of its own; required and optional are badges.
		await canvas.findByRole('columnheader', { name: new RegExp(t('ss.col.origin')) });
		await seen(canvas, t('common.required'));
		await seen(canvas, t('ss.required.no'));
		// The feature that releases own attributes is off: said above the list.
		await canvas.findByText(t('ss.flagOff.title'));
		// One operation failed: said above the list too.
		await canvas.findByText(t('ss.errorBanner', { count: 1 }));
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting()}
			settings={createFakeSettings()}
			tenantId={TENANT}
			access={EDITOR}
		/>
	{/snippet}
</Story>

<Story
	name="Feature on"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await seen(canvas, 'employee_id');
		await waitFor(() => expect(canvas.queryByText(t('ss.flagOff.title'))).toBeNull());
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting()}
			settings={createFakeSettings({
				stored: { 'tenant:acme': { 'feature.enable_custom_claim_schemas': true } }
			})}
			tenantId={TENANT}
			access={EDITOR}
		/>
	{/snippet}
</Story>

<Story
	name="No attributes"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('ss.empty.title'));
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting({ empty: true })}
			tenantId={TENANT}
			access={EDITOR}
		/>
	{/snippet}
</Story>

<Story
	name="Filter"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await seen(canvas, 'employee_id');
		await userEvent.type(
			await canvas.findByRole('searchbox', { name: t('ss.filter.search') }),
			'cost{Enter}'
		);
		await seen(canvas, 'cost_center');
		await waitFor(() => expect(canvas.queryAllByText('employee_id')).toHaveLength(0));
		// Nothing matches: the list says so and offers to clear the conditions.
		const search = canvas.getByRole('searchbox', { name: t('ss.filter.search') });
		await userEvent.clear(search);
		await userEvent.type(search, 'no-such-thing{Enter}');
		await canvas.findByText(t('ss.empty.filtered'));
	}}
>
	{#snippet template()}
		<SchemaSetting client={createFakeSchemaSetting()} tenantId={TENANT} access={EDITOR} />
	{/snippet}
</Story>

<Story
	name="Add an attribute"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('ss.add') }));
		const dialog = await body().findByRole('dialog');
		// A key the API reserves is refused here, with the reason, before anything is sent.
		const key = within(dialog).getByRole('textbox', { name: t('ss.field.key') });
		await userEvent.type(key, 'email');
		await within(dialog).findByText(t('ss.key.reserved', { key: 'email' }));
		await userEvent.clear(key);
		await userEvent.type(key, 'badge_colour');
		await userEvent.type(
			within(dialog).getByRole('textbox', { name: t('ss.field.label') }),
			'Badge colour'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('ss.create.submit') }));
		// The new attribute opens, to be set up in full.
		await canvas.findByRole('heading', { level: 1, name: 'Badge colour' });
	}}
>
	{#snippet template()}
		<SchemaSetting client={createFakeSchemaSetting()} tenantId={TENANT} access={EDITOR} />
	{/snippet}
</Story>

<Story
	name="Add from a preset"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('ss.presetOpen') }));
		const dialog = await body().findByRole('dialog');
		await seen(within(dialog), 'given_name');
		await userEvent.click(within(dialog).getByRole('button', { name: t('ss.preset.submit') }));
		await waitFor(() => expect(body().queryByRole('dialog')).toBeNull());
		await seen(canvas, 'given_name');
	}}
>
	{#snippet template()}
		<SchemaSetting client={createFakeSchemaSetting()} tenantId={TENANT} access={EDITOR} />
	{/snippet}
</Story>

<Story
	name="Own attribute"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { level: 1, name: 'Employee ID' });
		// What a setting means is behind a "?" beside its name, not a line under the control.
		for (const name of [t('ss.field.active'), t('ss.field.required'), t('ss.col.pii')])
			await expect(
				canvas.getByRole('button', { name: new RegExp(`${t('common.moreInfo')}: ${name}`) })
			).toBeInTheDocument();
		// The description is as wide as the other controls, three lines tall.
		const description = canvas.getByRole('textbox', { name: t('ss.field.description') });
		const labelBox = canvas.getByRole('textbox', { name: t('ss.field.label') });
		await expect(description).toHaveAttribute('rows', '3');
		await expect(Math.round(description.getBoundingClientRect().left)).toBe(
			Math.round(labelBox.getBoundingClientRect().left)
		);
		// Changing a field raises the save bar; Save sends it and the page shows the new name.
		const label = canvas.getByRole('textbox', { name: t('ss.field.label') });
		await userEvent.clear(label);
		await userEvent.type(label, 'Staff ID');
		await userEvent.click(await canvas.findByRole('button', { name: t('common.save') }));
		await canvas.findByRole('heading', { level: 1, name: 'Staff ID' });
		// The change is in the history.
		await seen(canvas, t('ss.history.op.update'));
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting()}
			tenantId={TENANT}
			access={EDITOR}
			initialId="s-employee"
		/>
	{/snippet}
</Story>

<Story
	name="Invalid value"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { level: 1, name: 'Employee ID' });
		// Rules that make no sense are said field by field; nothing is sent.
		const min = canvas.getByRole('textbox', { name: t('ss.rules.minLength') });
		// A minimum and its maximum sit side by side.
		const max = canvas.getByRole('textbox', { name: t('ss.rules.maxLength') });
		await expect(Math.round(min.getBoundingClientRect().top)).toBe(
			Math.round(max.getBoundingClientRect().top)
		);
		await expect(max.getBoundingClientRect().left).toBeGreaterThan(
			min.getBoundingClientRect().right
		);
		await userEvent.clear(min);
		await userEvent.type(min, '20');
		await canvas.findByText(t('ss.rules.length_order'));
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await canvas.findByRole('heading', { level: 1, name: 'Employee ID' });
		await expect(canvas.getByRole('textbox', { name: t('ss.rules.maxLength') })).toHaveFocus();
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting()}
			tenantId={TENANT}
			access={EDITOR}
			initialId="s-employee"
		/>
	{/snippet}
</Story>

<Story
	name="Base attribute"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { level: 1, name: 'Full name' });
		// A base attribute keeps its identity locked.
		await canvas.findByText(t('ss.locked.system'));
		await expect(canvas.getByRole('textbox', { name: t('ss.field.label') })).toBeDisabled();
		// It cannot be deleted either.
		await expect(canvas.getByRole('button', { name: t('ss.delete.action') })).toBeDisabled();
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting()}
			tenantId={TENANT}
			access={EDITOR}
			initialId="s-name"
		/>
	{/snippet}
</Story>

<Story
	name="In use"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { level: 1, name: 'Email address' });
		await canvas.findByText('passkey_signup');
		await canvas.findByText('email_otp_login');
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting()}
			tenantId={TENANT}
			access={EDITOR}
			initialId="s-email"
		/>
	{/snippet}
</Story>

<Story
	name="Failed operation"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ss.op.failedTitle'));
		// While it is failed nothing can be changed.
		await expect(canvas.getByRole('textbox', { name: t('ss.field.label') })).toBeDisabled();
		await userEvent.click(canvas.getByRole('button', { name: t('ss.op.retry') }));
		await waitFor(() => expect(canvas.queryByText(t('ss.op.failedTitle'))).toBeNull());
		await expect(canvas.getByRole('textbox', { name: t('ss.field.label') })).toBeEnabled();
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting()}
			tenantId={TENANT}
			access={EDITOR}
			initialId="s-locker"
		/>
	{/snippet}
</Story>

<Story
	name="Stuck operation"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ss.op.stuckTitle'));
		await expect(canvas.getByRole('textbox', { name: t('ss.field.label') })).toBeDisabled();
		await expect(canvas.queryByRole('button', { name: t('ss.op.retry') })).toBeNull();
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting()}
			tenantId={TENANT}
			access={EDITOR}
			initialId="s-legacy"
		/>
	{/snippet}
</Story>

<Story
	name="Change the key"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { level: 1, name: 'Employee ID' });
		await userEvent.click(canvas.getAllByRole('button', { name: t('ss.rename.action') })[0]);
		const dialog = await body().findByRole('dialog');
		const key = within(dialog).getByRole('textbox', { name: t('ss.rename.newKey') });
		// The key it has now, and one another attribute uses, are refused with the reason.
		await userEvent.type(key, 'employee_id');
		await within(dialog).findByText(t('ss.key.same'));
		await userEvent.clear(key);
		await userEvent.type(key, 'staff_id');
		await userEvent.click(within(dialog).getByRole('button', { name: t('ss.rename.submit') }));
		await seen(canvas, 'staff_id');
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting()}
			tenantId={TENANT}
			access={EDITOR}
			initialId="s-employee"
		/>
	{/snippet}
</Story>

<Story
	name="Delete"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { level: 1, name: 'Cost center' });
		await userEvent.click(canvas.getByRole('button', { name: t('ss.delete.action') }));
		const dialog = await body().findByRole('dialog');
		// The key is typed to confirm.
		await userEvent.click(within(dialog).getByRole('button', { name: t('ss.delete.submit') }));
		await seen(within(dialog), t('ss.delete.confirmType', { key: 'cost_center' }));
		await userEvent.type(
			within(dialog).getByRole('textbox', { name: t('ss.field.key') }),
			'cost_center'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('ss.delete.submit') }));
		// Back to the list, without it.
		await seen(canvas, 'employee_id');
		await waitFor(() => expect(canvas.queryAllByText('cost_center')).toHaveLength(0));
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting()}
			tenantId={TENANT}
			access={EDITOR}
			initialId="s-cost"
		/>
	{/snippet}
</Story>

<Story
	name="Turn off instead of deleting"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { level: 1, name: 'Cost center' });
		await userEvent.click(canvas.getByRole('button', { name: t('ss.delete.action') }));
		const dialog = await body().findByRole('dialog');
		// Deleting is slow and can stop half-way: the dialog says so, and offers turning it off.
		await within(dialog).findByText(t('ss.delete.slowTitle'));
		await userEvent.click(
			within(dialog).getByRole('button', { name: t('ss.delete.deactivateInstead') })
		);
		await waitFor(() => expect(body().queryByRole('dialog')).toBeNull());
		// It is off; the values are kept, and it is not deleted.
		await within(canvasElement).findAllByText(t('ss.status.inactive'));
		await expect(
			canvas.getByRole('checkbox', { name: new RegExp(t('ss.field.active')) })
		).not.toBeChecked();
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting()}
			tenantId={TENANT}
			access={EDITOR}
			initialId="s-cost"
		/>
	{/snippet}
</Story>

<Story
	name="Delete stops half-way"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { level: 1, name: 'Cost center' });
		await userEvent.click(canvas.getByRole('button', { name: t('ss.delete.action') }));
		const dialog = await body().findByRole('dialog');
		await userEvent.type(
			within(dialog).getByRole('textbox', { name: t('ss.field.key') }),
			'cost_center'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('ss.delete.submit') }));
		// Some people's values could not be deleted: the attribute is marked failed, to retry.
		await canvas.findByText(t('ss.op.failedTitle'));
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting({ failPartially: true })}
			tenantId={TENANT}
			access={EDITOR}
			initialId="s-cost"
		/>
	{/snippet}
</Story>

<Story
	name="Read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { level: 1, name: 'Employee ID' });
		await expect(canvas.getByRole('textbox', { name: t('ss.field.label') })).toBeDisabled();
		await expect(canvas.queryByRole('button', { name: t('ss.delete.action') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('ss.rename.action') })).toBeNull();
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting()}
			tenantId={TENANT}
			access={VIEWER}
			initialId="s-employee"
		/>
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('ss.noAccess'));
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting()}
			tenantId={TENANT}
			access={{ platform: false, roles: ['support'], permissions: ['admin:users:read'] }}
		/>
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting({ delay: 60_000 })}
			tenantId={TENANT}
			access={EDITOR}
		/>
	{/snippet}
</Story>

<Story
	name="Long list"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await seen(canvas, 'imported_120');
		// More than the API gives at once (100) is on one page: it is put together from several
		// calls. (The page holds up to 250; `listWindow` is tested at that size.)
		await waitFor(() => expect(canvas.getAllByRole('row').length).toBe(133 + 1));
	}}
>
	{#snippet template()}
		<SchemaSetting
			client={createFakeSchemaSetting({ extra: 120 })}
			tenantId={TENANT}
			access={EDITOR}
		/>
	{/snippet}
</Story>

<Story
	name="Sort"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await seen(canvas, 'employee_id');
		const firstKey = () => canvas.getAllByRole('row')[1].textContent ?? '';
		const keyHeader = () => canvas.getByRole('columnheader', { name: new RegExp(t('ss.col.key')) });
		// By key, ascending, to begin with; a click turns it round.
		await expect(firstKey()).toContain('badge_expiry');
		await expect(keyHeader()).toHaveAttribute('aria-sort', 'ascending');
		await userEvent.click(canvas.getByRole('button', { name: new RegExp(t('ss.col.key')) }));
		await waitFor(() => expect(firstKey()).toContain('skills'));
		await expect(keyHeader()).toHaveAttribute('aria-sort', 'descending');
		// Another column sorts by itself.
		await userEvent.click(canvas.getByRole('button', { name: new RegExp(t('ss.col.label')) }));
		await waitFor(() => expect(firstKey()).toContain('Badge expires on'));
	}}
>
	{#snippet template()}
		<SchemaSetting client={createFakeSchemaSetting()} tenantId={TENANT} access={EDITOR} />
	{/snippet}
</Story>

<Story
	name="Filter by state"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await seen(canvas, 'locker_code');
		// "On" is what the status badge says of an attribute at rest: one that failed, or is being
		// renamed, shows that instead and is not in it.
		await userEvent.selectOptions(
			await canvas.findByRole('combobox', { name: t('ss.filter.status') }),
			t('ss.status.active')
		);
		await waitFor(() => expect(canvas.queryAllByText('locker_code')).toHaveLength(0));
		await expect(canvas.queryAllByText('legacy_ref')).toHaveLength(0);
		await seen(canvas, 'employee_id');
		// Off shows the one that is off, and still not the ones being worked on.
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('ss.filter.status') }),
			t('ss.status.inactive')
		);
		await waitFor(() => expect(canvas.queryAllByText('employee_id')).toHaveLength(0));
		await seen(canvas, 'badge_expiry');
	}}
>
	{#snippet template()}
		<SchemaSetting client={createFakeSchemaSetting()} tenantId={TENANT} access={EDITOR} />
	{/snippet}
</Story>
