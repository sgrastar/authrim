<script lang="ts">
	import LeaveGuard from './LeaveGuard.svelte';
	import ConnectionMetadataImport from './ConnectionMetadataImport.svelte';
	import { untrack } from 'svelte';
	import CertificateSummary from './CertificateSummary.svelte';
	import LiveAdvancedFields from './LiveAdvancedFields.svelte';
	import ClientRuntimeSettings from './ClientRuntimeSettings.svelte';
	import { advancedPatch, RP_FIELDS, SP_FIELDS } from './advanced-settings';
	import { SETTINGS_PARTS, SETTINGS_LABELS } from './connection-settings';
	import { publicKeyProblem } from './public-client-keys';
	import { ApiError } from '#lib/api/api-error.js';
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import type { ClientDetail } from '#lib/api/clients.js';
	import type {
		SamlServiceProvider,
		SamlProviderStatus,
		ServiceProviderBasicUpdate
	} from '#lib/api/saml-providers.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { Draft } from '#lib/ui/save/draft.svelte.js';
	import SaveScope from '#lib/ui/save/SaveScope.svelte';
	import { SaveStopped } from '#lib/ui/save/save-scope.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import RpSteps from './RpSteps.svelte';
	import SpSteps from './SpSteps.svelte';
	import SamlActivation from './SamlActivation.svelte';
	import { entityIdProblem, httpsUrlProblem, redirectUriProblem } from './connection-model';
	import {
		basicSettingsAnswers,
		clientBasicUpdate,
		type ConnectionSettingsResources
	} from './connection-basic-settings';

	let {
		resources,
		canEdit,
		mappingDirty = false,
		mappingPending = false,
		dirty = $bindable(false),
		pending = $bindable(false),
		name = $bindable(''),
		entityId = $bindable(''),
		guardNavigation = true
	}: {
		resources: ConnectionSettingsResources;
		canEdit: boolean;
		mappingDirty?: boolean;
		mappingPending?: boolean;
		dirty?: boolean;
		pending?: boolean;
		name?: string;
		entityId?: string;
		guardNavigation?: boolean;
	} = $props();
	const draft = new Draft(untrack(() => basicSettingsAnswers(resources)));
	let client = $state<ClientDetail | null>(null);
	let sp = $state<SamlServiceProvider | null>(null);
	let status = $state<SamlProviderStatus | null>(null);
	let metadataDirty = $state(false);
	let metadataPending = $state(false);
	let saving = $state(false);
	let activating = $state(false);
	let reloading = $state(false);
	let askingReload = $state(false);
	let failure = $state('');
	let conflict = $state(false);
	let saved = $state(false);
	let metadataRevision = $state(0);

	function accept(next: ConnectionSettingsResources) {
		if (next.kind === 'rp') client = next.detail;
		else {
			sp = next.detail;
			status = next.detail;
			entityId = next.detail.entityId;
		}
		draft.reset(basicSettingsAnswers(next));
		name = next.detail.name;
	}
	$effect(() => {
		const next = resources;
		// A successful mapping bind may advance the provider version. It must not replace edits
		// or silently rebase their settings source version. Activation uses the newly saved version.
		untrack(() => {
			if (next.kind === 'sp') status = next.detail;
			if (!draft.dirty) accept(next);
		});
	});
	$effect(() => {
		dirty = draft.dirty || metadataDirty || runtimeDirty;
		pending = saving || activating || reloading || metadataPending || runtimePending;
	});
	let runtimeDirty = $state(false);
	let runtimePending = $state(false);
	const versionAvailable = $derived(
		resources.kind !== 'rp' || typeof client?.updatedAt === 'number'
	);
	const valid = $derived(
		draft.value.rp.name.trim() !== '' &&
			(resources.kind === 'rp'
				? draft.value.rp.redirectUris.length > 0 &&
					draft.value.rp.redirectUris.every((uri) => !redirectUriProblem(uri)) &&
					(client?.authMethod !== 'none' || draft.value.rp.pkce) &&
					(draft.value.rp.authMethod !== 'private_key_jwt' || !publicKeyProblem(draft.value.rp))
				: !entityIdProblem(draft.value.sp.entityId) && !httpsUrlProblem(draft.value.sp.acsUrl))
	);

	async function save(value: ReturnType<typeof basicSettingsAnswers>) {
		if (
			!canEdit ||
			!versionAvailable ||
			!valid ||
			activating ||
			reloading ||
			mappingPending ||
			metadataPending ||
			runtimePending
		)
			throw new SaveStopped();
		failure = '';
		conflict = false;
		saved = false;
		try {
			if (resources.kind === 'rp' && client) {
				const detail = await resources.client.updateBasics(client.id, {
					...clientBasicUpdate(client, value),
					...(Object.keys(advancedPatch(client.advanced, value.advanced, RP_FIELDS)).length
						? { advanced: advancedPatch(client.advanced, value.advanced, RP_FIELDS) }
						: {})
				});
				accept({ ...resources, detail });
			} else if (resources.kind === 'sp' && sp) {
				const config: NonNullable<ServiceProviderBasicUpdate['config']> = advancedPatch(
					sp.config,
					value.advanced,
					SP_FIELDS
				);
				if (value.sp.entityId.trim() !== sp.entityId) config.entityId = value.sp.entityId.trim();
				if (value.sp.acsUrl.trim() !== sp.acsUrl) config.acsUrl = value.sp.acsUrl.trim();
				const detail = await resources.client.updateServiceProvider(sp.id, {
					expectedUpdatedAt: sp.updatedAt,
					...(value.rp.name.trim() !== sp.name ? { name: value.rp.name.trim() } : {}),
					...(Object.keys(config).length ? { config } : {})
				});
				accept({ ...resources, detail });
			}
			saved = true;
		} catch (error) {
			conflict = error instanceof ApiError && error.status === 409;
			failure = t(
				error instanceof StepUpCancelledError
					? 'settings.stepUpCancelled'
					: conflict
						? 'sf.live.conflict'
						: 'common.saveFailed'
			);
			throw new SaveStopped();
		}
	}
	function requestReload() {
		if (pending) return;
		if (draft.dirty || metadataDirty) askingReload = true;
		else void reload();
	}
	async function reload() {
		askingReload = false;
		reloading = true;
		try {
			if (resources.kind === 'rp')
				accept({ ...resources, detail: await resources.client.get(resources.detail.id) });
			else
				accept({
					...resources,
					detail: await resources.client.getServiceProvider(resources.detail.id)
				});
			metadataRevision++;
			failure = '';
			conflict = false;
			saved = false;
		} catch {
			failure = t('mc.loadFailed');
		} finally {
			reloading = false;
		}
	}
	function activationUpdated(result: SamlProviderStatus) {
		if (sp && status?.updatedAt === sp.updatedAt) sp = { ...sp, ...result };
		status = result;
	}
</script>

<LeaveGuard dirty={guardNavigation && (metadataDirty || metadataPending)} />
<SaveScope
	{guardNavigation}
	{draft}
	onsave={save}
	bar={false}
	onstate={(state) => {
		saving = state.saving;
	}}
>
	{#snippet children(controls)}
		<Card title={t('af.general')}>
			{#if failure}<Callout tone="warning" live
					>{failure}{#if conflict}<Button onclick={requestReload}>{t('sf.live.reload')}</Button
						>{/if}</Callout
				>{/if}
			{#if !versionAvailable}<Callout tone="warning">{t('cs.live.versionMissing')}</Callout>{/if}
			{#if saved && !draft.dirty}<Callout tone="info" live>{t('sf.live.saved')}</Callout>{/if}
			<fieldset
				class="settings-fields"
				disabled={!canEdit || !versionAvailable || pending || mappingPending}
			>
				<legend class="sr-only">{t('af.general')}</legend>
				{#if !canEdit}
					<DetailList ruled>
						<DetailItem label={t('sf.row.name')}>{name}</DetailItem>
						{#if resources.kind === 'rp'}
							<DetailItem label={t('sf.row.appType')}
								>{client?.applicationType ?? t('sf.live.unset')}</DetailItem
							>
							<DetailItem label={t('sf.part.rp-redirect')}
								>{client?.redirectUris.join(', ')}</DetailItem
							>
							<DetailItem label={t('sf.rp.authLabel')}
								>{client?.authMethod ?? t('sf.live.unset')}</DetailItem
							>
							<DetailItem label={t('sf.rp.requirePkce')}
								>{client?.pkce === null
									? t('sf.live.unset')
									: t(client?.pkce ? 'sf.live.enabled' : 'sf.live.disabled')}</DetailItem
							>
						{:else}
							<DetailItem label={t('sf.row.entityId')}>{sp?.entityId}</DetailItem>
							<DetailItem label={t('sf.ours.acsUrl')}>{sp?.acsUrl}</DetailItem>
						{/if}
					</DetailList>
				{:else if resources.kind === 'rp'}
					<RpSteps step="rp-name" live bind:form={draft.value.rp} />
					<DetailList
						><DetailItem label={t('sf.row.appType')}
							>{client?.applicationType ?? t('sf.live.unset')}</DetailItem
						></DetailList
					>
					<RpSteps step="rp-redirect" live bind:form={draft.value.rp} />
					<Disclosure title={t('sf.part.rp-signin')}>
						<div class="settings-fields">
							<RpSteps
								step="rp-signin"
								live
								editing
								storedAuthMethod={client?.authMethod}
								storedPkce={client?.pkce}
								bind:form={draft.value.rp}
							/>
						</div>
					</Disclosure>
				{:else}
					<SpSteps
						step="sp-import"
						live
						editing
						bind:form={draft.value.sp}
						bind:serviceName={draft.value.rp.name}
					/>
				{/if}
				{#each SETTINGS_PARTS[resources.kind] as part (part)}
					<Disclosure title={t(SETTINGS_LABELS[part])}>
						<div class="settings-fields">
							{#if part === 'sp-signing'}<CertificateSummary
									summary={sp?.certificateValidation}
								/>{/if}
							{#if part === 'sp-metadata' && !sp?.hasMetadataUrl}<Callout tone="info"
									>{t('cs.live.metadataSource')}</Callout
								>{:else}
								<LiveAdvancedFields
									fields={(resources.kind === 'rp' ? RP_FIELDS : SP_FIELDS).filter(
										(field) => field.part === part
									)}
									bind:values={draft.value.advanced}
									readonly={!canEdit}
									publicClient={resources.kind === 'rp' &&
										(client?.authMethod === 'none' ||
											client?.applicationType === 'spa' ||
											client?.applicationType === 'native')}
								/>{/if}
							{#if resources.kind === 'rp' && part === 'rp-security'}<Callout tone="info"
									>{t('cs.live.origins')}</Callout
								>{/if}
						</div>
					</Disclosure>
				{/each}
			</fieldset>
			{#if canEdit}<div>
					<Button
						onclick={controls.save}
						loading={saving}
						disabled={!controls.dirty || !versionAvailable || !valid || pending || mappingPending}
						>{t('common.save')}</Button
					>
					<Button
						variant="secondary"
						onclick={() => {
							controls.discard();
							failure = '';
							conflict = false;
						}}
						disabled={!controls.dirty || pending || mappingPending}>{t('common.discard')}</Button
					>
				</div>{/if}
			{#if resources.kind === 'sp' && resources.metadata && sp}
				{#key metadataRevision}
					<ConnectionMetadataImport
						client={resources.metadata}
						id={sp.id}
						kind="saml_sp"
						updatedAt={sp.updatedAt}
						metadataUrl={sp.metadataUrl}
						canPreview={resources.canPreviewMetadata === true}
						canImport={resources.canImportMetadata === true}
						busy={saving || activating || reloading || mappingPending}
						settingsDirty={draft.dirty}
						{mappingDirty}
						bind:dirty={metadataDirty}
						bind:pending={metadataPending}
						onimported={(result) => {
							if (resources.kind === 'sp' && sp)
								accept({ ...resources, detail: { ...sp, ...result, acsUrl: result.address } });
						}}
					/>
				{/key}
			{/if}
			<div>
				<Button variant="secondary" onclick={requestReload} disabled={pending || mappingPending}
					>{t('sf.live.reload')}</Button
				>
			</div>
		</Card>
	{/snippet}
</SaveScope>
{#if resources.kind === 'rp'}
	<ClientRuntimeSettings
		clientId={resources.detail.id}
		disabled={saving || activating || reloading || mappingPending}
		bind:dirty={runtimeDirty}
		bind:pending={runtimePending}
	/>
{/if}
{#if resources.kind === 'sp' && status}
	<SamlActivation
		provider={status}
		{canEdit}
		dirty={draft.dirty || runtimeDirty || mappingDirty || metadataDirty}
		busy={saving || reloading || mappingPending || metadataPending || runtimePending}
		bind:pending={activating}
		update={(input) =>
			resources.kind === 'sp'
				? resources.client.setEnabled(resources.detail.id, input)
				: Promise.reject(new Error('Invalid provider'))}
		onupdated={activationUpdated}
		onreload={requestReload}
	/>
{/if}
<ConfirmDialog
	open={askingReload}
	title={t('sf.live.reloadTitle')}
	body={t('sf.live.reloadBody')}
	confirmLabel={t('sf.live.reload')}
	onconfirm={reload}
	oncancel={() => (askingReload = false)}
/>

<style>
	.settings-fields {
		display: grid;
		gap: var(--space-field);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
</style>
