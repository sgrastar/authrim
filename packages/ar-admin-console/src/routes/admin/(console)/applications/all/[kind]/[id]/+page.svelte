<script lang="ts">
	import { hasPermission, isCapabilityDisabled } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpExternalProviders } from '#lib/api/external-providers.js';
	import UpstreamConnectionPage from '#lib/pages/service-flows/UpstreamConnectionPage.svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { httpClients } from '#lib/api/clients.js';
	import { httpSamlProviders } from '#lib/api/saml-providers.js';
	import { httpIdentityMapping } from '#lib/api/identity-mapping.js';
	import { identifierMaterialsClient } from '#lib/api/identifier-materials.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { emptyAnswers, type Answers } from '#lib/pages/service-flows/connection-model.js';
	import ServiceFlowDetail from '#lib/pages/service-flows/ServiceFlowDetail.svelte';
	import type { ConnectionMappingResources } from '#lib/pages/service-flows/connection-mapping.svelte.js';
	import { provideIdentifierMaterials } from '#lib/ui/patterns/identifier-materials-context.js';
	import Page from '#lib/ui/templates/Page.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';

	provideIdentifierMaterials(identifierMaterialsClient);
	let answers = $state<Answers | null>(null);
	let resources = $state<ConnectionMappingResources | null>(null);
	let failed = $state(false);
	let generation = 0;
	async function load() {
		const turn = ++generation;
		answers = null;
		resources = null;
		failed = false;
		const kind = page.params.kind;
		const id = page.params.id;
		const tenantId = tenantScope.tenantId;
		if (kind === 'op' || kind === 'idp') return;
		try {
			if (!id || !tenantId || (kind !== 'rp' && kind !== 'sp'))
				throw new Error('Invalid connection');
			const next = emptyAnswers();
			next.kind = kind;
			next.direction = 'out';
			let entityId: string | undefined;
			if (kind === 'rp') {
				const client = (await httpClients.list()).find((client) => client.id === id);
				if (!client) throw new Error('Client unavailable');
				next.rp.name = client.name;
				next.rp.redirectUris = client.redirectUris;
			} else {
				const provider = (await httpSamlProviders.listServiceProviders()).find(
					(provider) => provider.id === id
				);
				if (!provider) throw new Error('Service provider unavailable');
				next.sp.entityId = provider.entityId;
				next.rp.name = provider.name;
				next.active = provider.enabled;
				entityId = provider.entityId;
			}
			if (turn !== generation) return;
			answers = next;
			resources = {
				client: httpIdentityMapping(),
				tenantId,
				protocol: kind === 'rp' ? 'oidc' : 'saml',
				connectionId: id,
				connectionName: next.rp.name,
				entityId,
				readBinding: () =>
					kind === 'rp' ? httpClients.mapping(id) : httpSamlProviders.mapping(id),
				bind: (set, key) =>
					kind === 'rp'
						? httpClients.bindMapping(id, set.id, key)
						: httpSamlProviders.bindMapping(id, set, key)
			};
		} catch {
			if (turn === generation) failed = true;
		}
	}
	$effect(() => {
		void load();
	});
</script>

<svelte:head><title>{t('cm.connections')} — {t('app.brand')}</title></svelte:head>
{#if page.params.kind === 'op' || page.params.kind === 'idp'}
	{#key `${tenantScope.tenantId}:${page.params.kind}:${page.params.id}`}
		<UpstreamConnectionPage
			kind={page.params.kind}
			id={page.params.id ?? ''}
			externalProviders={httpExternalProviders}
			samlProviders={httpSamlProviders}
			canRead={hasPermission(
				adminAccess.current,
				page.params.kind === 'op' ? 'admin:external_providers:read' : 'admin:saml_providers:read'
			)}
			canEdit={hasPermission(
				adminAccess.current,
				page.params.kind === 'op' ? 'admin:external_providers:write' : 'admin:saml_providers:update'
			) &&
				(page.params.kind !== 'op' ||
					!isCapabilityDisabled(adminAccess.current, 'external_identity_providers'))}
			onback={() => goto('/admin/applications/all')}
		/>
	{/key}
{:else}
	<Page withFlow>
		{#if failed}<Callout tone="warning"
				>{t('mc.loadFailed')} <Button onclick={load}>{t('common.retry')}</Button></Callout
			>
		{:else if answers && resources}
			<ServiceFlowDetail
				bind:answers
				mappingResources={resources}
				onback={() => goto('/admin/applications/all')}
				focusTitle
			/>
		{:else}<LoadingState label={t('common.loading')} />{/if}
	</Page>
{/if}
