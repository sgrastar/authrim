<script lang="ts">
	import { onMount } from 'svelte';
	import type { ClaimExplanation, TestUser } from '#lib/api/identity-mapping.js';
	import type { SAMLExplanation } from '#lib/api/mapping-set.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { label } from '#lib/pages/mapping/labels.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import type { ConnectionMappingResources } from './connection-mapping.svelte.js';

	let {
		resources,
		changed = false,
		revision = '',
		error = $bindable(false)
	}: {
		resources: ConnectionMappingResources;
		changed?: boolean;
		revision?: string;
		error?: boolean;
	} = $props();
	let users = $state<TestUser[]>([]);
	let user = $state('');
	let consent = $state<'all' | 'none'>('all');
	let surface = $state<'id_token' | 'userinfo'>('id_token');
	let failed = $state(false);
	let loading = $state(false);
	let oidc = $state<ClaimExplanation | null>(null);
	let saml = $state<SAMLExplanation | null>(null);
	let resultFor = $state('');
	const current = $derived(`${user}:${consent}:${surface}:${revision}`);
	const stale = $derived(resultFor !== current || changed);
	$effect(() => {
		error = failed || oidc?.outcome.kind === 'stopped' || saml?.after_consent.status === 'failed';
	});

	async function load() {
		failed = false;
		try {
			users = (await resources.client.testUsers(resources.tenantId)).test_users;
		} catch {
			failed = true;
		}
	}
	onMount(() => void load());
	async function run() {
		loading = true;
		failed = false;
		oidc = null;
		saml = null;
		const asked = current;
		try {
			const subject = { kind: 'test_user', id: user } satisfies { kind: 'test_user'; id: string };
			if (resources.protocol === 'oidc')
				oidc = await resources.client.explain(resources.tenantId, {
					client_id: resources.connectionId,
					subject,
					consent,
					surface
				});
			else if (resources.entityId)
				saml = await resources.client.explainSaml(resources.tenantId, {
					sp_entity_id: resources.entityId,
					subject,
					consent
				});
			resultFor = asked;
		} catch {
			failed = true;
		} finally {
			loading = false;
		}
	}
	const rows = $derived(
		oidc
			? oidc.claims.map((claim) => ({
					key: claim.claim,
					before: label('mc.ex.value.', claim.value),
					after:
						claim.released === null
							? t('cm.deferred')
							: t(claim.released ? 'mc.ex.sent' : 'mc.ex.notSent'),
					reason: claim.reason ? label('mc.ex.reason.', claim.reason) : ''
				}))
			: saml
				? [
						...saml.before_consent.items.map((item) => ({
							key: item.key,
							before: item.deferred ? t('cm.deferred') : (item.values?.join(', ') ?? '—'),
							after:
								item.kind === 'nameid'
									? (saml?.after_consent.nameid.value ??
										(saml?.after_consent.nameid.status === 'suppressed'
											? t('map.sample.suppressed')
											: saml?.after_consent.nameid.status === 'failed'
												? t('map.sample.failed')
												: t('cm.deferred')))
									: (saml?.after_consent.attributes
											.find((attribute) => attribute.name === item.key)
											?.values.join(', ') ?? t('mc.ex.notSent')),
							reason: ''
						}))
					]
				: []
	);
</script>

<div class="explain">
	<Select
		label={t('mc.ex.user')}
		placeholder={t('mc.ro.choose')}
		options={users.map((item) => ({ value: item.user_id, label: item.label }))}
		bind:value={user}
		disabled={loading}
	/>
	{#if resources.protocol === 'oidc'}
		<Select
			label={t('mc.ex.surface')}
			options={[
				{ value: 'id_token', label: t('mc.ex.surface.id_token') },
				{ value: 'userinfo', label: t('mc.ex.surface.userinfo') }
			]}
			value={surface}
			onchange={(value) => (surface = value === 'userinfo' ? 'userinfo' : 'id_token')}
			disabled={loading}
		/>
	{/if}
	<Select
		label={t('mc.ex.consentChoice')}
		options={[
			{ value: 'all', label: t('mc.ex.consentChoice.all') },
			{ value: 'none', label: t('mc.ex.consentChoice.none') }
		]}
		value={consent}
		onchange={(value) => (consent = value === 'none' ? 'none' : 'all')}
		disabled={loading}
	/>
	<div>
		<Button
			onclick={run}
			disabled={!user || (resources.protocol === 'saml' && !resources.entityId)}
			{loading}>{t('mc.ex.run')}</Button
		>
	</div>
	{#if failed}<Callout tone="warning" live
			>{t('mc.actionFailed')} <Button size="sm" onclick={load}>{t('common.retry')}</Button></Callout
		>{/if}
	{#if oidc || saml}
		{#if stale}<Callout tone="info">{t('cm.explainSaved')}</Callout>{/if}
		{#if oidc?.outcome.kind === 'stopped'}<Callout tone="warning"
				>{t('mc.ex.stoppedOther', { code: oidc.outcome.code })}</Callout
			>{/if}
		{#if saml?.before_consent.error || saml?.after_consent.status === 'failed'}<Callout
				tone="warning">{t('cm.releaseFailed')}</Callout
			>{/if}
		{#if saml?.after_consent.status === 'awaiting_consent'}<Callout tone="info"
				>{t('cm.awaitingConsent')}</Callout
			>{/if}
		{#if saml && ['deferred', 'suppressed'].includes(saml.after_consent.nameid.status)}<Callout
				tone="info">{t('cm.identifierDeferred')}</Callout
			>{/if}
		<DataTable
			caption={t('mc.ex.claims')}
			columns={[
				{ key: 'key', label: t('mc.ex.col.claim') },
				{ key: 'before', label: t('cm.beforeConsent') },
				{ key: 'after', label: t('cm.afterConsent') },
				{ key: 'reason', label: t('mc.ex.col.result') }
			]}
			{rows}
			rowKey={(row) => row.key}
		>
			{#snippet cell(row, column)}
				{#if column.key === 'key'}{row.key}{:else if column.key === 'before'}{row.before}{:else if column.key === 'after'}{row.after}{:else}{row.reason}{/if}
			{/snippet}
		</DataTable>
	{/if}
</div>

<style>
	.explain {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
	}
</style>
