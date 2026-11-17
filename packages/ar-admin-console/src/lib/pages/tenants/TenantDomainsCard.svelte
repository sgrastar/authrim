<script lang="ts">
	import { untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import {
		HOSTNAME_MAX,
		hostnameValid,
		normalizeHostname,
		type TenantDomain,
		type TenantDomainStatus,
		type TenantDomainsClient
	} from '#lib/api/tenant-domains.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable, { type Column } from '#lib/ui/patterns/DataTable.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import CopyButton from '#lib/ui/primitives/CopyButton.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { domainErrorText } from './tenant-errors';

	/**
	 * A tenant's custom domains, on the tenant's page: each hostname with its state, which one is
	 * primary (the address tokens carry as `iss`), and for a domain not yet working the records its
	 * owner has to publish. Adding, making primary, checking and removing happen here.
	 */
	interface Props {
		client: TenantDomainsClient;
		tenantId: string;
		/** Domains can be added and changed (platform super admin, an active tenant). */
		canEdit: boolean;
	}

	let { client, tenantId, canEdit }: Props = $props();

	let domains = $state<TenantDomain[]>([]);
	let cloudflareConfigured = $state(false);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let busy = $state(false);

	async function load(quiet = false) {
		if (!quiet) phase = 'loading';
		try {
			const list = await client.list(tenantId);
			domains = list.domains;
			cloudflareConfigured = list.cloudflareConfigured;
			phase = 'ready';
		} catch (failure) {
			if (quiet) {
				toast.error(t('tn.dom.loadFailed'));
				return;
			}
			phase = failure instanceof ApiError && failure.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		void tenantId;
		untrack(() => void load());
	});

	const STATUS_TONE: Record<TenantDomainStatus, 'success' | 'info' | 'warning' | 'danger'> = {
		active: 'success',
		pending: 'info',
		pending_manual: 'warning',
		failed: 'danger'
	};
	const statusKey = (domain: TenantDomain): MessageKey =>
		domain.isActive ? `tn.dom.status.${domain.status}` : 'tn.dom.status.inactive';
	const statusTone = (domain: TenantDomain) =>
		domain.isActive ? STATUS_TONE[domain.status] : 'neutral';
	const hasPrimary = $derived(domains.some((domain) => domain.isPrimary));
	/** Refused by Cloudflare when added: removing and adding again is the way back. */
	const failed = $derived(
		domains.filter((domain) => domain.isActive && domain.status === 'failed')
	);
	/** Domains still waiting for their owner: what to publish, or what to set up by hand. */
	const waiting = $derived(
		domains.filter(
			(domain) => domain.isActive && domain.status !== 'active' && domain.status !== 'failed'
		)
	);

	const columns = $derived<Column[]>([
		{ key: 'hostname', label: t('tn.dom.col.hostname') },
		{ key: 'status', label: t('tn.dom.col.status'), width: '22%' },
		{ key: 'actions', label: t('tn.dom.col.actions'), width: '56px', hideLabel: true }
	]);

	// ---- add
	let adding = $state(false);
	let hostname = $state('');
	let makePrimary = $state(false);
	let addError = $state('');
	let hostnameError = $state('');

	function openAdd() {
		hostname = '';
		makePrimary = !hasPrimary;
		addError = hostnameError = '';
		adding = true;
	}

	async function add() {
		addError = hostnameError = '';
		if (!hostnameValid(hostname)) {
			hostnameError = t('tn.dom.f.hostnameInvalid');
			return;
		}
		if (
			domains.some((domain) => domain.isActive && domain.hostname === normalizeHostname(hostname))
		) {
			hostnameError = t('tn.dom.f.hostnameTaken');
			return;
		}
		if (busy) return;
		busy = true;
		try {
			const { domain, cloudflareError } = await client.add(tenantId, hostname, makePrimary);
			adding = false;
			// The domain is kept even when Cloudflare refused it: say why, once (the list does not).
			if (domain.status === 'failed') {
				toast.error(
					t('tn.dom.toast.addedFailed', {
						hostname: domain.hostname,
						reason: cloudflareError ?? t('tn.dom.unknownReason')
					})
				);
			} else {
				toast.success(t('tn.dom.toast.added', { hostname: domain.hostname }));
			}
			await load(true);
		} catch (failure) {
			addError = domainErrorText(failure);
		} finally {
			busy = false;
		}
	}

	// ---- actions behind a confirmation
	type Pending = { kind: 'primary' | 'manualVerify' | 'remove'; domain: TenantDomain };
	let confirming = $state<Pending | null>(null);

	/** One action at a time; `pending` is the confirmation it came from, closed when it ends. */
	async function run(
		action: () => Promise<unknown>,
		done: MessageKey,
		domain: TenantDomain,
		pending: Pending | null = null
	) {
		if (busy) return;
		busy = true;
		try {
			await action();
			toast.success(t(done, { hostname: domain.hostname }));
			await load(true);
		} catch (failure) {
			toast.error(domainErrorText(failure));
		} finally {
			busy = false;
			if (pending && confirming === pending) confirming = null;
		}
	}

	function confirmPending() {
		const pending = confirming;
		if (!pending) return;
		const { domain } = pending;
		if (pending.kind === 'primary') {
			void run(() => client.makePrimary(domain.id), 'tn.dom.toast.primary', domain, pending);
		} else if (pending.kind === 'manualVerify') {
			void run(() => client.verify(domain.id), 'tn.dom.toast.verified', domain, pending);
		} else {
			void run(() => client.remove(domain.id), 'tn.dom.toast.removed', domain, pending);
		}
	}

	/** Checking a Cloudflare-managed domain only reads its state: no confirmation. */
	function check(domain: TenantDomain) {
		void run(() => client.verify(domain.id), 'tn.dom.toast.checked', domain);
	}

	function actionsOf(domain: TenantDomain): MenuAction[] {
		const actions: MenuAction[] = [];
		if (!domain.isPrimary && domain.isActive && domain.status === 'active') {
			actions.push({
				label: t('tn.dom.makePrimary'),
				icon: 'star',
				onselect: () => (confirming = { kind: 'primary', domain })
			});
		}
		if (domain.managedByCloudflare) {
			actions.push({ label: t('tn.dom.check'), icon: 'reset', onselect: () => check(domain) });
		} else if (domain.status !== 'active') {
			actions.push({
				label: t('tn.dom.markVerified'),
				icon: 'check',
				onselect: () => (confirming = { kind: 'manualVerify', domain })
			});
		}
		actions.push({
			label: t('tn.dom.remove'),
			icon: 'trash',
			danger: true,
			onselect: () => (confirming = { kind: 'remove', domain })
		});
		return actions;
	}

	const confirmText = $derived.by(() => {
		if (!confirming) return null;
		const hostname = confirming.domain.hostname;
		switch (confirming.kind) {
			case 'primary':
				return {
					title: t('tn.dom.primary.title', { hostname }),
					body: t('tn.dom.primary.body', { hostname }),
					label: t('tn.dom.makePrimary'),
					tone: 'default' as const
				};
			case 'manualVerify':
				return {
					title: t('tn.dom.manual.title', { hostname }),
					body: t('tn.dom.manual.body', { hostname }),
					label: t('tn.dom.markVerified'),
					tone: 'default' as const
				};
			default:
				return {
					title: t('tn.dom.remove.title', { hostname }),
					body: t(
						confirming.domain.isPrimary ? 'tn.dom.remove.bodyPrimary' : 'tn.dom.remove.body',
						{
							hostname
						}
					),
					label: t('tn.dom.remove'),
					tone: 'danger' as const
				};
		}
	});

	const recordKind = (kind: 'ownership' | 'certificate') =>
		t(kind === 'ownership' ? 'tn.dom.record.ownership' : 'tn.dom.record.certificate');
	/** A TXT record goes in DNS; an HTTP check is a file served at a URL on the domain. */
	const recordLabels = (type: 'TXT' | 'HTTP') =>
		type === 'TXT'
			? {
					how: t('tn.dom.record.howTxt'),
					name: t('tn.dom.record.name'),
					value: t('tn.dom.record.value')
				}
			: {
					how: t('tn.dom.record.howHttp'),
					name: t('tn.dom.record.url'),
					value: t('tn.dom.record.body')
				};
</script>

{#snippet cell(row: TenantDomain, column: Column)}
	{#if column.key === 'hostname'}
		<span class="host">
			<code>{row.hostname}</code>
			{#if row.isPrimary}<Badge tone="info">{t('tn.dom.primary')}</Badge>{/if}
		</span>
	{:else if column.key === 'status'}
		<Badge tone={statusTone(row)} dot>{t(statusKey(row))}</Badge>
	{:else if canEdit}
		<ActionMenu
			size="sm"
			label={t('tn.dom.actions', { hostname: row.hostname })}
			actions={actionsOf(row)}
			disabled={busy}
		/>
	{/if}
{/snippet}

<Card title={t('tn.dom.title')} description={t('tn.dom.desc')} flush>
	{#snippet actions()}
		{#if canEdit && phase === 'ready'}
			<Button size="sm" icon="plus" disabled={busy} onclick={openAdd}>{t('tn.dom.add')}</Button>
		{/if}
	{/snippet}
	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('tn.dom.noAccess')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('tn.dom.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={() => load()}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<DataTable
			caption={t('tn.dom.title')}
			{columns}
			rows={domains}
			rowKey={(row) => row.id}
			{cell}
			dense
		>
			{#snippet empty()}
				<EmptyState icon="globe" title={t('tn.dom.empty')} description={t('tn.dom.emptyBody')} />
			{/snippet}
		</DataTable>

		{#if waiting.length > 0 || failed.length > 0}
			<div class="waiting">
				{#if failed.length > 0}
					<Callout tone="warning">
						{t('tn.dom.failedNote', {
							hostnames: failed.map((domain) => domain.hostname).join(', ')
						})}
					</Callout>
				{/if}
				{#if !cloudflareConfigured && waiting.some((domain) => !domain.managedByCloudflare)}
					<Callout tone="info">{t('tn.dom.manualNote')}</Callout>
				{/if}
				{#each waiting as domain (domain.id)}
					{#if domain.validationRecords.length > 0}
						<Disclosure
							title={t('tn.dom.records.title', { hostname: domain.hostname })}
							description={t('tn.dom.records.desc')}
							boxed
						>
							<ul class="records">
								{#each domain.validationRecords as entry, index (index)}
									{@const labels = recordLabels(entry.type)}
									<li class="record">
										<span class="record__kind">{recordKind(entry.kind)} · {entry.type}</span>
										<span class="record__how">{labels.how}</span>
										<span class="record__label">{labels.name}</span>
										<span class="record__value">
											<code>{entry.name}</code>
											<CopyButton text={entry.name} label={labels.name} variant="icon" />
										</span>
										<span class="record__label">{labels.value}</span>
										<span class="record__value">
											<code>{entry.value}</code>
											<CopyButton text={entry.value} label={labels.value} variant="icon" />
										</span>
									</li>
								{/each}
							</ul>
						</Disclosure>
					{/if}
				{/each}
			</div>
		{/if}
	{/if}
</Card>

<FormDialog
	open={adding}
	title={t('tn.dom.add.title')}
	description={t(cloudflareConfigured ? 'tn.dom.add.descCloudflare' : 'tn.dom.add.descManual')}
	submitLabel={t('tn.dom.add.submit')}
	{busy}
	error={addError}
	onsubmit={add}
	oncancel={() => (adding = false)}
>
	<TextField
		label={t('tn.dom.f.hostname')}
		required
		maxlength={HOSTNAME_MAX}
		placeholder="login.example.com"
		hint={t('tn.dom.f.hostnameHint')}
		error={hostnameError}
		bind:value={hostname}
	/>
	<Checkbox bind:checked={makePrimary} description={t('tn.dom.f.primaryHint')}>
		{t('tn.dom.f.primary')}
	</Checkbox>
</FormDialog>

<ConfirmDialog
	open={confirming !== null}
	title={confirmText?.title ?? ''}
	body={confirmText?.body ?? ''}
	confirmLabel={confirmText?.label ?? ''}
	tone={confirmText?.tone ?? 'default'}
	{busy}
	onconfirm={confirmPending}
	oncancel={() => (confirming = null)}
/>

<style>
	.host {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5em;
	}

	code {
		font-family: var(--font-mono);
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}

	.waiting {
		display: grid;
		gap: var(--space-related);
		padding: var(--space-related);
	}

	.records {
		display: grid;
		gap: var(--space-related);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.record {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 2px var(--space-related);
		align-items: center;
	}

	.record__kind {
		grid-column: 1 / -1;
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
	}

	.record__how {
		grid-column: 1 / -1;
		font-size: var(--fs-small);
		color: var(--text-secondary);
	}

	.record__label {
		font-size: var(--fs-small);
		color: var(--text-secondary);
	}

	.record__value {
		display: inline-flex;
		align-items: center;
		gap: 0.25em;
		min-width: 0;
	}
</style>
