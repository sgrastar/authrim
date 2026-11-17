<script lang="ts">
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
	import { emptyAnswers, kindProtocol } from './connection-model';
	import { idpConfig, opWriteInput } from './connection-creation';

	let {
		kind,
		id,
		externalProviders,
		samlProviders,
		canRead,
		canEdit,
		onback
	}: {
		kind: 'op' | 'idp';
		id: string;
		externalProviders: ExternalProvidersClient;
		samlProviders: SamlIdentityProvidersClient;
		canRead: boolean;
		canEdit: boolean;
		onback: () => void;
	} = $props();
	let answers = $state(emptyAnswers());
	let oidc = $state<ExternalProvider | null>(null);
	let saml = $state<SamlIdentityProvider | null>(null);
	let enabled = $state(false);
	let original = $state('');
	let ready = $state(false);
	let loadFailed = $state(false);
	let saving = $state(false);
	let saveFailed = $state('');
	let saved = $state(false);
	let revision = $state(0);
	let generation = 0;
	let activating = $state(false);
	let askingReload = $state(false);
	let conflict = $state(false);
	provideBusy(() => saving || activating);
	const snapshot = () => JSON.stringify({ answers, enabled });
	const persistedEnabled = $derived(kind === 'op' ? oidc?.enabled : saml?.enabled);
	const dirty = $derived(ready && snapshot() !== original);
	const valid = $derived.by(() => {
		try {
			if (kind === 'op') {
				opWriteInput(answers.op, oidc?.hasSecret);
				if (
					answers.op.issuer !== oidc?.issuer &&
					(!answers.op.discovered || answers.op.discovery?.issuer !== answers.op.issuer.trim())
				)
					return false;
			} else idpConfig(answers.idp);
			return true;
		} catch {
			return false;
		}
	});

	function showOidc(provider: ExternalProvider) {
		oidc = provider;
		answers = emptyAnswers();
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
		answers = emptyAnswers();
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
	async function load() {
		const turn = ++generation;
		ready = false;
		loadFailed = false;
		saved = false;
		try {
			if (!canRead) throw new Error('Unavailable');
			if (kind === 'op') {
				const provider = await externalProviders.get(id);
				if (turn !== generation) return;
				showOidc(provider);
			} else {
				const provider = await samlProviders.getIdentityProvider(id);
				if (turn !== generation) return;
				showSaml(provider);
			}
			ready = true;
		} catch {
			if (turn === generation) loadFailed = true;
		}
	}
	$effect(() => {
		void load();
	});
	$effect(() => () => {
		generation++;
	});

	async function save() {
		if (!canEdit || !ready || !valid || saving || activating) return;
		saving = true;
		saveFailed = '';
		conflict = false;
		saved = false;
		try {
			if (kind === 'op' && oidc) {
				showOidc(
					await externalProviders.update(id, {
						...opWriteInput(answers.op, oidc.hasSecret),
						enabled
					})
				);
			} else if (kind === 'idp' && saml) {
				// A partial config update preserves the existing inbound contract and mapping.
				showSaml(
					await samlProviders.updateIdentityProvider(id, {
						name: answers.idp.name.trim(),
						expectedUpdatedAt: saml.updatedAt,
						config: idpConfig(answers.idp)
					})
				);
			}
			saved = true;
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

<LeaveGuard dirty={dirty || saving || activating} />
<Page>
	<PageHeader
		title={kind === 'op' ? oidc?.name || kindProtocol(kind) : saml?.name || kindProtocol(kind)}
		description={kindProtocol(kind)}
	>
		{#snippet back()}<BackLink onclick={onback}>{t('sf.detail.back')}</BackLink>{/snippet}
		{#snippet badges()}{#if ready}<Badge tone={persistedEnabled ? 'success' : 'neutral'}
					>{t(persistedEnabled ? 'sf.live.enabled' : 'sf.live.disabled')}</Badge
				>{/if}{/snippet}
	</PageHeader>
	{#if loadFailed}
		<Callout tone="warning"
			>{t('mc.loadFailed')} <Button onclick={load}>{t('common.retry')}</Button></Callout
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
		<Card title={t('sf.live.settings')}>
			<fieldset class="provider-fields" disabled={!canEdit || saving || activating}>
				<legend class="sr-only">{t('sf.live.settings')}</legend>
				{#key revision}
					<InSteps
						step={kind === 'op' ? 'op-details' : 'idp-import'}
						live
						bind:op={answers.op}
						bind:idp={answers.idp}
						hasSecret={oidc?.hasSecret ?? false}
						discoverOidc={(issuer, signal) => externalProviders.discover(issuer, signal)}
					/>
				{/key}
				{#if kind === 'op'}<ToggleRow label={t('sf.live.enabled')} bind:checked={enabled} />{/if}
			</fieldset>
			{#if canEdit}<Button onclick={save} loading={saving} disabled={!dirty || !valid || saving}
					>{t('common.save')}</Button
				>{/if}
		</Card>
		{#if kind === 'idp' && saml}
			<SamlActivation
				showStatus={false}
				provider={saml}
				{canEdit}
				{dirty}
				busy={saving}
				bind:pending={activating}
				update={(input) => samlProviders.setEnabled(id, input)}
				onupdated={(status) => {
					if (saml) saml = { ...saml, ...status };
					// The action preserves the current settings draft, including invalid inputs.
				}}
				onreload={() => {
					if (dirty) askingReload = true;
					else void load();
				}}
			/>
		{/if}
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
	.provider-fields {
		display: grid;
		gap: var(--space-field);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
</style>
