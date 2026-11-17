<script lang="ts">
	import { untrack } from 'svelte';
	import type { TenantsAccess } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import type { TenantDomainsClient } from '#lib/api/tenant-domains.js';
	import type {
		Tenant,
		TenantCopyOptions,
		TenantIsolationPolicy,
		TenantProvisioningStatus,
		TenantsClient
	} from '#lib/api/tenants.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DangerZone from '#lib/ui/patterns/DangerZone.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import TenantCopyFields from './TenantCopyFields.svelte';
	import TenantDomainsCard from './TenantDomainsCard.svelte';
	import TenantFields from './TenantFields.svelte';
	import { tenantErrorDetail, tenantErrorKey } from './tenant-errors';
	import {
		canCopy,
		canDelete,
		copyProblem,
		defaultCopyOptions,
		lifecycleTone,
		newTenantProblems,
		suggestTenantId,
		takenIdentifiers,
		type TakenIdentifiers
	} from './tenant-model';

	/**
	 * Platform → Tenants → one tenant: what it is (id, code, state, how its data is stored) and,
	 * while it is being set up, how far that got. "Copy" makes a new tenant from this one with
	 * what the admin picks; deleting is at the end of the page, behind a confirmation.
	 */
	interface Props {
		client: TenantsClient;
		/** The tenant's custom domains. */
		domains: TenantDomainsClient;
		tenantId: string;
		access: TenantsAccess;
		listHref: string;
		/** Opens another tenant (the copy just made). */
		onopen: (tenantId: string) => void;
		/** After the tenant was deleted. */
		ondeleted: () => void;
		/** After a tenant was copied or deleted (the console's tenant switcher reloads its list). */
		onchanged?: () => void;
	}

	let { client, domains, tenantId, access, listHref, onopen, ondeleted, onchanged }: Props =
		$props();

	let tenant = $state<Tenant | null>(null);
	let provisioning = $state<TenantProvisioningStatus | null>(null);
	let phase = $state<'loading' | 'ready' | 'notFound' | 'forbidden' | 'failed'>('loading');
	let refreshing = $state(false);
	/**
	 * From the list: whether the deployment runs several tenants. Null when the list could not be
	 * read; copying and deleting are offered only once it is known that they can work.
	 */
	let multiTenant = $state<boolean | null>(null);
	/** Ids and codes in use, so a copy's id and code are checked before it is sent. */
	let taken = $state<TakenIdentifiers>(takenIdentifiers([]));

	async function loadProvisioning(current: Tenant) {
		provisioning =
			current.lifecycleState === 'provisioning'
				? await client.provisioning(current.id).catch(() => null)
				: null;
	}

	async function load(quiet = false) {
		if (!quiet) phase = 'loading';
		try {
			const [current, list] = await Promise.all([
				client.get(tenantId),
				client.list().catch(() => null)
			]);
			tenant = current;
			multiTenant = list ? !list.singleTenantMode : null;
			taken = takenIdentifiers(list?.tenants ?? []);
			await loadProvisioning(current);
			phase = 'ready';
		} catch (failure) {
			if (quiet) {
				toast.error(t('tn.d.loadFailed'));
				return;
			}
			tenant = null;
			phase =
				failure instanceof ApiError && failure.status === 404
					? 'notFound'
					: failure instanceof ApiError && failure.status === 403
						? 'forbidden'
						: 'failed';
		}
	}

	$effect(() => {
		void tenantId;
		untrack(() => void load());
	});

	async function refresh() {
		refreshing = true;
		try {
			await load(true);
		} finally {
			refreshing = false;
		}
	}

	// ---- copy
	let copying = $state(false);
	let busy = $state(false);
	let name = $state('');
	let id = $state('');
	let code = $state('');
	let description = $state('');
	let isolationPolicy = $state<TenantIsolationPolicy>('tenant_exclusive');
	let advancedOpen = $state(false);
	let copy = $state<TenantCopyOptions>(defaultCopyOptions());
	let error = $state('');
	let nameError = $state('');
	let idError = $state('');
	let codeError = $state('');
	let formKey = $state(0);

	function openCopy() {
		if (!tenant) return;
		name = t('tn.copy.defaultName', { name: tenant.name });
		id = suggestTenantId(`${tenant.id}-copy`);
		code = '';
		description = tenant.description ?? '';
		isolationPolicy = tenant.isolationPolicy;
		advancedOpen = false;
		copy = defaultCopyOptions();
		error = nameError = idError = codeError = '';
		formKey += 1;
		copying = true;
	}

	async function submitCopy() {
		if (!tenant) return;
		error = nameError = idError = codeError = '';
		if (!name.trim()) nameError = t('tn.f.nameRequired');
		const problems = newTenantProblems({ id, code }, taken, tenant.id);
		if (problems.id) idError = t(`tn.f.id.${problems.id}`);
		if (problems.code) {
			codeError = t(problems.code === 'taken' ? 'tn.f.code.taken' : `tn.f.id.${problems.code}`);
			advancedOpen = true;
		}
		const problem = copyProblem(copy);
		if (problem) error = t('tn.copy.separateStepUps');
		if (nameError || idError || codeError || problem) return;
		busy = true;
		try {
			const created = await client.copy(
				tenant.id,
				{ id, name, code, description, isolationPolicy },
				copy
			);
			copying = false;
			toast.success(t('tn.toast.copied', { name: created.name }));
			onchanged?.();
			onopen(created.id);
		} catch (failure) {
			error = [t(tenantErrorKey(failure)), tenantErrorDetail(failure)].filter(Boolean).join(' ');
		} finally {
			busy = false;
		}
	}

	// ---- delete
	async function remove() {
		if (!tenant) return;
		try {
			await client.remove(tenant.id);
			toast.success(t('tn.toast.deleted', { name: tenant.name }));
			onchanged?.();
			ondeleted();
		} catch (failure) {
			toast.error([t(tenantErrorKey(failure)), tenantErrorDetail(failure)].join(' ').trim());
		}
	}

	const busyStates = new Set(['queued', 'running', 'waiting_retry']);
</script>

<Page>
	<PageHeader title={tenant?.name ?? t('nav.pt.list')}>
		{#snippet back()}
			<BackLink href={listHref}>{t('tn.d.back')}</BackLink>
		{/snippet}
		{#snippet actions()}
			{#if tenant && access.copy && multiTenant === true && canCopy(tenant)}
				<Button icon="copy" onclick={openCopy}>{t('tn.copy.action')}</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'notFound'}
		<EmptyState icon="building" title={t('tn.d.notFound')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('tn.list.noAccess')} />
	{:else if phase === 'failed' || !tenant}
		<EmptyState icon="warningCircle" title={t('tn.d.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={() => load()}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		{#if tenant.lifecycleState === 'deleting' || tenant.lifecycleState === 'deleted'}
			<Callout tone="warning">{t(`tn.d.note.${tenant.lifecycleState}`)}</Callout>
		{/if}

		<Card title={t('tn.d.overview')}>
			<DetailList columns={2} ruled>
				<DetailItem label={t('tn.list.col.state')}>
					<Badge tone={lifecycleTone(tenant.lifecycleState)} dot>
						{t(`tn.state.${tenant.lifecycleState}`)}
					</Badge>
					{#if tenant.isDefault}<Badge tone="info">{t('tn.default')}</Badge>{/if}
				</DetailItem>
				<DetailItem label={t('tn.f.id')}><code>{tenant.id}</code></DetailItem>
				<DetailItem label={t('tn.f.code')}><code>{tenant.code}</code></DetailItem>
				<DetailItem label={t('tn.f.isolation')}>
					{t(`tn.isolation.${tenant.isolationPolicy}`)}
				</DetailItem>
				<DetailItem label={t('tn.f.description')}>
					{tenant.description ?? t('tn.d.none')}
				</DetailItem>
				<DetailItem label={t('tn.list.col.created')}>
					{#if tenant.createdAt}<DateTime value={tenant.createdAt} />{:else}—{/if}
				</DetailItem>
				<DetailItem label={t('tn.list.col.updated')}>
					{#if tenant.updatedAt}<DateTime value={tenant.updatedAt} />{:else}—{/if}
				</DetailItem>
			</DetailList>
		</Card>

		{#if tenant.lifecycleState === 'provisioning'}
			<Card title={t('tn.d.provisioning')} description={t('tn.d.provisioningDesc')}>
				{#snippet actions()}
					<Button size="sm" icon="reset" loading={refreshing} onclick={refresh}>
						{t('tn.d.refresh')}
					</Button>
				{/snippet}
				{#if provisioning}
					<DetailList columns={2} ruled>
						<DetailItem label={t('tn.d.provisioningStatus')}>
							<Badge
								tone={provisioning.status === 'blocked'
									? 'danger'
									: busyStates.has(provisioning.status)
										? 'info'
										: 'neutral'}
								dot
							>
								{t(`tn.prov.${provisioning.status}`)}
							</Badge>
						</DetailItem>
						<DetailItem label={t('tn.d.provisioningKind')}>
							{t(`tn.prov.kind.${provisioning.kind}`)}
						</DetailItem>
						<DetailItem label={t('tn.d.provisioningStep')}>
							{#if provisioning.currentStep}<code>{provisioning.currentStep}</code>{:else}—{/if}
						</DetailItem>
						{#if provisioning.lastErrorCode}
							<DetailItem label={t('tn.d.provisioningError')}>
								<code>{provisioning.lastErrorCode}</code>
							</DetailItem>
						{/if}
					</DetailList>
				{:else}
					<p class="muted">{t('tn.d.provisioningUnknown')}</p>
				{/if}
			</Card>
		{/if}

		{#if tenant.lifecycleState !== 'deleting' && tenant.lifecycleState !== 'deleted'}
			<TenantDomainsCard
				client={domains}
				tenantId={tenant.id}
				canEdit={access.manage && tenant.lifecycleState === 'active'}
			/>
		{/if}

		{#if access.manage && multiTenant === true && canDelete(tenant)}
			<DangerZone
				title={t('tn.delete.title')}
				description={t('tn.delete.desc')}
				actionLabel={t('tn.delete.action')}
				confirmTitle={t('tn.delete.confirmTitle', { name: tenant.name })}
				confirmBody={t('tn.delete.confirmBody', { id: tenant.id })}
				onconfirm={remove}
			/>
		{:else if access.manage && tenant.isDefault}
			<p class="muted">{t('tn.delete.defaultNote')}</p>
		{/if}
	{/if}
</Page>

<FormDialog
	open={copying}
	title={t('tn.copy.title', { name: tenant?.name ?? '' })}
	description={t('tn.copy.desc')}
	submitLabel={t('tn.copy.submit')}
	{busy}
	{error}
	onsubmit={submitCopy}
	oncancel={() => (copying = false)}
>
	{#key formKey}
		<TenantFields
			bind:name
			bind:id
			bind:code
			bind:description
			bind:isolationPolicy
			bind:advancedOpen
			{nameError}
			{idError}
			{codeError}
		/>
		<TenantCopyFields bind:options={copy} />
		<Callout tone="info">{t('tn.copy.keysNote')}</Callout>
	{/key}
</FormDialog>

<style>
	code {
		font-family: var(--font-mono);
		font-size: var(--fs-small);
	}

	.muted {
		margin: 0;
		color: var(--text-secondary);
	}
</style>
