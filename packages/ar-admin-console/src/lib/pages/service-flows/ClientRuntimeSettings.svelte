<script lang="ts">
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { httpSettings, type SettingsClient } from '#lib/api/settings.js';
	import SettingsPage from '#lib/settings/SettingsPage.svelte';
	import type { SettingsPageDef } from '#lib/settings/placement.js';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { RP_OAUTH_FIELDS, RP_SECURITY_FIELDS } from './advanced-settings';
	let {
		clientId,
		client = httpSettings,
		disabled = false,
		dirty = $bindable(false),
		pending = $bindable(false)
	}: {
		clientId: string;
		client?: SettingsClient;
		disabled?: boolean;
		dirty?: boolean;
		pending?: boolean;
	} = $props();
	const page: SettingsPageDef = {
		id: 'connection-runtime',
		nav: 'applications/all',
		title: 'cs.part.rp-tokens',
		description: 'cs.desc.rp-tokens',
		sections: [
			{
				id: 'tokens',
				title: 'cs.part.rp-tokens',
				settings: RP_OAUTH_FIELDS.map(({ key }) => ({ key, depth: 'primary' }))
			},
			{
				id: 'security',
				title: 'cs.part.rp-security',
				settings: RP_SECURITY_FIELDS.map(({ key }) => ({ key, depth: 'primary' }))
			}
		]
	};
</script>

{#if tenantScope.tenantId}
	<Disclosure title={t('cs.live.runtime')}>
		<fieldset {disabled}>
			<legend class="sr-only">{t('cs.live.runtime')}</legend>
			<SettingsPage
				{page}
				{client}
				target={{ level: 'client', clientId, tenantId: tenantScope.tenantId }}
				framed={false}
				{disabled}
				onstate={(state) => {
					dirty = state.dirty;
					pending = state.saving;
				}}
			/>
		</fieldset>
	</Disclosure>
{/if}

<style>
	fieldset {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
</style>
