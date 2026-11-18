<script lang="ts">
	import { hasPermission, isCapabilityDisabled } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpExternalProviders } from '#lib/api/external-providers.js';
	import UpstreamConnectionPage from '#lib/pages/service-flows/UpstreamConnectionPage.svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { httpClients } from '#lib/api/clients.js';
	import { httpSamlProviders, httpSamlMetadata } from '#lib/api/saml-providers.js';
	import { httpIdentityMapping } from '#lib/api/identity-mapping.js';
	import { identifierMaterialsClient } from '#lib/api/identifier-materials.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import {
		basicSettingsAnswers,
		type ConnectionSettingsResources
	} from '#lib/pages/service-flows/connection-basic-settings.js';
	import { type Answers } from '#lib/pages/service-flows/connection-model.js';
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
	let settings = $state<ConnectionSettingsResources | null>(null);
	let generation = 0;
	async function load() {
		const turn = ++generation;
		answers = null;
		resources = null;
		settings = null;
		failed = false;
		const kind = page.params.kind;
		const id = page.params.id;
		const tenantId = tenantScope.tenantId;
		if (kind === 'op' || kind === 'idp') return;
		try {
			if (!id || !tenantId || (kind !== 'rp' && kind !== 'sp'))
				throw new Error('Invalid connection');
			if (
				!hasPermission(
					adminAccess.current,
					kind === 'rp' ? 'admin:clients:read' : 'admin:saml_providers:read'
				)
			)
				throw new Error('Unavailable');
			const loaded: ConnectionSettingsResources =
				kind === 'rp'
					? { kind, detail: await httpClients.get(id), client: httpClients }
					: {
							kind,
							detail: await httpSamlProviders.getServiceProvider(id),
							metadata: httpSamlMetadata,
							canPreviewMetadata: hasPermission(adminAccess.current, 'admin:saml_providers:create'),
							canImportMetadata: hasPermission(
								adminAccess.current,
								'admin:saml_providers:metadata:import'
							),
							client: httpSamlProviders
						};
			const next = basicSettingsAnswers(loaded);
			const entityId = loaded.kind === 'sp' ? loaded.detail.entityId : undefined;
			if (turn !== generation) return;
			answers = next;
			settings = loaded;
			resources = {
				client: httpIdentityMapping(),
				tenantId,
				protocol: kind === 'rp' ? 'oidc' : 'saml',
				connectionId: id,
				connectionName: next.rp.name,
				entityId,
				readBinding: () =>
					kind === 'rp' ? httpClients.mapping(id) : httpSamlProviders.mapping(id),
				bind: async (set, key) => {
					if (kind === 'rp') {
						const detail = await httpClients.bindMapping(id, set.id, key);
						if (turn === generation)
							settings = { ...loaded, kind: 'rp', detail, client: httpClients };
					} else {
						await httpSamlProviders.bindMapping(id, set, key);
						// Our own binding can advance updatedAt. Refresh activation without rebasing dirty settings.
						const detail = await httpSamlProviders.getServiceProvider(id);
						if (turn === generation)
							settings = { ...loaded, kind: 'sp', detail, client: httpSamlProviders };
					}
				}
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
			metadata={httpSamlMetadata}
			canPreviewMetadata={hasPermission(adminAccess.current, 'admin:saml_providers:create')}
			canImportMetadata={hasPermission(adminAccess.current, 'admin:saml_providers:metadata:import')}
			canRead={hasPermission(
				adminAccess.current,
				page.params.kind === 'op' ? 'admin:external_providers:read' : 'admin:saml_providers:read'
			)}
			canReadMapping={hasPermission(adminAccess.current, 'admin:settings:read') &&
				hasPermission(
					adminAccess.current,
					page.params.kind === 'op' ? 'admin:external_providers:read' : 'admin:saml_providers:read'
				)}
			canEditMapping={hasPermission(adminAccess.current, 'admin:settings:write') &&
				hasPermission(
					adminAccess.current,
					page.params.kind === 'op'
						? 'admin:external_providers:write'
						: 'admin:saml_providers:update'
				) &&
				(page.params.kind !== 'op' ||
					!isCapabilityDisabled(adminAccess.current, 'external_identity_providers'))}
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
			{#key `${tenantScope.tenantId}:${page.params.kind}:${page.params.id}`}
				<ServiceFlowDetail
					settingsResources={settings ?? undefined}
					canEdit={hasPermission(
						adminAccess.current,
						page.params.kind === 'rp' ? 'admin:clients:write' : 'admin:saml_providers:update'
					)}
					canReadMapping={hasPermission(adminAccess.current, 'admin:settings:read')}
					canEditMapping={hasPermission(adminAccess.current, 'admin:settings:write') &&
						hasPermission(
							adminAccess.current,
							page.params.kind === 'rp' ? 'admin:clients:write' : 'admin:saml_providers:update'
						)}
					bind:answers
					mappingResources={resources}
					onback={() => goto('/admin/applications/all')}
					focusTitle
				/>
			{/key}
		{:else}<LoadingState label={t('common.loading')} />{/if}
	</Page>
{/if}
