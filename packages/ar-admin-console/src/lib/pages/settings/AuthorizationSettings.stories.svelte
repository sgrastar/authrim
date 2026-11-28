<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { persona } from '#lib/access/personas.js';
	import { createFakeAuthz } from '#lib/api/fake/end-user-authz-fake.js';
	import { createFakeSettings } from '#lib/api/fake/settings-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AuthorizationSettings from './AuthorizationSettings.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Settings/Authorization',
		component: AuthorizationSettings,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Settings → Authorization (`/admin/settings/authorization`): the end-user authorization settings (`AUTHORIZATION` placement) — whether checks also use attribute rules (`feature.enable_abac`) and relationships (`feature.enable_rebac`), the audience of a user’s own token for the Check API (`check.audience`), how long a dynamic membership grants before it is checked again (`groups.dynamic_freshness_seconds`) and which RBAC claims ID and access tokens carry (`tokens.rbac_*_claims`, a box per claim, `none` for none). Whether the Check API answers at all (`feature.enable_check_api`) is the platform’s, in its own section shown to platform administrators. `feature.enable_id_level_permissions` only controls whether per-resource permissions are put into access tokens (the Check API always evaluates them). Under the settings, the tenant’s Check API keys (`/api/admin/check-api-keys`, `admin:security:read`): a key is created (its secret shown once, in a panel above the list; also needs the platform’s machine credentials on) and revoked, both with `admin:security:write`; revoking needs no capability.'
				}
			}
		}
	});

	const TENANT = 'acme';
	const tenant = persona('tenant').access;
	const platform = persona('platform').access;
	const writeOnly = { ...tenant, permissions: ['admin:security:write'] };
	const capabilityOff = { ...tenant, disabledCapabilities: ['machine_credentials' as const] };
	const key = (n: number, expires_at: number | null = null) => ({
		id: `chk_${n}`,
		name: `Backend ${n}`,
		client_id: 'docs-backend',
		key_prefix: `chk_live_${n}`,
		allowed_operations: ['check'],
		rate_limit_tier: 'moderate',
		is_active: true,
		expires_at,
		created_at: Date.UTC(2026, 9, 1)
	});
	/** 21 keys (two pages), the first past its end. */
	const manyKeys = () =>
		Array.from({ length: 21 }, (_, index) =>
			key(index + 1, index === 0 ? Date.UTC(2026, 0, 1) : null)
		);
	const settings = (stored: Record<string, unknown> = {}, who = tenant) =>
		createFakeSettings({
			access: () => who,
			latency: 100,
			stored: { [`tenant:${TENANT}`]: stored }
		});
</script>

<Story
	name="Defaults"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(t('set.k.feature.enable_abac'));
		await canvas.findAllByText(t('set.k.feature.enable_id_level_permissions'));
		await canvas.findAllByText(t('set.k.tokens.rbac_access_token_claims'));
		await canvas.findByText('Documents backend');
		// The platform's Check API switch is not a tenant administrator's.
		await expect(canvas.queryByText(t('set.section.checkApiPlatform'))).toBeNull();
	}}
>
	{#snippet template()}
		<AuthorizationSettings
			client={settings()}
			keys={createFakeAuthz().checkApiKeys}
			tenantId={TENANT}
			access={tenant}
		/>
	{/snippet}
</Story>

<Story
	name="Platform administrator"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('set.section.checkApiPlatform'));
	}}
>
	{#snippet template()}
		<AuthorizationSettings
			client={settings({}, platform)}
			keys={createFakeAuthz().checkApiKeys}
			tenantId={TENANT}
			access={platform}
		/>
	{/snippet}
</Story>

<Story
	name="Claims set for this tenant"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(t('set.k.tokens.rbac_id_token_claims'));
		const groups = (await canvas.findAllByRole('checkbox', { name: /groups/ }))[0];
		await expect(groups).not.toBeChecked();
		await userEvent.click(groups);
		await expect(groups).toBeChecked();
	}}
>
	{#snippet template()}
		<AuthorizationSettings
			client={settings({
				'tokens.rbac_id_token_claims': 'roles,permissions',
				'tokens.rbac_access_token_claims': 'none'
			})}
			keys={createFakeAuthz().checkApiKeys}
			tenantId={TENANT}
			access={tenant}
		/>
	{/snippet}
</Story>

<Story
	name="Keys failed to load"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('az.keys.loadFailed'));
	}}
>
	{#snippet template()}
		<AuthorizationSettings
			client={settings()}
			keys={createFakeAuthz({ failOn: { 'keys.list': 500 } }).checkApiKeys}
			tenantId={TENANT}
			access={tenant}
		/>
	{/snippet}
</Story>

<Story
	name="Keys: expired, over two pages"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Backend 1');
		await expect(canvas.getByText(t('az.keys.expired'))).toBeVisible();
		await userEvent.click(canvas.getByRole('button', { name: t('pager.page', { n: '2' }) }));
		await canvas.findByText('Backend 21');
	}}
>
	{#snippet template()}
		<AuthorizationSettings
			client={settings()}
			keys={createFakeAuthz({ keys: manyKeys() }).checkApiKeys}
			tenantId={TENANT}
			access={tenant}
		/>
	{/snippet}
</Story>

<Story
	name="Keys: create, secret shown once"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('az.keys.new.open') }));
		const dialog = within(await canvas.findByRole('dialog'));
		await userEvent.type(
			dialog.getByLabelText(new RegExp(t('az.keys.new.name'))),
			'Reports backend'
		);
		await userEvent.type(dialog.getByLabelText(new RegExp(t('az.keys.new.client'))), 'reports');
		// No operation ticked: the form says so and stays open.
		await userEvent.click(
			dialog.getByRole('checkbox', { name: new RegExp(t('az.keys.op.check')) })
		);
		await userEvent.click(dialog.getByRole('button', { name: t('az.keys.new.submit') }));
		await dialog.findByText(t('az.keys.new.operationsRequired'));
		await userEvent.click(
			dialog.getByRole('checkbox', { name: new RegExp(t('az.keys.op.batch')) })
		);
		await userEvent.click(dialog.getByRole('button', { name: t('az.keys.new.submit') }));
		// The secret is shown once, with the warning, and the key is in the list.
		await canvas.findByText(t('az.keys.secret.warning'));
		await canvas.findByText(t('az.keys.secret.title', { name: 'Reports backend' }));
		await canvas.findByText('Reports backend');
		await userEvent.click(canvas.getByRole('button', { name: t('az.keys.secret.done') }));
		await expect(canvas.queryByText(t('az.keys.secret.warning'))).toBeNull();
	}}
>
	{#snippet template()}
		<AuthorizationSettings
			client={settings()}
			keys={createFakeAuthz().checkApiKeys}
			tenantId={TENANT}
			access={tenant}
		/>
	{/snippet}
</Story>

<Story
	name="Keys: create refused"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('az.keys.new.open') }));
		const dialog = within(await canvas.findByRole('dialog'));
		await userEvent.type(
			dialog.getByLabelText(new RegExp(t('az.keys.new.name'))),
			'Reports backend'
		);
		await userEvent.type(dialog.getByLabelText(new RegExp(t('az.keys.new.client'))), 'reports');
		await userEvent.click(dialog.getByRole('button', { name: t('az.keys.new.submit') }));
		// The dialog stays open with the refusal; no secret is shown.
		await dialog.findByRole('alert');
		await expect(canvas.queryByText(t('az.keys.secret.warning'))).toBeNull();
	}}
>
	{#snippet template()}
		<AuthorizationSettings
			client={settings()}
			keys={createFakeAuthz({ failOn: { 'keys.create': 500 } }).checkApiKeys}
			tenantId={TENANT}
			access={tenant}
		/>
	{/snippet}
</Story>

<Story
	name="Keys: machine credentials off"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('az.keys.new.capabilityOff'));
		await expect(canvas.getByRole('button', { name: t('az.keys.new.open') })).toBeDisabled();
		await canvas.findByText('Documents backend');
		// Revoking stays possible: the API exempts it from the capability.
		await expect(
			canvas.getByRole('button', {
				name: t('az.keys.col.actions', { name: 'Documents backend' })
			})
		).toBeVisible();
	}}
>
	{#snippet template()}
		<AuthorizationSettings
			client={settings({}, capabilityOff)}
			keys={createFakeAuthz().checkApiKeys}
			tenantId={TENANT}
			access={capabilityOff}
		/>
	{/snippet}
</Story>

<Story
	name="Keys: create refused, machine credentials off"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('az.keys.new.open') }));
		const dialog = within(await canvas.findByRole('dialog'));
		await userEvent.type(
			dialog.getByLabelText(new RegExp(t('az.keys.new.name'))),
			'Reports backend'
		);
		await userEvent.type(dialog.getByLabelText(new RegExp(t('az.keys.new.client'))), 'reports');
		await userEvent.click(dialog.getByRole('button', { name: t('az.keys.new.submit') }));
		await dialog.findByText(t('az.keys.new.capabilityOff'));
	}}
>
	{#snippet template()}
		<AuthorizationSettings
			client={settings()}
			keys={createFakeAuthz({ failOn: { 'keys.create': 'capability_disabled' } }).checkApiKeys}
			tenantId={TENANT}
			access={tenant}
		/>
	{/snippet}
</Story>

<Story
	name="Keys: write without read (create only)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: t('az.keys.new.open') });
		await canvas.findByText(t('az.keys.listDenied'));
		await expect(canvas.queryByText('Documents backend')).toBeNull();
	}}
>
	{#snippet template()}
		<AuthorizationSettings
			client={settings({}, writeOnly)}
			keys={createFakeAuthz().checkApiKeys}
			tenantId={TENANT}
			access={writeOnly}
		/>
	{/snippet}
</Story>

<Story
	name="Keys: secret discarded after copy"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('az.keys.new.open') }));
		const dialog = within(await canvas.findByRole('dialog'));
		await userEvent.type(dialog.getByLabelText(new RegExp(t('az.keys.new.name'))), 'Copy me');
		await userEvent.type(dialog.getByLabelText(new RegExp(t('az.keys.new.client'))), 'reports');
		await userEvent.click(dialog.getByRole('button', { name: t('az.keys.new.submit') }));
		await canvas.findByText(t('az.keys.secret.warning'));
		// A second creation waits until this secret is closed.
		await expect(canvas.getByRole('button', { name: t('az.keys.new.open') })).toBeDisabled();
		// The browser's clipboard may refuse in a test run; the write itself is what is stood in for.
		const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: async () => {} },
			configurable: true
		});
		try {
			await userEvent.click(canvas.getByRole('button', { name: t('copy.copy') }));
			await canvas.findByText(t('az.keys.secret.copied'));
			await expect(canvas.queryByText(t('az.keys.secret.warning'))).toBeNull();
			await userEvent.click(canvas.getByRole('button', { name: t('az.keys.secret.done') }));
			await expect(canvas.getByRole('button', { name: t('az.keys.new.open') })).toBeEnabled();
		} finally {
			// The stand-in is for this story only.
			if (original) Object.defineProperty(navigator, 'clipboard', original);
			else delete (navigator as { clipboard?: unknown }).clipboard;
		}
	}}
>
	{#snippet template()}
		<AuthorizationSettings
			client={settings()}
			keys={createFakeAuthz().checkApiKeys}
			tenantId={TENANT}
			access={tenant}
		/>
	{/snippet}
</Story>
