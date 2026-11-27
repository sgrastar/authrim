<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { authzAccess } from '#lib/access/access.js';
	import { persona } from '#lib/access/personas.js';
	import { createFakeAdminUsers } from '#lib/api/fake/admin-users-fake.js';
	import { createFakeAuthz } from '#lib/api/fake/end-user-authz-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AccessCheckPage from './AccessCheckPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Access/Access check',
		component: AccessCheckPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Access → Access check (`/admin/access/access-check`, `POST /api/admin/access-check`): whether one user may do something, as the Check API answers a service’s backend (its server contract), with the debug details — allowed or denied, which ways allowed it (`resolved_via`: the user’s own role, a group’s role, a relationship…), the rules matched, the ReBAC path and the time taken. The user is found by email address or user ID; the permission is `resource:action`, optionally about one resource (its ID), as another resource type, or as a resource of one group (a role given for that group’s resources then holds). Nothing is written, and `feature.enable_check_api` does not apply. Needs `admin:roles:read` or `admin:groups:read`.'
				}
			}
		}
	});

	const tenant = authzAccess(persona('tenant').access);
	const users = createFakeAdminUsers();

	/** Removes the picked item of a single picker, then picks the one found for `text`. */
	async function pick(canvasElement: HTMLElement, label: string, text: string, option: RegExp) {
		const canvas = within(canvasElement);
		const box = canvas.getByRole('combobox', {
			name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
		});
		await userEvent.click(box);
		await userEvent.keyboard('{Backspace}');
		await userEvent.type(box, text);
		await userEvent.click(
			await within(canvasElement.ownerDocument.body).findByRole('option', { name: option })
		);
	}

	/** The editor role given to Japan office for that group's resources only. */
	const scoped = () =>
		createFakeAuthz({
			grants: {
				grp_jp: [
					{
						id: 'gra_s',
						role_id: 'role_editor',
						role_name: 'editor',
						role_display_name: null,
						scope_type: 'group',
						scope_target: 'group:grp_jp',
						expires_at: null,
						assigned_by: null,
						created_at: null
					}
				]
			},
			userRoles: {}
		});
</script>

<Story
	name="Asked, and allowed through a group"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			await canvas.findByLabelText(new RegExp(t('acc.form.permission'))),
			'documents:write'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('acc.form.run') }));
		await canvas.findByText(t('acc.result.allowed'));
		await expect(canvas.getByText(t('acc.via.groupRole'))).toBeVisible();
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz()}
		<AccessCheckPage
			client={fake.accessCheck}
			{users}
			groups={fake.groups}
			access={tenant}
			subjectId="usr_aiko"
		/>
	{/snippet}
</Story>

<Story
	name="Denied"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			await canvas.findByLabelText(new RegExp(t('acc.form.permission'))),
			'invoices:approve'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('acc.form.run') }));
		await canvas.findByText(t('acc.result.denied'));
		await expect(canvas.getByText(t('acc.result.traceEmpty'))).toBeVisible();
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz()}
		<AccessCheckPage
			client={fake.accessCheck}
			{users}
			groups={fake.groups}
			access={tenant}
			subjectId="usr_chen"
		/>
	{/snippet}
</Story>

<Story
	name="Nothing entered"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('acc.form.run') }));
		await canvas.findByText(t('acc.form.subjectRequired'));
		await expect(canvas.getByText(t('acc.form.permissionRequired'))).toBeVisible();
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz()}
		<AccessCheckPage client={fake.accessCheck} {users} groups={fake.groups} access={tenant} />
	{/snippet}
</Story>

<Story
	name="Refused"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			await canvas.findByLabelText(new RegExp(t('acc.form.permission'))),
			'documents:read'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('acc.form.run') }));
		await canvas.findByText(t('az.error.generic'));
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz({ failOn: { accessCheck: 500 } })}
		<AccessCheckPage
			client={fake.accessCheck}
			{users}
			groups={fake.groups}
			access={tenant}
			subjectId="usr_aiko"
		/>
	{/snippet}
</Story>

<Story name="No access">
	{#snippet template()}
		{@const fake = createFakeAuthz()}
		<AccessCheckPage
			client={fake.accessCheck}
			{users}
			groups={fake.groups}
			access={authzAccess({ platform: false, roles: [], permissions: [] })}
		/>
	{/snippet}
</Story>

<Story
	name="The answer keeps the user it was asked about"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			await canvas.findByLabelText(new RegExp(t('acc.form.permission'))),
			'documents:write'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('acc.form.run') }));
		const asked = t('acc.result.asked', { subject: 'usr_aiko', permission: 'documents:write' });
		// Another user is chosen while the check runs…
		await pick(canvasElement, t('acc.form.subject'), 'usr_chen', /usr_chen/);
		await canvas.findByText(t('acc.result.allowed'));
		await expect(canvas.getByText(asked)).toBeVisible();
		// …and after it answered: the answer still says whom it was about.
		await pick(canvasElement, t('acc.form.subject'), 'usr_ben', /usr_ben/);
		await expect(canvas.getByText(asked)).toBeVisible();
	}}
>
	{#snippet template()}
		{@const fake = createFakeAuthz({ delay: 600 })}
		<AccessCheckPage
			client={fake.accessCheck}
			{users}
			groups={createFakeAuthz().groups}
			access={tenant}
			subjectId="usr_aiko"
		/>
	{/snippet}
</Story>

<Story
	name="Allowed for one group's resources, denied for another's"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			await canvas.findByLabelText(new RegExp(t('acc.form.permission'))),
			'documents:write'
		);
		await pick(canvasElement, t('acc.form.resourceGroup'), 'Japan', /Japan office/);
		await userEvent.click(canvas.getByRole('button', { name: t('acc.form.run') }));
		await canvas.findByText(t('acc.result.allowed'));
		await pick(canvasElement, t('acc.form.resourceGroup'), 'Engin', /Engineering/);
		await userEvent.click(canvas.getByRole('button', { name: t('acc.form.run') }));
		await waitFor(() => expect(canvas.getByText(t('acc.result.denied'))).toBeVisible());
	}}
>
	{#snippet template()}
		{@const fake = scoped()}
		<AccessCheckPage
			client={fake.accessCheck}
			{users}
			groups={fake.groups}
			access={tenant}
			subjectId="usr_aiko"
		/>
	{/snippet}
</Story>
