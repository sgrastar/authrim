<script lang="ts">
	import { untrack } from 'svelte';
	import type { IpAllowlistAccess } from '#lib/access/access.js';
	import {
		isLockoutRefusal,
		type IpAllowlist,
		type IpAllowlistClient,
		type IpAllowlistEntry
	} from '#lib/api/admin-ip-allowlist.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { i18n, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CellText from '#lib/ui/patterns/CellText.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import ActionMenu, { type MenuAction } from '#lib/ui/primitives/ActionMenu.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import IpAllowlistCheckDialog from './IpAllowlistCheckDialog.svelte';
	import IpAllowlistEntryDialog from './IpAllowlistEntryDialog.svelte';
	import IpAllowlistStatus from './IpAllowlistStatus.svelte';
	import {
		accessState,
		countText,
		locksOut,
		parseRange,
		serverMatches,
		withChange
	} from './ip-allowlist-model';

	/**
	 * Settings → Administrator IP limit: the addresses and ranges the tenant's administrators may
	 * use to reach the admin console and the Admin API. With no enabled entry every address is let
	 * in; with one, only the addresses in an enabled range are. It does not touch end users.
	 *
	 * The limit is a way to lock oneself out, so a change that would leave the administrator's own
	 * address outside it is held for a confirmation first, and the first entry is typed with the
	 * administrator's address in view.
	 */
	interface Props {
		client: IpAllowlistClient;
		access: IpAllowlistAccess;
	}

	let { client, access }: Props = $props();

	let data = $state<IpAllowlist>({ entries: [], currentIp: null });
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');

	async function load(quiet = false) {
		if (!quiet) phase = 'loading';
		try {
			data = await client.list();
			phase = 'ready';
		} catch (failure) {
			phase = failure instanceof ApiError && failure.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		untrack(() => void load());
	});

	const entries = $derived(data.entries);
	const currentIp = $derived(data.currentIp);

	function failureKey(failure: unknown): MessageKey {
		if (failure instanceof ApiError) {
			if (failure.status === 409) return 'ip.err.duplicate';
			if (failure.status === 400) return 'ip.err.invalid';
			if (failure.status === 403) return 'ip.err.forbidden';
			if (failure.status === 404) return 'ip.err.notFound';
		}
		return 'ip.err.generic';
	}

	// ---- Add and change ----
	let editing = $state<{ entry: IpAllowlistEntry | null } | null>(null);
	let saving = $state(false);
	let saveError = $state('');
	/** The change waiting for the administrator to accept being locked out. */
	let held = $state<{
		title: string;
		body: string;
		confirmLabel: string;
		tone: 'default' | 'danger';
		run: () => Promise<void>;
	} | null>(null);

	const taken = $derived(
		entries.filter((entry) => entry.id !== editing?.entry?.id).map((entry) => entry.ip_range)
	);

	function lockBody(): string {
		const body = currentIp ? t('ip.lock.body', { ip: currentIp }) : t('ip.lock.bodyNoIp');
		return currentIp?.includes(':') ? `${body} ${t('ip.lock.ipv6')}` : body;
	}

	function openEditor(target: IpAllowlistEntry | null) {
		if (busy) return;
		saveError = '';
		editing = { entry: target };
	}

	/**
	 * Holds a change for the administrator to accept being locked out. `run` is the change again
	 * with the override, so the API lets it through.
	 */
	function holdLockout(run: () => Promise<void>) {
		held = {
			title: t('ip.lock.title'),
			body: lockBody(),
			confirmLabel: t('ip.lock.confirm'),
			tone: 'danger',
			run
		};
	}

	async function save(value: { ip_range: string; description: string }) {
		if (busy) return;
		const target = editing?.entry ?? null;
		const after = target
			? withChange(entries, { kind: 'edit', id: target.id, ip_range: value.ip_range })
			: withChange(entries, { kind: 'add', entry: { ip_range: value.ip_range, enabled: true } });
		const attempt = async (allowLockout: boolean) => {
			saving = true;
			saveError = '';
			try {
				if (target) await client.update(target.id, value, { allowLockout });
				else await client.create(value, { allowLockout });
				editing = null;
				toast.success(t(target ? 'ip.toast.saved' : 'ip.toast.added'));
				await load(true);
			} catch (failure) {
				if (isLockoutRefusal(failure)) {
					// The API judged it would lock the administrator out (this page did not).
					holdLockout(() => attempt(true));
				} else if (failure instanceof ApiError && failure.status === 404) {
					// Someone else deleted it: nothing is left to edit. Hold every change until the
					// list is read again, so no one is judged against the old one.
					editing = null;
					toast.error(t('ip.err.notFound'));
					await load(true);
				} else {
					saveError = t(failureKey(failure));
				}
			} finally {
				saving = false;
			}
		};
		if (locksOut(entries, after, currentIp)) holdLockout(() => attempt(true));
		else await attempt(false);
	}

	// ---- Switch on and off, delete ----
	let working = $state(false);
	/** A change, or the reload after one, is still running: nothing else is changed meanwhile. */
	const busy = $derived(saving || working);

	async function act(
		run: (allowLockout: boolean) => Promise<void>,
		done: MessageKey,
		allowLockout = false
	) {
		if (working) return;
		working = true;
		try {
			await run(allowLockout);
			toast.success(t(done));
		} catch (failure) {
			if (isLockoutRefusal(failure)) holdLockout(() => act(run, done, true));
			else toast.error(t(failureKey(failure)));
		} finally {
			await load(true);
			working = false;
		}
	}

	function toggle(entry: IpAllowlistEntry) {
		if (busy) return;
		const enabled = !entry.enabled;
		const lock = locksOut(
			entries,
			withChange(entries, { kind: 'enabled', id: entry.id, enabled }),
			currentIp
		);
		const run = (allowLockout: boolean) =>
			act(
				(allow) => client.setEnabled(entry.id, enabled, { allowLockout: allow }),
				enabled ? 'ip.toast.enabled' : 'ip.toast.disabled',
				allowLockout
			);
		if (lock) holdLockout(() => run(true));
		else void run(false);
	}

	function remove(entry: IpAllowlistEntry) {
		if (busy) return;
		const after = withChange(entries, { kind: 'remove', id: entry.id });
		const lock = locksOut(entries, after, currentIp);
		const lifts = entry.enabled && accessState(after, currentIp) === 'open';
		held = {
			title: t('ip.delete.title', { range: entry.ip_range }),
			body: [lock ? lockBody() : '', t('ip.delete.body'), lifts ? t('ip.delete.last') : '']
				.filter(Boolean)
				.join(' '),
			confirmLabel: lock ? t('ip.lock.confirm') : t('ip.delete.confirm'),
			tone: 'danger',
			run: () =>
				act((allow) => client.remove(entry.id, { allowLockout: allow }), 'ip.toast.deleted', lock)
		};
	}

	async function confirmed() {
		const pending = held;
		if (!pending || busy) return;
		held = null;
		await pending.run();
	}

	// ---- Check ----
	let checking = $state(false);

	// ---- Table ----
	const columns = $derived([
		{ key: 'range', label: t('ip.col.range') },
		{ key: 'size', label: t('ip.col.size'), width: '20%' },
		{ key: 'status', label: t('ip.col.status'), width: '16%' },
		{ key: 'created', label: t('ip.col.created'), width: '16%' },
		{
			key: 'actions',
			label: t('ip.col.actions'),
			width: '8%',
			align: 'end' as const,
			hideLabel: true
		}
	]);

	function sizeText(entry: IpAllowlistEntry): string {
		if (entry.ip_version === 6) return t('ip.size.ipv6');
		const parsed = parseRange(entry.ip_range);
		// An entry the API reads more loosely than this page (a leading zero): no count given.
		if (!parsed.ok) return '';
		return parsed.range.count === 1
			? t('ip.size.single')
			: t('ip.size.range', { count: countText(parsed.range.count, i18n.locale) });
	}

	function includesMe(entry: IpAllowlistEntry): boolean {
		return currentIp !== null && serverMatches(currentIp, entry.ip_range);
	}

	function actionsFor(entry: IpAllowlistEntry): MenuAction[] {
		const list: MenuAction[] = [];
		if (access.write) {
			list.push({ label: t('ip.action.edit'), icon: 'pencil', onselect: () => openEditor(entry) });
			list.push({
				label: entry.enabled ? t('ip.action.disable') : t('ip.action.enable'),
				onselect: () => toggle(entry)
			});
		}
		if (access.remove) {
			list.push({
				label: t('ip.action.delete'),
				icon: 'trash',
				danger: true,
				onselect: () => remove(entry)
			});
		}
		return list;
	}
</script>

<Page>
	<PageHeader title={t('nav.set.teamIpAllowlist')} description={t('ip.page.desc')}>
		{#snippet actions()}
			{#if phase === 'ready'}
				<Button variant="secondary" icon="shield" onclick={() => (checking = true)}>
					{t('ip.check')}
				</Button>
				{#if access.write}
					<Button variant="primary" icon="plus" disabled={busy} onclick={() => openEditor(null)}
						>{t('ip.add')}</Button
					>
				{/if}
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'forbidden'}
		<EmptyState icon="lock" title={t('ip.noAccess')} />
	{:else if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('ip.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={() => load()}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<IpAllowlistStatus {entries} {currentIp} />
		<Card title={t('ip.list.title')} flush>
			<DataTable caption={t('ip.list.title')} {columns} rows={entries} rowKey={(row) => row.id}>
				{#snippet cell(row, column)}
					{#if column.key === 'range'}
						<CellText title={row.ip_range} description={row.description ?? ''} />
						{#if includesMe(row)}
							<Badge tone="info">{t('ip.mine')}</Badge>
						{/if}
					{:else if column.key === 'size'}
						{sizeText(row)}
					{:else if column.key === 'status'}
						<Badge tone={row.enabled ? 'success' : 'neutral'} dot>
							{row.enabled ? t('ip.on') : t('ip.off')}
						</Badge>
					{:else if column.key === 'created'}
						<DateTime value={row.created_at} />
					{:else}
						{@const menu = actionsFor(row)}
						{#if menu.length > 0}
							<ActionMenu
								label={t('ip.col.actionsFor', { range: row.ip_range })}
								actions={menu}
								size="sm"
								disabled={busy}
							/>
						{/if}
					{/if}
				{/snippet}
				{#snippet empty()}
					<EmptyState icon="shield" title={t('ip.empty.title')} description={t('ip.empty.body')} />
				{/snippet}
			</DataTable>
		</Card>
	{/if}
</Page>

<IpAllowlistEntryDialog
	open={editing !== null}
	entry={editing?.entry ?? null}
	{currentIp}
	{taken}
	busy={saving}
	error={saveError}
	onsubmit={(value) => void save(value)}
	oncancel={() => (editing = null)}
/>

<IpAllowlistCheckDialog open={checking} {entries} {currentIp} oncancel={() => (checking = false)} />

<ConfirmDialog
	open={held !== null}
	title={held?.title ?? ''}
	body={held?.body ?? ''}
	confirmLabel={held?.confirmLabel ?? ''}
	tone={held?.tone ?? 'default'}
	onconfirm={() => void confirmed()}
	oncancel={() => (held = null)}
/>
