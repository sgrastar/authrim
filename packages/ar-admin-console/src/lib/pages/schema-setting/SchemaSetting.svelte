<script lang="ts">
	import { untrack } from 'svelte';
	import { adminAccess } from '$lib/access/admin-access.svelte';
	import type { AdminAccess } from '$lib/access/access';
	import type { SchemaSettingClient } from '$lib/api/schema-setting';
	import type { SettingsClient } from '$lib/api/settings';
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import { schemaLevel } from './access';
	import SchemaDetail from './SchemaDetail.svelte';
	import SchemaList from './SchemaList.svelte';

	/**
	 * The attribute schema page: the list of every attribute, and one attribute opened from it.
	 * Moving between them happens in place; the detail asks before it drops unsaved changes.
	 *
	 * Whether values of the tenant's own attributes are released in tokens depends on the
	 * feature "custom attribute schemas". When it is off they can still be defined and stored,
	 * which is easy to miss, so the page says so above the list.
	 */
	interface Props {
		client: SchemaSettingClient;
		tenantId: string;
		/** Read for the feature switch. Without it no notice is shown. */
		settings?: SettingsClient;
		/** The admin; the signed-in one when not given (stories and tests pass one). */
		access?: AdminAccess;
		/** The attribute shown first (stories and links). */
		initialId?: string | null;
	}

	let { client, tenantId, settings, access, initialId = null }: Props = $props();

	let selected = $state<string | null>(untrack(() => initialId));
	/** Whether the feature that releases custom attribute values is on; unknown until read. */
	let released = $state<boolean | null>(null);

	const level = $derived(schemaLevel(access ?? adminAccess.current));

	$effect(() => {
		const source = settings;
		const tenant = tenantId;
		released = null;
		if (!source) return;
		let current = true;
		void source
			.get({ level: 'tenant', tenantId: tenant }, 'feature-flags')
			.then((result) => {
				if (current) released = result.values['feature.enable_custom_claim_schemas'] === true;
			})
			.catch(() => {
				// Unknown: say nothing rather than something wrong.
			});
		return () => {
			current = false;
		};
	});
</script>

{#snippet notice()}
	{#if released === false}
		<Callout tone="warning" title={t('ss.flagOff.title')}>{t('ss.flagOff.body')}</Callout>
	{/if}
{/snippet}

{#if level === 'none'}
	<Callout tone="warning">{t('ss.noAccess')}</Callout>
{:else if selected}
	{#key `${tenantId}/${selected}`}
		<SchemaDetail
			{client}
			{tenantId}
			id={selected}
			canWrite={level === 'edit'}
			onback={() => (selected = null)}
		/>
	{/key}
{:else}
	{#key tenantId}
		<SchemaList
			{client}
			{tenantId}
			canWrite={level === 'edit'}
			onopen={(id) => (selected = id)}
			{notice}
		/>
	{/key}
{/if}
