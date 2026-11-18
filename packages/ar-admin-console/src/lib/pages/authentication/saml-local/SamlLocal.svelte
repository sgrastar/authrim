<script lang="ts">
	import { hasPermission, type AdminAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type { SamlSettings, SamlSettingsClient } from '#lib/api/saml-settings.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DangerZone from '#lib/ui/patterns/DangerZone.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { SAML_ROLES } from './local-signing-model';
	import SamlDrBundleCard from './SamlDrBundleCard.svelte';
	import SamlPublicationCard from './SamlPublicationCard.svelte';
	import SamlRoleCard from './SamlRoleCard.svelte';

	/**
	 * The tenant's own SAML identity, under the SAML settings: what partners register for each
	 * role and the signing certificates behind it, how the entity IDs are published, the
	 * emergency key recreation, and the signing-key DR bundle. Reads the settings once and keeps
	 * the copy every operation returns; a failed operation is said in one callout at the top.
	 *
	 * What an admin may do follows the Admin API's permissions: `admin:saml_providers:read` to
	 * see it, `admin:saml_providers:update` to change it, and the two DR bundle permissions.
	 */
	interface Props {
		client: SamlSettingsClient;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
		/** Whether the publication form holds an unsaved choice, for the page's leave guard. */
		onstate?: (state: { dirty: boolean }) => void;
	}

	let { client, access, onstate }: Props = $props();

	const who = $derived(access ?? adminAccess.current);
	const canRead = $derived(hasPermission(who, 'admin:saml_providers:read'));
	const canEdit = $derived(hasPermission(who, 'admin:saml_providers:update'));
	const canPreview = $derived(hasPermission(who, 'admin:saml_providers:create'));
	const canExport = $derived(hasPermission(who, 'admin:saml_providers:signing:dr_bundle:export'));
	const canImport = $derived(hasPermission(who, 'admin:saml_providers:signing:dr_bundle:import'));

	type Phase = 'loading' | 'ready' | 'forbidden' | 'failed';
	let phase = $state<Phase>('loading');
	let settings = $state<SamlSettings | null>(null);
	let error = $state('');
	let busy = $state(false);

	async function load() {
		phase = 'loading';
		error = '';
		try {
			settings = await client.get();
			phase = 'ready';
		} catch (e) {
			phase = e instanceof ApiError && e.forbidden ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		if (canRead) void load();
		else phase = 'forbidden';
	});

	function changed(next: SamlSettings) {
		settings = next;
		error = '';
		toast.success(t('sl.action.done'));
	}

	async function recreate(role: 'idp' | 'sp') {
		if (busy) return;
		busy = true;
		try {
			settings = await client.localSigning({ role, action: 'recreate_active' });
			error = '';
			toast.success(t('sl.action.done'));
		} catch (e) {
			if (!(e instanceof Error && e.name === 'NotAllowedError'))
				error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	const roleName = (role: 'idp' | 'sp') => t(role === 'idp' ? 'sl.role.idp' : 'sl.role.sp');
</script>

<section class="local" aria-label={t('sl.identity.title')}>
	<div class="local__head">
		<h2 class="local__title">{t('sl.identity.title')}</h2>
		<p class="local__desc">{t('sl.identity.desc')}</p>
	</div>

	{#if error}
		<Callout tone="danger" live>{error}</Callout>
	{/if}

	{#if phase === 'loading'}
		<LoadingState label={t('sl.identity.title')} />
	{:else if phase === 'forbidden'}
		<Callout tone="warning">{t('sl.forbidden')}</Callout>
	{:else if phase === 'failed' || !settings}
		<Callout tone="danger" live>
			{t('sl.load.failed')}
			<Button size="sm" variant="secondary" onclick={load}>{t('common.retry')}</Button>
		</Callout>
	{:else}
		{#if !canEdit}
			<Callout tone="info">{t('sl.readOnly')}</Callout>
		{/if}

		{#each SAML_ROLES as role (role)}
			<SamlRoleCard
				{settings}
				{role}
				{client}
				{canEdit}
				{canPreview}
				{busy}
				onbusy={(value) => (busy = value)}
				onchanged={changed}
				onerror={(message) => (error = message)}
			/>
		{/each}

		<SamlPublicationCard
			{settings}
			{client}
			{canEdit}
			{busy}
			onbusy={(value) => (busy = value)}
			onchanged={(next) => {
				settings = next;
				error = '';
			}}
			onerror={(message) => (error = message)}
			{onstate}
		/>

		{#if canEdit}
			<Card title={t('sl.emergency.title')} description={t('sl.emergency.desc')} tone="warning">
				<div class="danger">
					{#each SAML_ROLES as role (role)}
						<DangerZone
							title={t('sl.action.recreateActive', { role: roleName(role) })}
							description={t('sl.action.recreateActive.confirm.body')}
							actionLabel={t('sl.action.recreateActive', { role: roleName(role) })}
							confirmTitle={t('sl.action.recreateActive.confirm.title', { role: roleName(role) })}
							confirmBody={t('sl.action.recreateActive.confirm.body')}
							disabled={busy}
							onconfirm={() => recreate(role)}
						/>
					{/each}
				</div>
			</Card>
		{/if}

		{#if canExport || canImport}
			<SamlDrBundleCard
				{settings}
				{client}
				{canExport}
				{canImport}
				{busy}
				onbusy={(value) => (busy = value)}
				onchanged={changed}
				onerror={(message) => (error = message)}
			/>
		{/if}
	{/if}
</section>

<style>
	.local {
		display: flex;
		flex-direction: column;
		gap: var(--space-section);
		margin-top: var(--space-section);
	}

	.local__title {
		margin: 0;
		font-size: var(--fs-title-lg);
		font-weight: var(--fw-semibold);
	}

	.local__desc {
		margin: 4px 0 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
	}

	.danger {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
	}
</style>
