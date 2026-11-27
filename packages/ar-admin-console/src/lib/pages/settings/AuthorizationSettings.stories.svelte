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
						'Settings → Authorization (`/admin/settings/authorization`): the end-user authorization settings (`AUTHORIZATION` placement) — whether checks also use attribute rules (`feature.enable_abac`) and relationships (`feature.enable_rebac`), the audience of a user’s own token for the Check API (`check.audience`), how long a dynamic membership grants before it is checked again (`groups.dynamic_freshness_seconds`) and which RBAC claims ID and access tokens carry (`tokens.rbac_*_claims`, a box per claim, `none` for none). Whether the Check API answers at all (`feature.enable_check_api`) is the platform’s, in its own section shown to platform administrators. Under the settings, the tenant’s Check API keys (`/api/admin/check-api-keys`, `admin:security:read`), each revocable with `admin:security:write`.'
				}
			}
		}
	});

	const TENANT = 'acme';
	const tenant = persona('tenant').access;
	const platform = persona('platform').access;
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
