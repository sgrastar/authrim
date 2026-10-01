<script lang="ts">
	import { goto } from '$app/navigation';
	import { startRegistration } from '@simplewebauthn/browser';
	import { myPasskeysAPI, passkeyErrorKey, type AdminPasskey } from '$lib/api/my-passkeys';
	import { adminSession } from '$lib/auth/session.svelte';
	import { tenantScope } from '$lib/auth/tenant-scope.svelte';
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import { LOCALE_LABELS, SUPPORTED_LOCALES, type Locale } from '$lib/i18n/locales';
	import { changeLanguage } from '$lib/shell/language';
	import Card from '$lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '$lib/ui/patterns/ConfirmDialog.svelte';
	import DetailItem from '$lib/ui/patterns/DetailItem.svelte';
	import DetailList from '$lib/ui/patterns/DetailList.svelte';
	import EmptyState from '$lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '$lib/ui/patterns/FormDialog.svelte';
	import InlineGroup from '$lib/ui/patterns/InlineGroup.svelte';
	import ItemCard from '$lib/ui/patterns/ItemCard.svelte';
	import ItemGrid from '$lib/ui/patterns/ItemGrid.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import SettingRow from '$lib/ui/patterns/SettingRow.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import IconButton from '$lib/ui/primitives/IconButton.svelte';
	import SegmentedControl from '$lib/ui/primitives/SegmentedControl.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import Toggle from '$lib/ui/primitives/Toggle.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import { isThemeLook } from '$lib/ui/theme/theme-config';
	import { theme } from '$lib/ui/theme/theme.svelte';
	import DateTime from '$lib/ui/time/DateTime.svelte';
	import { timePreference } from '$lib/ui/time/time-preference.svelte';
	import { toast } from '$lib/ui/toast/toast.svelte';

	const session = $derived(adminSession.current);

	let passkeys = $state<AdminPasskey[]>([]);
	let loadState = $state<'loading' | 'ready' | 'failed'>('loading');

	let adding = $state(false);
	let addName = $state('');
	let addError = $state<string>();
	let renaming = $state<AdminPasskey | null>(null);
	let renameValue = $state('');
	let renameError = $state<string>();
	let deleting = $state<AdminPasskey | null>(null);
	let busy = $state(false);

	const onlyOne = $derived(passkeys.length === 1);

	async function load() {
		loadState = 'loading';
		try {
			passkeys = (await myPasskeysAPI.list()).passkeys;
			loadState = 'ready';
		} catch {
			loadState = 'failed';
		}
	}

	$effect(() => {
		load();
	});

	const nameOf = (passkey: AdminPasskey) => passkey.device_name || t('me.passkey.unnamed');

	function openAdd() {
		addName = '';
		addError = undefined;
		adding = true;
	}

	async function addPasskey() {
		busy = true;
		addError = undefined;
		const name = addName.trim() || undefined;
		try {
			const { options, challenge_id } = await myPasskeysAPI.getRegistrationOptions(
				window.location.hostname,
				name
			);
			const credential = await startRegistration({ optionsJSON: options });
			const { passkey } = await myPasskeysAPI.completeRegistration(
				challenge_id,
				credential,
				window.location.origin,
				name
			);
			passkeys = [...passkeys, passkey];
			adding = false;
			toast.success(t('me.passkey.added'));
		} catch (error) {
			addError = t(passkeyErrorKey(error));
		} finally {
			busy = false;
		}
	}

	function openRename(passkey: AdminPasskey) {
		renameValue = passkey.device_name ?? '';
		renameError = undefined;
		renaming = passkey;
	}

	async function renamePasskey() {
		if (!renaming) return;
		busy = true;
		renameError = undefined;
		try {
			const { passkey } = await myPasskeysAPI.updateDeviceName(renaming.id, renameValue.trim());
			passkeys = passkeys.map((item) => (item.id === passkey.id ? passkey : item));
			renaming = null;
			toast.success(t('me.passkey.renamed'));
		} catch (error) {
			renameError = t(passkeyErrorKey(error));
		} finally {
			busy = false;
		}
	}

	async function deletePasskey() {
		if (!deleting) return;
		const target = deleting;
		busy = true;
		try {
			await myPasskeysAPI.delete(target.id);
			passkeys = passkeys.filter((item) => item.id !== target.id);
			toast.success(t('me.passkey.deleted'));
		} catch (error) {
			toast.error(t(passkeyErrorKey(error)));
		} finally {
			busy = false;
			deleting = null;
		}
	}

	async function signOut() {
		await adminSession.signOut();
		await goto('/admin/login', { replaceState: true });
	}
</script>

<svelte:head>
	<title>{t('me.title')} — {t('app.brand')}</title>
</svelte:head>

<Page>
	<PageHeader title={t('me.title')} description={t('me.desc')} />

	<Card title={t('me.profile')}>
		<DetailList>
			<DetailItem label={t('me.name')}>{session?.name || '—'}</DetailItem>
			<DetailItem label={t('me.email')}>{session?.email || '—'}</DetailItem>
			<DetailItem label={t('me.roles')}>
				<InlineGroup>
					{#each session?.roles ?? [] as role (role)}<Badge>{role}</Badge>{:else}—{/each}
				</InlineGroup>
			</DetailItem>
			<DetailItem label={t('me.scope')}>
				{adminSession.isPlatformAdmin
					? t('me.scopePlatform')
					: t('me.scopeTenant', { tenant: tenantScope.current?.name ?? session?.tenant_id ?? '' })}
			</DetailItem>
			{#if session?.last_login_at}
				<DetailItem label={t('me.lastSignIn')}>
					<DateTime value={session.last_login_at} />
				</DetailItem>
			{/if}
			{#if session?.expires_at}
				<DetailItem label={t('me.sessionExpires')}>
					<DateTime value={session.expires_at} />
				</DetailItem>
			{/if}
		</DetailList>
	</Card>

	<Card title={t('me.display')} description={t('me.displayDesc')} flush>
		<SettingRow title={t('theme.mode')} description={t('me.modeDesc')}>
			<SegmentedControl
				label={t('theme.mode')}
				size="sm"
				value={theme.mode}
				options={[
					{ value: 'system', label: t('theme.mode.system'), icon: 'device' },
					{ value: 'light', label: t('theme.mode.light'), icon: 'sun' },
					{ value: 'dark', label: t('theme.mode.dark'), icon: 'moon' }
				]}
				onchange={(value) => theme.setMode(value as 'system' | 'light' | 'dark')}
			/>
		</SettingRow>
		<SettingRow title={t('theme.look')} description={t('me.lookDesc')}>
			<SegmentedControl
				label={t('theme.look')}
				size="sm"
				value={theme.look}
				options={[
					{ value: 'standard', label: t('theme.look.standard') },
					{ value: 'swiss-grid', label: t('theme.look.swissGrid') },
					{ value: 'frosted', label: t('theme.look.frosted') }
				]}
				onchange={(value) => isThemeLook(value) && theme.setLook(value)}
			/>
		</SettingRow>
		<SettingRow title={t('app.language')} description={t('me.languageDesc')}>
			<Select
				label={t('app.language')}
				hideLabel
				inline
				size="sm"
				value={i18n.locale}
				options={SUPPORTED_LOCALES.map((locale) => ({
					value: locale,
					label: LOCALE_LABELS[locale].native
				}))}
				onchange={(value) => changeLanguage(value as Locale)}
			/>
		</SettingRow>
		<SettingRow title={t('time.zone')} description={t('me.zoneDesc')}>
			<SegmentedControl
				label={t('time.zone')}
				size="sm"
				value={timePreference.zone}
				options={[
					{ value: 'local', label: t('time.local') },
					{ value: 'utc', label: t('time.utc') }
				]}
				onchange={(value) => timePreference.setZone(value === 'utc' ? 'utc' : 'local')}
			/>
		</SettingRow>
		<SettingRow
			title={timePreference.zone === 'utc' ? t('time.alsoLocal') : t('time.alsoUtc')}
			description={t('me.secondaryDesc')}
		>
			<Toggle
				label={timePreference.zone === 'utc' ? t('time.alsoLocal') : t('time.alsoUtc')}
				checked={timePreference.showSecondary}
				onchange={(checked) => timePreference.setShowSecondary(checked)}
			/>
		</SettingRow>
		{#snippet footer()}{t('me.storedLocally')}{/snippet}
	</Card>

	<Card title={t('me.passkeys')} description={t('me.passkeysDesc')}>
		{#snippet actions()}
			<Button icon="plus" size="sm" disabled={loadState !== 'ready'} onclick={openAdd}>
				{t('me.passkey.add')}
			</Button>
		{/snippet}
		{#if loadState === 'loading'}
			<LoadingState label={t('common.loading')} />
		{:else if loadState === 'failed'}
			<EmptyState icon="warningCircle" title={t('me.passkey.loadFailed')}>
				{#snippet action()}
					<Button size="sm" onclick={load}>{t('common.retry')}</Button>
				{/snippet}
			</EmptyState>
		{:else if passkeys.length === 0}
			<EmptyState icon="fingerprint" title={t('me.passkey.empty')} />
		{:else}
			<ItemGrid label={t('me.passkeys')}>
				{#each passkeys as passkey (passkey.id)}
					<ItemCard title={nameOf(passkey)} icon="fingerprint">
						{#snippet meta()}
							{#if passkey.provider?.known && passkey.provider.name}
								<Badge>{passkey.provider.name}</Badge>
							{/if}
							{#if onlyOne}<Badge tone="info">{t('me.passkey.only')}</Badge>{/if}
						{/snippet}
						{#snippet actions()}
							<IconButton
								icon="pencil"
								label="{t('me.passkey.rename')}: {nameOf(passkey)}"
								onclick={() => openRename(passkey)}
							/>
							<IconButton
								icon="trash"
								label="{t('me.passkey.delete')}: {nameOf(passkey)}"
								disabled={onlyOne}
								onclick={() => (deleting = passkey)}
							/>
						{/snippet}
						<DetailList size="sm">
							<DetailItem label={t('me.passkey.created')}>
								<DateTime value={passkey.created_at} />
							</DetailItem>
							<DetailItem label={t('me.passkey.lastUsed')}>
								{#if passkey.last_used_at}
									<DateTime value={passkey.last_used_at} />
								{:else}
									{t('me.passkey.never')}
								{/if}
							</DetailItem>
						</DetailList>
					</ItemCard>
				{/each}
			</ItemGrid>
		{/if}
	</Card>

	<Card title={t('me.session')} flush>
		<SettingRow title={t('account.signOut')} description={t('me.signOutDesc')}>
			<Button icon="logout" size="sm" onclick={signOut}>{t('account.signOut')}</Button>
		</SettingRow>
	</Card>
</Page>

<FormDialog
	open={adding}
	title={t('me.passkey.add')}
	description={t('me.passkey.addBody')}
	submitLabel={t('me.passkey.create')}
	{busy}
	error={addError}
	onsubmit={addPasskey}
	oncancel={() => (adding = false)}
>
	<TextField
		label={t('me.passkey.name')}
		hint={t('me.passkey.nameHint')}
		maxlength={100}
		autocomplete="off"
		bind:value={addName}
	/>
</FormDialog>

<FormDialog
	open={renaming !== null}
	title={t('me.passkey.renameTitle')}
	submitLabel={t('me.passkey.save')}
	{busy}
	error={renameError}
	onsubmit={renamePasskey}
	oncancel={() => (renaming = null)}
>
	<TextField
		label={t('me.passkey.name')}
		maxlength={100}
		autocomplete="off"
		required
		bind:value={renameValue}
	/>
</FormDialog>

<ConfirmDialog
	open={deleting !== null}
	title={t('me.passkey.deleteTitle', { name: deleting ? nameOf(deleting) : '' })}
	body={t('me.passkey.deleteBody')}
	confirmLabel={t('me.passkey.delete')}
	tone="danger"
	{busy}
	onconfirm={deletePasskey}
	oncancel={() => (deleting = null)}
/>
