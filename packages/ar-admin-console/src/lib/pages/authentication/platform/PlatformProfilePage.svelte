<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type {
		PlatformProfile,
		PlatformProfileKind,
		PlatformProfilesClient
	} from '#lib/api/platform-profiles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { provideBusy } from '#lib/ui/busy/busy.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DangerZone from '#lib/ui/patterns/DangerZone.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import SaveBar from '#lib/ui/patterns/SaveBar.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import AuthenticationMethodFields from '../AuthenticationMethodFields.svelte';
	import SessionProfileFields from '../SessionProfileFields.svelte';
	import { PROFILE_METHOD_KEYS, withUnsetMethodsOn } from '../authentication-method-fields';

	/**
	 * One of the platform's profiles: its name and values (the settings that mean the same in
	 * every tenant), whether it is locked, and how many tenants keep a copy. Saving changes what
	 * every tenant without a copy uses; tenants with one are told the platform changed it.
	 */
	interface Props {
		kind: PlatformProfileKind;
		client: PlatformProfilesClient;
		/** The profile id, or `new`. */
		id: string;
		canWrite: boolean;
		listHref: string;
		oncreated: (id: string) => void;
		ondeleted: () => void;
		dirty?: boolean;
	}
	let {
		kind,
		client,
		id,
		canWrite,
		listHref,
		oncreated,
		ondeleted,
		dirty = $bindable(false)
	}: Props = $props();

	const isNew = $derived(id === 'new');
	let phase = $state<'loading' | 'ready' | 'missing' | 'forbidden' | 'failed'>('loading');
	let profile = $state<PlatformProfile | null>(null);
	/** The version the edits on the page were made on (a save on another one is a conflict). */
	let baseVersion = 0;
	let name = $state('');
	let values = $state<Record<string, unknown>>({});
	let saved = $state('');
	let busy = $state(false);
	let nameError = $state('');
	let fieldsInvalid = $state(false);
	let revision = $state(0);
	let gone = false;
	let loads = 0;
	let created: string | null = null;
	onDestroy(() => (gone = true));
	// While a save, a lock or a delete is on its way the form takes no input.
	provideBusy(() => busy);

	/**
	 * A new method profile starts with every method (and guest use) off: an unset one shows as off
	 * but would let the method through.
	 */
	const startValues = (): Record<string, unknown> =>
		kind === 'method' ? Object.fromEntries(PROFILE_METHOD_KEYS.map((key) => [key, false])) : {};

	const snapshot = (theName = name, theValues = values) =>
		JSON.stringify({ name: theName.trim(), values: theValues });
	$effect(() => {
		dirty = phase === 'ready' && snapshot() !== saved;
	});

	const active = $derived(profile === null || profile.state === 'active');
	const editable = $derived(canWrite && active);

	/**
	 * A method profile's values as the page shows them: a method (or guest use) it leaves unset is
	 * allowed at sign-in (only an explicit off narrows), so it shows, and saves, as on.
	 */
	const shownValues = (read: Record<string, unknown>): Record<string, unknown> =>
		kind === 'method' ? withUnsetMethodsOn(read) : structuredClone(read);

	function setProfile(next: PlatformProfile) {
		profile = next;
		baseVersion = next.version;
		name = next.name;
		values = shownValues(next.values);
		saved = snapshot();
		revision++;
		phase = 'ready';
	}

	async function load() {
		const turn = ++loads;
		const target = id;
		nameError = '';
		if (target === 'new') {
			profile = null;
			name = '';
			values = startValues();
			saved = snapshot();
			revision++;
			phase = 'ready';
			return;
		}
		phase = 'loading';
		// Nothing of the profile shown before is acted on while another one loads.
		if (profile?.id !== target) profile = null;
		try {
			const next = await client.get(target);
			if (gone || turn !== loads || target !== id) return;
			setProfile(next);
		} catch (error) {
			if (gone || turn !== loads || target !== id) return;
			phase =
				error instanceof ApiError && error.notFound
					? 'missing'
					: error instanceof ApiError && error.forbidden
						? 'forbidden'
						: 'failed';
		}
	}
	$effect(() => {
		const current = id;
		untrack(() => {
			const justCreated = current === created;
			created = null;
			if (!justCreated) void load();
		});
	});

	function discard() {
		if (busy || !saved) return;
		const original = JSON.parse(saved) as { name: string; values: Record<string, unknown> };
		name = original.name;
		values = structuredClone(original.values);
		nameError = '';
		revision++;
	}

	function changeValue(key: string, value: unknown) {
		const next = { ...values };
		if (value === undefined) delete next[key];
		else next[key] = value;
		values = next;
	}

	async function save() {
		if (busy || !editable || phase !== 'ready' || fieldsInvalid) return;
		const trimmed = name.trim();
		if (!trimmed) {
			nameError = t('pp.page.nameRequired');
			return;
		}
		const target = id;
		const turn = loads;
		const input = { name: trimmed, values: structuredClone($state.snapshot(values)) };
		busy = true;
		try {
			const next =
				target === 'new' || !profile
					? await client.create(input)
					: await client.update(target, baseVersion, input);
			if (gone || turn !== loads || id !== target) return;
			// An update's answer leaves out how many tenants keep a copy: keep the count read.
			setProfile({
				...next,
				overridingTenants: next.overridingTenants ?? profile?.overridingTenants ?? null
			});
			toast.success(t('pp.page.saved'));
			if (target === 'new') {
				created = next.id;
				oncreated(next.id);
			}
		} catch (error) {
			if (gone || turn !== loads || id !== target) return;
			if (error instanceof ApiError && error.code === 'limit_reached') {
				toast.error(t('pp.page.limitReached'));
				return;
			}
			if (error instanceof ApiError && error.status === 409) {
				// A version conflict names the current version; a name conflict does not.
				if (!('current_version' in error.body)) {
					nameError = t('pp.page.nameTaken');
					return;
				}
				toast.error(t('pp.page.conflict'));
				return;
			}
			toast.error(t('pp.page.saveFailed'));
		} finally {
			busy = false;
		}
	}

	async function setLocked(locked: boolean) {
		const current = profile;
		if (busy || !canWrite || !current || phase !== 'ready' || current.id !== id) return;
		const turn = loads;
		busy = true;
		try {
			const next = await client.setLocked(current.id, current.version, locked);
			if (gone || turn !== loads || current.id !== id) return;
			// The lock is its own change: unsaved edits of the values stay as they are. The edits stay
			// on the version they were made on, unless that is the one the lock moved on from.
			if (baseVersion === current.version) baseVersion = next.version;
			profile = { ...next, overridingTenants: next.overridingTenants ?? current.overridingTenants };
			toast.success(t(locked ? 'pp.list.locked' : 'pp.list.unlocked'));
		} catch (error) {
			toast.error(
				error instanceof ApiError && error.status === 409
					? t('pp.page.conflict')
					: t('pp.list.failed')
			);
		} finally {
			busy = false;
		}
	}

	async function remove() {
		const current = profile;
		if (!current || !canWrite) return;
		const target = id;
		const turn = loads;
		const stale = () => gone || turn !== loads || id !== target;
		try {
			await client.remove(current.id);
			if (stale()) return;
			toast.success(t('pp.list.deleteSuccess'));
			ondeleted();
		} catch (error) {
			if (stale()) return;
			const code = error instanceof ApiError ? error.body.error : undefined;
			toast.error(
				code === 'profile_in_use'
					? t('pp.list.inUse')
					: code === 'reference_check_incomplete'
						? t('pp.list.checkIncomplete')
						: t('pp.list.failed')
			);
			// Refused: the profile as it is now (locked, state), keeping the edits made here.
			try {
				const next = await client.get(target);
				if (!stale()) profile = next;
			} catch {
				// Shown as it was; the next load reads it again.
			}
		}
	}

	const title = $derived(name.trim() || (isNew ? t('pp.page.new') : t(`pp.title.${kind}`)));
</script>

<Page>
	<PageHeader {title} description={t(`pp.desc.${kind}`)}>
		{#snippet back()}<BackLink href={listHref}>{t('pp.page.back')}</BackLink>{/snippet}
		{#snippet badges()}
			<Badge tone="info">{t('pl.platform')}</Badge>
			{#if profile?.locked}<Badge>{t('pl.locked')}</Badge>{/if}
		{/snippet}
		{#snippet actions()}
			{#if canWrite && profile && active && phase === 'ready' && profile.id === id}
				<Button icon="lock" disabled={busy} onclick={() => setLocked(!profile?.locked)}
					>{t(profile.locked ? 'pp.list.unlock' : 'pp.list.lock')}</Button
				>
			{/if}
		{/snippet}
	</PageHeader>

	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'ready'}
		{#if profile && !active}
			<Callout tone="warning">{t('pp.page.deletingNote')}</Callout>
		{:else if profile?.locked}
			<Callout>{t('pp.page.lockedNote')}</Callout>
		{/if}
		{#if profile && profile.overridingTenants}
			<Callout>{t('pp.page.overriding', { count: profile.overridingTenants })}</Callout>
		{/if}
		<Card>
			<TextField
				label={t('pp.page.name')}
				hint={t('pp.page.nameHint')}
				bind:value={name}
				maxlength={80}
				required
				readonly={!editable}
				error={nameError}
				oninput={() => (nameError = '')}
			/>
		</Card>
		{#key revision}
			{#if kind === 'method'}
				<AuthenticationMethodFields {values} canWrite={editable} onchange={changeValue} />
			{:else}
				<SessionProfileFields
					{values}
					canWrite={editable}
					onchange={changeValue}
					bind:invalid={fieldsInvalid}
				/>
			{/if}
		{/key}
		{#if canWrite && profile && active}
			<DangerZone
				title={t('pp.list.delete')}
				description={t('pp.list.deleteBody')}
				actionLabel={t('pp.list.delete')}
				confirmTitle={t('pp.list.deleteTitle', { name: profile.name })}
				confirmBody={t('pp.list.deleteBody')}
				onconfirm={remove}
			/>
		{/if}
	{:else}
		<EmptyState
			icon={phase === 'forbidden' ? 'lock' : 'warningCircle'}
			title={t(
				phase === 'missing'
					? 'pp.page.notFound'
					: phase === 'forbidden'
						? 'pp.page.noAccess'
						: 'pp.page.loadFailed'
			)}
		>
			{#snippet action()}{#if phase === 'failed'}<Button size="sm" onclick={load}
						>{t('common.retry')}</Button
					>{/if}{/snippet}
		</EmptyState>
	{/if}
	{#if editable && phase === 'ready'}
		<SaveBar
			{dirty}
			saving={busy}
			invalid={nameError !== '' || fieldsInvalid}
			onsave={save}
			ondiscard={discard}
		/>
	{/if}
</Page>
