<script lang="ts">
	import { untrack } from 'svelte';
	import type { AdminUser, AdminUsersClient } from '#lib/api/admin-users.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import CopyButton from '#lib/ui/primitives/CopyButton.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import {
		actionErrorKey,
		phoneProblem,
		profileChange,
		profileFormOf,
		type ProfileForm
	} from './user-model';

	/**
	 * The user's profile as facts, and the form that edits the five fields an admin may change
	 * (name, given and family name, username, phone number). The address is not editable here:
	 * changing an identifier is a flow of its own.
	 */
	interface Props {
		client: AdminUsersClient;
		user: AdminUser;
		/** May edit (`admin:users:write`); never once the personal data is deleted. */
		canEdit: boolean;
		/** The profile was saved. */
		onsaved: () => void | Promise<void>;
	}

	let { client, user, canEdit, onsaved }: Props = $props();

	let editing = $state(false);
	let busy = $state(false);
	let form = $state<ProfileForm>(untrack(() => profileFormOf(user)));
	let phoneError = $state('');
	let formError = $state('');

	function open(): void {
		form = profileFormOf(user);
		phoneError = '';
		formError = '';
		editing = true;
	}

	async function save(): Promise<void> {
		const problem = phoneProblem(form.phone_number);
		phoneError = problem ? t(problem) : '';
		formError = '';
		if (problem) return;
		const change = profileChange(user, form);
		if (Object.keys(change).length === 0) {
			editing = false;
			return;
		}
		busy = true;
		try {
			await client.update(user.id, change);
			editing = false;
			toast.success(t('usr.toast.saved'));
			await onsaved();
		} catch (error) {
			formError = t(
				error instanceof ApiError && error.status === 400
					? 'usr.d.edit.error'
					: actionErrorKey(error)
			);
		} finally {
			busy = false;
		}
	}

	const until = $derived(
		user.lifecycle_state === 'suspended'
			? { label: t('usr.d.suspendedUntil'), value: user.suspended_until }
			: user.lifecycle_state === 'locked'
				? { label: t('usr.d.lockedUntil'), value: user.locked_until }
				: null
	);
</script>

<Card title={t('usr.d.basic')}>
	{#snippet actions()}
		{#if canEdit}
			<Button size="sm" icon="pencil" onclick={open}>{t('usr.d.edit')}</Button>
		{/if}
	{/snippet}
	<DetailList ruled>
		<DetailItem label={t('usr.d.email')}>
			{#if user.email}
				<bdi>{user.email}</bdi>
				<span class="muted">
					· {user.email_verified ? t('usr.d.verified') : t('usr.d.unverified')}
				</span>
			{:else}
				—
			{/if}
		</DetailItem>
		<DetailItem label={t('usr.d.id')}>
			<code>{user.id}</code>
			{#snippet end()}
				<CopyButton text={user.id} variant="icon" label={t('usr.d.copyId')} />
			{/snippet}
		</DetailItem>
		<DetailItem label={t('usr.d.name')}>{user.name ?? '—'}</DetailItem>
		{#if user.given_name}
			<DetailItem label={t('usr.d.givenName')}>{user.given_name}</DetailItem>
		{/if}
		{#if user.family_name}
			<DetailItem label={t('usr.d.familyName')}>{user.family_name}</DetailItem>
		{/if}
		{#if user.preferred_username}
			<DetailItem label={t('usr.d.preferredUsername')}>
				<bdi>{user.preferred_username}</bdi>
			</DetailItem>
		{/if}
		{#if user.phone_number}
			<DetailItem label={t('usr.d.phone')}>
				<bdi dir="ltr">{user.phone_number}</bdi>
				<span class="muted">
					· {user.phone_number_verified ? t('usr.d.verified') : t('usr.d.unverified')}
				</span>
			</DetailItem>
		{/if}
		{#if user.created_at}
			<DetailItem label={t('usr.col.created')}><DateTime value={user.created_at} /></DetailItem>
		{/if}
		{#if user.updated_at}
			<DetailItem label={t('usr.d.updated')}><DateTime value={user.updated_at} /></DetailItem>
		{/if}
		<DetailItem label={t('usr.col.lastLogin')}>
			{#if user.last_login_at}
				<DateTime value={user.last_login_at} />
			{:else}
				—
			{/if}
		</DetailItem>
		{#if until?.value}
			<DetailItem label={until.label}><DateTime value={until.value} /></DetailItem>
		{/if}
	</DetailList>
</Card>

<FormDialog
	open={editing}
	title={t('usr.d.edit.title')}
	submitLabel={t('usr.d.edit.save')}
	{busy}
	error={formError}
	onsubmit={save}
	oncancel={() => (editing = false)}
>
	<TextField label={t('usr.d.name')} maxlength={200} bind:value={form.name} />
	<TextField label={t('usr.d.givenName')} maxlength={100} bind:value={form.given_name} />
	<TextField label={t('usr.d.familyName')} maxlength={100} bind:value={form.family_name} />
	<TextField
		label={t('usr.d.preferredUsername')}
		maxlength={100}
		dir="ltr"
		bind:value={form.preferred_username}
	/>
	<TextField
		label={t('usr.d.phone')}
		type="tel"
		maxlength={32}
		error={phoneError}
		bind:value={form.phone_number}
	/>
</FormDialog>

<style>
	.muted {
		color: var(--text-muted);
	}
</style>
