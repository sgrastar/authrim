<script lang="ts">
	import { untrack, tick } from 'svelte';
	import ConnectionMetadataImport from './ConnectionMetadataImport.svelte';
	import type { SamlMetadataClient } from '#lib/api/saml-providers.js';
	import CertificateSummary from './CertificateSummary.svelte';
	import LiveAdvancedFields from './LiveAdvancedFields.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import { advancedPatch, readAdvanced, record, OP_FIELDS, IDP_FIELDS } from './advanced-settings';
	import { SETTINGS_PARTS, SETTINGS_LABELS } from './connection-settings';
	import FlowCanvas from '#lib/ui/flow/FlowCanvas.svelte';
	import FlowEdge from '#lib/ui/flow/FlowEdge.svelte';
	import FlowEndpoint from '#lib/ui/flow/FlowEndpoint.svelte';
	import FlowScope from '#lib/ui/flow/FlowScope.svelte';
	import FlowSequence from '#lib/ui/flow/FlowSequence.svelte';
	import FlowStepGroup from '#lib/ui/flow/FlowStepGroup.svelte';
	import { revealPanel } from '#lib/ui/flow/reveal-panel.js';
	import PanelHeader from '#lib/ui/patterns/PanelHeader.svelte';
	import InboundConnectionMapping from './InboundConnectionMapping.svelte';
	import { httpInboundMapping, type InboundMappingClient } from '#lib/api/inbound-mapping.js';
	import { ApiError } from '#lib/api/api-error.js';
	import SamlActivation from './SamlActivation.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import type { ExternalProvider, ExternalProvidersClient } from '#lib/api/external-providers.js';
	import type {
		SamlIdentityProvider,
		SamlIdentityProvidersClient
	} from '#lib/api/saml-providers.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { provideBusy } from '#lib/ui/busy/busy.js';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import InSteps from './InSteps.svelte';
	import LeaveGuard from './LeaveGuard.svelte';
	import {
		emptyAnswers,
		kindProtocol,
		kindRole,
		FLOW_GROUPS,
		groupLabel,
		labelOf
	} from './connection-model';
	import { idpConfig, opWriteInput } from './connection-creation';

	let {
		kind,
		id,
		externalProviders,
		samlProviders,
		canRead,
		metadata,
		canPreviewMetadata = false,
		canImportMetadata = false,
		canEdit,
		canReadMapping = canRead,
		canEditMapping = canEdit,
		inboundMapping = httpInboundMapping,
		onback
	}: {
		kind: 'op' | 'idp';
		id: string;
		externalProviders: ExternalProvidersClient;
		samlProviders: SamlIdentityProvidersClient;
		canRead: boolean;
		metadata?: SamlMetadataClient;
		canPreviewMetadata?: boolean;
		canImportMetadata?: boolean;
		canEdit: boolean;
		canReadMapping?: boolean;
		canEditMapping?: boolean;
		inboundMapping?: InboundMappingClient;
		onback: () => void;
	} = $props();
	let answers = $state(emptyAnswers(true));
	let advanced = $state<Record<string, unknown>>({});
	let current = $state('');
	const mappingSelected = $derived(current.startsWith('mapping-'));
	let mappingStatus = $state<'loading' | 'configured' | 'unconfigured' | 'failed'>('loading');
	let rightPanel = $state<HTMLElement | null>(null);
	const role = $derived(kindRole(kind));
	const blurb = $derived(t(kind === 'op' ? 'sf.blurb.op' : 'sf.blurb.idp'));
	const mappingGroups = $derived(
		FLOW_GROUPS[kind].filter((group) => canReadMapping && group.id === 'mapping')
	);
	async function selectNode(id: string) {
		current = id;
		await tick();
		revealPanel(rightPanel);
	}
	let mappingDirty = $state(false);
	let mappingPending = $state(false);
	let settingsRevision = $state(0);
	let oidc = $state<ExternalProvider | null>(null);
	let saml = $state<SamlIdentityProvider | null>(null);
	const name = $derived(
		kind === 'op' ? oidc?.name || kindProtocol(kind) : saml?.name || kindProtocol(kind)
	);
	let enabled = $state(false);
	let original = $state('');
	let ready = $state(false);
	let loadFailed = $state(false);
	let metadataDirty = $state(false);
	let metadataPending = $state(false);
	let metadataRevision = $state(0);
	let saving = $state(false);
	let discovering = $state(false);
	let saveFailed = $state('');
	let saved = $state(false);
	let revision = $state(0);
	let generation = 0;
	let activating = $state(false);
	let askingReload = $state(false);
	let conflict = $state(false);
	provideBusy(() => saving || activating || discovering || metadataPending || mappingPending);
	const snapshot = () => JSON.stringify({ answers, enabled, advanced });
	const persistedEnabled = $derived(kind === 'op' ? oidc?.enabled : saml?.enabled);
	const dirty = $derived(ready && snapshot() !== original);
	const valid = $derived.by(() => {
		try {
			if (kind === 'op') {
				if (typeof oidc?.updatedAt !== 'number') return false;
				opWriteInput(answers.op, oidc?.hasSecret);
				if (
					answers.op.issuer !== oidc?.issuer &&
					(!answers.op.discovered || answers.op.discovery?.issuer !== answers.op.issuer.trim())
				)
					return false;
			} else if (
				!saml?.enabled &&
				!answers.idp.entityId &&
				!answers.idp.acsUrl &&
				!answers.idp.certificate
			) {
				if (!answers.idp.name.trim()) return false;
			} else idpConfig(answers.idp);
			return true;
		} catch {
			return false;
		}
	});

	function showOidc(provider: ExternalProvider) {
		oidc = provider;
		advanced = readAdvanced(provider.advanced, OP_FIELDS);
		answers = emptyAnswers(true);
		answers.direction = 'in';
		answers.kind = 'op';
		Object.assign(answers.op, {
			name: provider.name,
			issuer: provider.issuer,
			clientId: provider.clientId,
			clientSecret: '',
			scopes: provider.scopes,
			link: provider.autoLinkEmail ? 'verified-email' : 'manual',
			requireEmailVerified: provider.requireEmailVerified,
			trustEmail: provider.trustEmail,
			jitProvisioning: provider.jitProvisioning
		});
		enabled = provider.enabled;
		revision++;
		original = snapshot();
	}
	function showSaml(provider: SamlIdentityProvider) {
		saml = provider;
		advanced = readAdvanced(provider.config, IDP_FIELDS);
		answers = emptyAnswers(true);
		answers.direction = 'in';
		answers.kind = 'idp';
		Object.assign(answers.idp, {
			name: provider.name,
			importMode: 'manual',
			entityId: provider.entityId,
			acsUrl: provider.ssoUrl,
			certificate: provider.certificate
		});
		enabled = provider.enabled;
		revision++;
		original = snapshot();
	}
	async function load(source = { kind, id, canRead, externalProviders, samlProviders }) {
		const turn = ++generation;
		ready = false;
		loadFailed = false;
		saved = false;
		metadataRevision++;
		try {
			if (!source.canRead) throw new Error('Unavailable');
			if (source.kind === 'op') {
				const provider = await source.externalProviders.get(source.id);
				if (turn !== generation) return;
				showOidc(provider);
			} else {
				const provider = await source.samlProviders.getIdentityProvider(source.id);
				if (turn !== generation) return;
				showSaml(provider);
			}
			ready = true;
		} catch {
			if (turn === generation) loadFailed = true;
		}
	}
	$effect.pre(() => {
		const source = { kind, id, canRead, externalProviders, samlProviders };
		// Clear readiness before a new source renders. Only resource inputs trigger loading.
		untrack(() => {
			void load(source);
		});
	});
	$effect(() => () => {
		generation++;
	});

	function oidcBasicSource(provider: ExternalProvider): Record<string, unknown> {
		return {
			name: provider.name,
			issuer: provider.issuer,
			client_id: provider.clientId,
			scopes: provider.scopes,
			auto_link_email: provider.autoLinkEmail,
			jit_provisioning: provider.jitProvisioning,
			require_email_verified: provider.requireEmailVerified,
			trust_email: provider.trustEmail,
			enabled: provider.enabled,
			authorization_endpoint: provider.advanced?.authorizationEndpoint,
			token_endpoint: provider.advanced?.tokenEndpoint,
			userinfo_endpoint: provider.advanced?.userinfoEndpoint,
			jwks_uri: provider.advanced?.jwksUri
		};
	}
	async function save() {
		if (
			!canEdit ||
			!ready ||
			!valid ||
			saving ||
			activating ||
			discovering ||
			metadataPending ||
			mappingPending
		)
			return;
		saving = true;
		saveFailed = '';
		conflict = false;
		saved = false;
		try {
			if (kind === 'op' && oidc) {
				const loaded = oidc;
				const advancedUpdate = advancedPatch(oidc.advanced, advanced, OP_FIELDS);
				showOidc(
					await externalProviders.update(id, {
						...Object.fromEntries(
							Object.entries({ ...opWriteInput(answers.op, oidc.hasSecret), enabled }).filter(
								([key, value]) =>
									JSON.stringify(value) !== JSON.stringify(oidcBasicSource(loaded)[key])
							)
						),
						expected_updated_at: oidc.updatedAt,
						...(Object.keys(advancedUpdate).length ? { advanced: advancedUpdate } : {})
					})
				);
			} else if (kind === 'idp' && saml) {
				// A partial config update preserves the existing inbound contract and mapping.
				showSaml(
					await samlProviders.updateIdentityProvider(id, {
						name: answers.idp.name.trim(),
						expectedUpdatedAt: saml.updatedAt,
						config: {
							...Object.fromEntries(
								Object.entries(
									!saml.enabled &&
										!answers.idp.entityId &&
										!answers.idp.acsUrl &&
										!answers.idp.certificate
										? {}
										: idpConfig(answers.idp)
								).filter(
									([key, value]) =>
										JSON.stringify(value) !==
										JSON.stringify(
											record({
												entityId: saml?.entityId,
												ssoUrl: saml?.ssoUrl,
												certificate: saml?.certificate
											})[key]
										)
								)
							),
							...advancedPatch(saml.config, advanced, IDP_FIELDS)
						}
					})
				);
			}
			saved = true;
			settingsRevision++;
		} catch (error) {
			// Never echo an API error that could contain a submitted credential.
			conflict = error instanceof ApiError && error.status === 409;
			saveFailed = t(
				error instanceof StepUpCancelledError
					? 'settings.stepUpCancelled'
					: conflict
						? 'sf.live.conflict'
						: 'common.saveFailed'
			);
		} finally {
			saving = false;
		}
	}
</script>

<LeaveGuard
	dirty={dirty ||
		metadataDirty ||
		mappingDirty ||
		saving ||
		activating ||
		discovering ||
		metadataPending ||
		mappingPending}
/>
<Page withFlow>
	<PageHeader title={name} description={kindProtocol(kind)}>
		{#snippet back()}<BackLink onclick={onback}>{t('sf.detail.back')}</BackLink>{/snippet}
		{#snippet badges()}{#if ready}<Badge tone={persistedEnabled ? 'success' : 'neutral'}
					>{t(persistedEnabled ? 'sf.live.enabled' : 'sf.live.disabled')}</Badge
				>{/if}{/snippet}
	</PageHeader>
	{#if loadFailed}
		<Callout tone="warning"
			>{t('mc.loadFailed')} <Button onclick={() => load()}>{t('common.retry')}</Button></Callout
		>
	{:else if !ready}<LoadingState label={t('common.loading')} />
	{:else}
		{#if saveFailed}<Callout tone="danger" live
				>{saveFailed}{#if conflict}<Button
						onclick={() => {
							askingReload = true;
						}}>{t('sf.live.reload')}</Button
					>{/if}</Callout
			>{/if}
		{#if saved}<Callout tone="info" live>{t('sf.live.saved')}</Callout>{/if}
		<div class="detail">
			<div class="detail__flow">
				<FlowCanvas label={name} heading={t('sf.detail.signIn')} detail={role.line}>
					<FlowEndpoint
						kind="authrim"
						title={t('sf.detail.signInPage')}
						detail={t('sf.detail.peopleChoose', { name })}
					/>
					<FlowEdge length={24} tip={false} />
					<FlowScope label={t('sf.detail.authrimDoes')}>
						<FlowSequence
							order={mappingGroups.map((group) => group.id)}
							visible={mappingGroups.map((group) => group.id)}
							lead={36}
							trail={6}
							menuTitle={name}
							option={(id) => ({ id, label: t('sf.group.mapping') })}
							onadd={selectNode}
						>
							{#snippet step(id, { exiting })}
								{@const group = mappingGroups.find((candidate) => candidate.id === id)}
								{#if group}
									{@const state = mappingStatus === 'configured' ? 'done' : 'todo'}
									<FlowStepGroup
										name={groupLabel(group)}
										{state}
										{current}
										{exiting}
										onselect={selectNode}
										items={group.parts.map((part) => ({
											id: part,
											label: labelOf(part),
											state,
											status: t(
												mappingStatus === 'loading'
													? 'common.loading'
													: mappingStatus === 'failed'
														? 'mc.loadFailed'
														: mappingStatus === 'configured'
															? 'sf.status.done'
															: 'sf.status.todo'
											)
										}))}
									/>
								{/if}
							{/snippet}
						</FlowSequence>
					</FlowScope>
					<FlowEdge length={14} />
					<FlowEndpoint
						title={name}
						detail={blurb}
						actionLabel={t('af.general')}
						onselect={() => selectNode('')}
					/>
				</FlowCanvas>
			</div>
			<div class="detail__side" bind:this={rightPanel}>
				<div class="detail__general" hidden={mappingSelected}>
					{#if kind === 'op' && typeof oidc?.updatedAt !== 'number'}<Callout tone="warning"
							>{t('cs.live.versionMissing')}</Callout
						>{/if}
					<Card title={t('sf.live.settings')}>
						<fieldset
							class="provider-fields"
							disabled={!canEdit ||
								saving ||
								activating ||
								discovering ||
								metadataPending ||
								mappingPending}
						>
							<legend class="sr-only">{t('sf.live.settings')}</legend>
							{#key revision}
								<InSteps
									step={kind === 'op' ? 'op-details' : 'idp-import'}
									live
									editing
									bind:op={answers.op}
									bind:idp={answers.idp}
									hasSecret={oidc?.hasSecret ?? false}
									bind:discovering
									discoverOidc={(issuer, signal) => externalProviders.discover(issuer, signal)}
								/>
							{/key}
							{#if kind === 'idp' && !saml?.entityId}<Callout tone="info"
									>{t('sf.draft.noMetadata')}</Callout
								>{/if}
							{#each SETTINGS_PARTS[kind] as part (part)}
								<Disclosure title={t(SETTINGS_LABELS[part])}>
									{#if part === 'idp-certs'}<CertificateSummary
											summary={saml?.certificateValidation}
										/>
									{:else if part === 'idp-metadata' && !saml?.hasMetadataUrl}<Callout tone="info"
											>{t('cs.live.metadataSource')}</Callout
										>
									{:else}<div class="provider-fields">
											<LiveAdvancedFields
												fields={(kind === 'op' ? OP_FIELDS : IDP_FIELDS).filter(
													(field) => field.part === part
												)}
												bind:values={advanced}
												readonly={!canEdit}
											/>
										</div>{/if}
									{#if part === 'op-request'}<Callout tone="info"
											>{t('cs.live.protocolGap')}</Callout
										>{/if}
								</Disclosure>
							{/each}
							{#if kind === 'op'}<ToggleRow
									label={t('sf.live.enabled')}
									bind:checked={enabled}
								/>{/if}
						</fieldset>
						{#if canEdit}<Button
								onclick={save}
								loading={saving}
								disabled={!dirty ||
									!valid ||
									saving ||
									activating ||
									discovering ||
									metadataPending ||
									mappingPending}>{t('common.save')}</Button
							><Button
								variant="secondary"
								disabled={!dirty ||
									saving ||
									activating ||
									discovering ||
									metadataPending ||
									mappingPending}
								onclick={() => {
									if (kind === 'op' && oidc) showOidc(oidc);
									else if (saml) showSaml(saml);
									saveFailed = '';
									conflict = false;
								}}>{t('common.discard')}</Button
							>{/if}
					</Card>
					{#if kind === 'idp' && saml && metadata}
						{#key metadataRevision}
							<ConnectionMetadataImport
								client={metadata}
								{id}
								kind="saml_idp"
								updatedAt={saml.updatedAt}
								metadataUrl={saml.metadataUrl}
								canPreview={canPreviewMetadata}
								canImport={canImportMetadata}
								busy={saving || activating || discovering || mappingPending}
								settingsDirty={dirty}
								bind:dirty={metadataDirty}
								bind:pending={metadataPending}
								onimported={(result) => {
									if (saml) showSaml({ ...saml, ...result, ssoUrl: result.address });
									settingsRevision++;
								}}
							/>
						{/key}
					{/if}
					{#if kind === 'idp' && saml}
						<SamlActivation
							showStatus={false}
							provider={saml}
							{canEdit}
							dirty={dirty || metadataDirty || mappingDirty}
							busy={saving || discovering || metadataPending || mappingPending}
							bind:pending={activating}
							update={(input) => samlProviders.setEnabled(id, input)}
							onupdated={(status) => {
								if (saml) saml = { ...saml, ...status };
								settingsRevision++;
								// The action preserves the current settings draft, including invalid inputs.
							}}
							onreload={() => {
								if (dirty || metadataDirty || mappingDirty) askingReload = true;
								else void load();
							}}
						/>
					{/if}
				</div>
				{#if canReadMapping}<div class="detail__general" hidden={!mappingSelected}>
						<PanelHeader title={t('sf.group.mapping')}>
							{#snippet back()}<BackLink onclick={() => selectNode('')}>{t('af.general')}</BackLink
								>{/snippet}
						</PanelHeader>
						<InboundConnectionMapping
							client={inboundMapping}
							{kind}
							{id}
							readonly={!canEditMapping}
							disabled={saving || activating || discovering || metadataPending}
							bind:dirty={mappingDirty}
							bind:pending={mappingPending}
							bind:bindingStatus={mappingStatus}
							{settingsRevision}
							onsaved={(document) => {
								if (oidc)
									oidc = {
										...oidc,
										updatedAt: Date.parse(document.providerUpdatedAt),
										enabled: document.enabled
									};
								if (saml)
									saml = {
										...saml,
										updatedAt: document.providerUpdatedAt,
										hasMapping: document.configured,
										enabled: document.enabled
									};
							}}
						/>
					</div>{/if}
			</div>
		</div>
	{/if}
</Page>
<ConfirmDialog
	open={askingReload}
	title={t('sf.live.reloadTitle')}
	body={t('sf.live.reloadBody')}
	confirmLabel={t('sf.live.reload')}
	onconfirm={() => {
		askingReload = false;
		void load();
	}}
	oncancel={() => (askingReload = false)}
/>

<style>
	.detail__side > [hidden] {
		display: none;
	}
	.detail {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--space-columns);
		align-items: start;
	}
	.detail__side,
	.detail__general {
		display: flex;
		flex-direction: column;
		gap: var(--space-columns);
		min-width: 0;
	}
	@media (max-width: 900px) {
		.detail {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.provider-fields {
		display: grid;
		gap: var(--space-field);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
</style>
