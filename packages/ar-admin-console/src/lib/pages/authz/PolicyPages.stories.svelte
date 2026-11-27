<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { authzAccess } from '#lib/access/access.js';
	import { persona } from '#lib/access/personas.js';
	import { createFakeAdminUsers } from '#lib/api/fake/admin-users-fake.js';
	import { createFakeAuthz } from '#lib/api/fake/end-user-authz-fake.js';
	import { createFakePolicies } from '#lib/api/fake/end-user-policies-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import PolicyListPage from './PolicyListPage.svelte';
	import PolicyPage from './PolicyPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Access/Policies',
		component: PolicyListPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Access → Policies (`/admin/access/policies`, `/api/admin/policies`): the tenant’s attribute-based rules, which the Check API evaluates after roles, per-resource permissions and relationships while “Attribute rules (ABAC)” is on in Settings → Authorization (`feature.enable_abac` alone; there is no separate custom-rules switch). Each policy allows or denies some resource types and actions (none: all) when all its conditions hold, highest priority first. The editor builds the conditions from `GET /api/admin/policies/condition-types`, so it follows what the engine can evaluate: parameters are drawn by their declared type, `group_id` / `group_ids` are picked from the tenant’s groups, and a condition the editor cannot draw is edited as JSON. Rules are **additive**: a deny never takes back a permission a role already gives, so to require membership **and** an attribute the permission must not also be given to the group through a role. Below the list, “Try the policies” runs the rules on one question (the user’s groups are found by the server unless given). Reading needs `admin:roles:read`; changing and simulating `admin:roles:write` (and `admin:policy:simulate`).'
				}
			}
		}
	});

	const tenant = authzAccess(persona('tenant').access);
	const readOnly = { ...tenant, rolesWrite: false, policiesSimulate: false };
	const users = createFakeAdminUsers();
	const onopen = fn();
	const oncreated = fn();
	const ondeleted = fn();
	const body = (element: HTMLElement) => within(element.ownerDocument.body);
	const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	/** Types into a picker and picks the option found. */
	async function pickIn(
		canvasElement: HTMLElement,
		label: string,
		text: string,
		option: RegExp,
		clear = false
	) {
		const canvas = within(canvasElement);
		const box = canvas.getByRole('combobox', { name: new RegExp(`^${escape(label)}(?![’\\w])`) });
		await userEvent.click(box);
		if (clear) await userEvent.keyboard('{Backspace}');
		await userEvent.type(box, text);
		// The group found comes first; what was typed is offered after it as an ID.
		const options = await body(canvasElement).findAllByRole('option', { name: option });
		await userEvent.click(options[0]);
	}
</script>

<Story
	name="List"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Japan office reads documents');
		await canvas.findByText('Contractors never delete');
		await expect(canvas.getByRole('link', { name: t('pol.create') })).toBeVisible();
		await expect(canvas.getAllByText(t('pol.additive')).length).toBeGreaterThan(0);
	}}
>
	{#snippet template()}
		<PolicyListPage
			client={createFakePolicies({ delay: 100 })}
			{users}
			groups={createFakeAuthz().groups}
			access={tenant}
			newHref="#new"
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Filter by state"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Contractors never delete');
		await userEvent.selectOptions(canvas.getByLabelText(t('pol.list.col.state')), 'disabled');
		await canvas.findByText('Legacy rule (off)');
		await waitFor(() => expect(canvas.queryByText('Contractors never delete')).toBeNull());
	}}
>
	{#snippet template()}
		<PolicyListPage
			client={createFakePolicies()}
			{users}
			groups={createFakeAuthz().groups}
			access={tenant}
			newHref="#new"
			{onopen}
		/>
	{/snippet}
</Story>

<Story name="Empty list">
	{#snippet template()}
		<PolicyListPage
			client={createFakePolicies({ rules: [] })}
			{users}
			groups={createFakeAuthz().groups}
			access={tenant}
			newHref="#new"
			{onopen}
		/>
	{/snippet}
</Story>

<Story name="List failed">
	{#snippet template()}
		<PolicyListPage
			client={createFakePolicies({ failOn: { list: 500 } })}
			{users}
			groups={createFakeAuthz().groups}
			access={tenant}
			newHref="#new"
			{onopen}
		/>
	{/snippet}
</Story>

<Story name="Read only (no create, no simulation)">
	{#snippet template()}
		<PolicyListPage
			client={createFakePolicies()}
			{users}
			groups={createFakeAuthz().groups}
			access={readOnly}
			newHref="#new"
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Simulate, groups found by the server"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Japan office reads documents');
		await pickIn(canvasElement, t('pol.sim.subject'), 'usr_aiko', /usr_aiko/);
		await userEvent.type(canvas.getByLabelText(new RegExp(t('pol.sim.resourceType'))), 'document');
		await userEvent.type(canvas.getByLabelText(new RegExp(t('pol.sim.action'))), 'read');
		await userEvent.click(canvas.getByRole('button', { name: t('pol.sim.run') }));
		await canvas.findByText(t('pol.sim.allowed'));
		await expect(canvas.getByText('pol_jp')).toBeVisible();
		// The details say the groups were resolved by the server.
		await expect(canvas.getByText('resolved')).toBeVisible();
	}}
>
	{#snippet template()}
		<PolicyListPage
			client={createFakePolicies()}
			{users}
			groups={createFakeAuthz().groups}
			access={tenant}
			newHref="#new"
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Simulate, groups given and denied"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Japan office reads documents');
		await pickIn(canvasElement, t('pol.sim.subject'), 'usr_ben', /usr_ben/);
		await userEvent.click(canvas.getByRole('radio', { name: t('pol.sim.groupsGiven') }));
		await pickIn(canvasElement, t('pol.sim.subjectGroups'), 'Contractors', /Contractors/);
		await userEvent.type(canvas.getByLabelText(new RegExp(t('pol.sim.resourceType'))), 'document');
		await userEvent.type(canvas.getByLabelText(new RegExp(t('pol.sim.action'))), 'delete');
		await userEvent.click(canvas.getByRole('button', { name: t('pol.sim.run') }));
		await canvas.findByText(t('pol.sim.denied'));
		await expect(canvas.getByText('pol_contractors')).toBeVisible();
		await expect(canvas.getByText('given')).toBeVisible();
	}}
>
	{#snippet template()}
		<PolicyListPage
			client={createFakePolicies()}
			{users}
			groups={createFakeAuthz().groups}
			access={tenant}
			newHref="#new"
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Simulate, groups unknown stops the rules"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Japan office reads documents');
		// A user the server cannot read memberships of: nothing is granted from rules that use groups.
		await pickIn(canvasElement, t('pol.sim.subject'), 'usr_zed', /usr_zed/);
		await userEvent.type(canvas.getByLabelText(new RegExp(t('pol.sim.resourceType'))), 'document');
		await userEvent.type(canvas.getByLabelText(new RegExp(t('pol.sim.action'))), 'read');
		await userEvent.click(canvas.getByRole('button', { name: t('pol.sim.run') }));
		await canvas.findByText(t('pol.sim.denied'));
		await expect(canvas.getByText('unknown')).toBeVisible();
		await expect(canvas.getByText(/they are unknown/)).toBeVisible();
	}}
>
	{#snippet template()}
		<PolicyListPage
			client={createFakePolicies()}
			{users}
			groups={createFakeAuthz().groups}
			access={tenant}
			newHref="#new"
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Simulate, no groups at all, owner and attribute"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Gold owners');
		await pickIn(canvasElement, t('pol.sim.subject'), 'usr_aiko', /usr_aiko/);
		// Explicitly no groups: an empty list is sent, not "resolve from the account".
		await userEvent.click(canvas.getByRole('radio', { name: t('pol.sim.groupsGiven') }));
		await userEvent.type(canvas.getByLabelText(new RegExp(t('pol.sim.resourceType'))), 'document');
		await userEvent.type(canvas.getByLabelText(new RegExp(t('pol.sim.action'))), 'read');
		await userEvent.type(
			canvas.getByLabelText(new RegExp(escape(t('pol.sim.ownerId')))),
			'usr_aiko'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('pol.sim.addAttribute') }));
		await userEvent.keyboard('tier{Tab}gold');
		await userEvent.click(canvas.getByRole('button', { name: t('pol.sim.run') }));
		await canvas.findByText(t('pol.sim.allowed'));
		await expect(canvas.getByText('pol_gold')).toBeVisible();
		await expect(canvas.getByText('given')).toBeVisible();
	}}
>
	{#snippet template()}
		<PolicyListPage
			client={createFakePolicies({
				rules: [
					{
						id: 'pol_gold',
						name: 'Gold owners',
						description: null,
						priority: 10,
						effect: 'allow',
						resource_types: ['document'],
						actions: [],
						enabled: true,
						created_at: null,
						updated_at: null,
						conditions: [
							{ type: 'is_resource_owner', params: {} },
							{ type: 'attribute_equals', params: { name: 'tier', value: 'gold' } }
						]
					}
				]
			})}
			{users}
			groups={createFakeAuthz().groups}
			access={tenant}
			newHref="#new"
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Simulate, missing fields"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('pol.sim.run') }));
		await canvas.findByText(t('pol.sim.subjectRequired'));
		await canvas.findByText(t('pol.sim.resourceTypeRequired'));
		await canvas.findByText(t('pol.sim.actionRequired'));
	}}
>
	{#snippet template()}
		<PolicyListPage
			client={createFakePolicies()}
			{users}
			groups={createFakeAuthz().groups}
			access={tenant}
			newHref="#new"
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Create a policy with a group condition"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		const name = await canvas.findByLabelText(new RegExp(t('pol.edit.name')));
		await userEvent.click(canvas.getByRole('button', { name: t('pol.new.submit') }));
		await canvas.findByText(t('pol.edit.nameRequired'));
		await userEvent.type(name, 'Engineers edit documents');
		await userEvent.selectOptions(canvas.getByLabelText(t('pol.edit.addCondition')), 'in_group');
		// A condition left empty is refused before anything is sent.
		await userEvent.click(canvas.getByRole('button', { name: t('pol.new.submit') }));
		await canvas.findByText(t('pol.cond.required'));
		await pickIn(canvasElement, 'Group', 'Engineering', /^Engineering/);
		await userEvent.click(canvas.getByRole('button', { name: t('pol.new.submit') }));
		await waitFor(() => expect(oncreated).toHaveBeenCalled());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<PolicyPage
			client={createFakePolicies()}
			groups={createFakeAuthz().groups}
			ruleId="new"
			access={tenant}
			listHref="#policies"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Edit a policy"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		const name = await canvas.findByLabelText(new RegExp(t('pol.edit.name')));
		await expect(name).toHaveValue('Japan office reads documents');
		// The group condition shows the group by its name.
		await expect(await canvas.findByText('Japan office')).toBeVisible();
		await userEvent.clear(name);
		await userEvent.type(name, 'Japan office reads and comments');
		await userEvent.click(canvas.getByRole('button', { name: t('pol.edit.save') }));
		await body(canvasElement).findByText(t('pol.edit.saved'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<PolicyPage
			client={createFakePolicies()}
			groups={createFakeAuthz().groups}
			ruleId="pol_jp"
			access={tenant}
			listHref="#policies"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Edit, several kinds of parameter"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByDisplayValue('Office hours');
		// Numbers, a list of numbers and text, all from the API’s own description.
		await expect(canvas.getByDisplayValue('Asia/Tokyo')).toBeVisible();
		await expect(canvas.getByDisplayValue('18')).toBeVisible();
	}}
>
	{#snippet template()}
		<PolicyPage
			client={createFakePolicies()}
			groups={createFakeAuthz().groups}
			ruleId="pol_hours"
			access={tenant}
			listHref="#policies"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="A condition the editor cannot draw (JSON)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('pol.edit.conditions'));
		await expect(await canvas.findByText(/"ranges"/)).toBeVisible();
	}}
>
	{#snippet template()}
		<PolicyPage
			client={createFakePolicies({
				withOddCondition: true,
				rules: [
					{
						id: 'pol_ip',
						name: 'Office network',
						description: null,
						priority: 50,
						effect: 'allow',
						resource_types: [],
						actions: [],
						enabled: true,
						created_at: null,
						updated_at: null,
						conditions: [{ type: 'ip_in_ranges', params: { ranges: [{ cidr: '10.0.0.0/8' }] } }]
					}
				]
			})}
			groups={createFakeAuthz().groups}
			ruleId="pol_ip"
			access={tenant}
			listHref="#policies"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Dynamic group in a negative condition is refused"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			await canvas.findByLabelText(new RegExp(t('pol.edit.name'))),
			'Deny Japan office'
		);
		await userEvent.selectOptions(canvas.getByLabelText(t('pol.edit.effect')), 'deny');
		await userEvent.selectOptions(canvas.getByLabelText(t('pol.edit.addCondition')), 'in_group');
		await pickIn(canvasElement, 'Group', 'Japan', /Japan office/);
		await userEvent.click(canvas.getByRole('button', { name: t('pol.new.submit') }));
		await canvas.findByText(t('pol.error.dynamicNegative'));
		await expect(oncreated).not.toHaveBeenCalledWith('pol_new_5');
		// The hint says where dynamic groups can be used.
		await expect(canvas.getByText(t('pol.edit.dynamicHint'))).toBeVisible();
	}}
>
	{#snippet template()}
		<PolicyPage
			client={createFakePolicies()}
			groups={createFakeAuthz().groups}
			ruleId="new"
			access={tenant}
			listHref="#policies"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Save refused"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByLabelText(new RegExp(t('pol.edit.name')));
		await userEvent.clear(name);
		await userEvent.type(name, 'Renamed');
		await userEvent.click(canvas.getByRole('button', { name: t('pol.edit.save') }));
		await canvas.findByText(new RegExp(t('az.error.invalid')));
	}}
>
	{#snippet template()}
		<PolicyPage
			client={createFakePolicies({ failOn: { update: 400 } })}
			groups={createFakeAuthz().groups}
			ruleId="pol_jp"
			access={tenant}
			listHref="#policies"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Delete a policy"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		toast.dismissAll();
		await userEvent.click(await canvas.findByRole('button', { name: t('pol.delete.action') }));
		const dialog = within(await body(canvasElement).findByRole('dialog'));
		await userEvent.click(await dialog.findByRole('button', { name: t('pol.delete.action') }));
		await waitFor(() => expect(ondeleted).toHaveBeenCalled());
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<PolicyPage
			client={createFakePolicies()}
			groups={createFakeAuthz().groups}
			ruleId="pol_legacy"
			access={tenant}
			listHref="#policies"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story
	name="Read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText(t('pol.edit.readOnly'))).toBeVisible();
		await expect(canvas.queryByRole('button', { name: t('pol.edit.save') })).toBeNull();
	}}
>
	{#snippet template()}
		<PolicyPage
			client={createFakePolicies()}
			groups={createFakeAuthz().groups}
			ruleId="pol_jp"
			access={readOnly}
			listHref="#policies"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>

<Story name="Not found">
	{#snippet template()}
		<PolicyPage
			client={createFakePolicies()}
			groups={createFakeAuthz().groups}
			ruleId="missing"
			access={tenant}
			listHref="#policies"
			{oncreated}
			{ondeleted}
		/>
	{/snippet}
</Story>
