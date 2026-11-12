<script lang="ts">
	import { untrack } from 'svelte';
	import {
		ACTIVATE_REASONS,
		LOCK_REASONS,
		LifecycleConflictError,
		SUSPEND_REASONS,
		type AdminUser,
		type AdminUsersClient,
		type ActivateReason,
		type LockReason,
		type SuspendReason
	} from '#lib/api/admin-users.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import NumberField from '#lib/ui/primitives/NumberField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
	import { timePreference } from '#lib/ui/time/time-preference.svelte.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import {
		actionErrorKey,
		lockEnd,
		reasonOptions,
		suspendHours,
		userLabel,
		type LifecycleKind
	} from './user-model';

	/**
	 * Suspend, lock or reactivate a user. Each asks for a reason from the API's own list (the
	 * audit record keeps the code); a suspension may run for a number of hours and a lock until a
	 * time. A refusal stays in the dialog for a retry, except a state that changed meanwhile: the
	 * dialog closes and the page reads the user again.
	 */
	interface Props {
		client: AdminUsersClient;
		user: AdminUser;
		/** Which dialog is open; null when none. */
		kind: LifecycleKind | null;
		oncancel: () => void;
		/** The change went through. */
		ondone: () => void | Promise<void>;
		/** The user's state changed meanwhile: read it again. */
		onconflict: () => void | Promise<void>;
		/** Override the zone the unlock time is typed in (tests; normally the admin's choice). */
		zone?: TimeZoneMode;
	}

	let { client, user, kind, oncancel, ondone, onconflict, zone }: Props = $props();

	const CODES: Record<LifecycleKind, readonly string[]> = {
		suspend: SUSPEND_REASONS,
		lock: LOCK_REASONS,
		activate: ACTIVATE_REASONS
	};
	const TEXT: Record<
		LifecycleKind,
		{ title: MessageKey; body: MessageKey; submit: MessageKey; done: MessageKey }
	> = {
		suspend: {
			title: 'usr.suspend.title',
			body: 'usr.suspend.body',
			submit: 'usr.action.suspend',
			done: 'usr.toast.suspended'
		},
		lock: {
			title: 'usr.lock.title',
			body: 'usr.lock.body',
			submit: 'usr.action.lock',
			done: 'usr.toast.locked'
		},
		activate: {
			title: 'usr.activate.title',
			body: 'usr.activate.body',
			submit: 'usr.action.activate',
			done: 'usr.toast.activated'
		}
	};

	let reason = $state('');
	let detail = $state('');
	let hours = $state<number | null>(null);
	let hoursBad = $state(false);
	let until = $state('');
	let untilBad = $state(false);
	let reasonError = $state('');
	let hoursError = $state('');
	let untilError = $state('');
	let formError = $state('');
	let busy = $state(false);
	let inZone = $state<TimeZoneMode>('local');

	// A fresh form each time a dialog opens.
	$effect(() => {
		if (kind === null) return;
		untrack(() => {
			reason = '';
			detail = '';
			hours = null;
			hoursBad = false;
			until = '';
			untilBad = false;
			reasonError = hoursError = untilError = formError = '';
			inZone = zone ?? timePreference.zone;
		});
	});

	const shown = $derived(TEXT[kind ?? 'suspend']);
	const options = $derived(reasonOptions(CODES[kind ?? 'suspend'], t));
	const zoneNote = $derived(t('range.zone', { zone: inZone === 'utc' ? 'UTC' : t('range.local') }));
	const badInput = (event: Event & { currentTarget: HTMLInputElement }) =>
		event.currentTarget.validity.badInput;

	/**
	 * Someone reactivated the account meanwhile: the API answers that with a plain 400 ("already
	 * active"), not the 409 the other changes use. A 400 has more causes, so the user is read
	 * again and only an account that really is active counts.
	 */
	async function alreadyActive(error: unknown): Promise<boolean> {
		if (!(error instanceof ApiError) || error.status !== 400) return false;
		try {
			return (await client.get(user.id)).user.lifecycle_state === 'active';
		} catch {
			return false;
		}
	}

	async function submit(): Promise<void> {
		if (!kind) return;
		reasonError = hoursError = untilError = formError = '';
		if (!reason) reasonError = t('usr.reason.required');
		const duration = kind === 'suspend' ? suspendHours(hoursBad ? NaN : hours) : {};
		if (duration.problem) hoursError = t(duration.problem);
		const end = kind === 'lock' ? lockEnd(until, untilBad, inZone) : {};
		if (end.problem) untilError = t(end.problem);
		if (reasonError || hoursError || untilError) return;

		busy = true;
		try {
			const note = detail.trim() || undefined;
			if (kind === 'suspend') {
				await client.suspend(user.id, {
					reason: reason as SuspendReason,
					detail: note,
					durationHours: duration.hours
				});
			} else if (kind === 'lock') {
				await client.lock(user.id, {
					reason: reason as LockReason,
					detail: note,
					unlockAt: end.ms
				});
			} else {
				await client.activate(user.id, { reason: reason as ActivateReason, detail: note });
			}
			toast.success(t(shown.done, { name: userLabel(user) }));
			await ondone();
		} catch (error) {
			if (error instanceof LifecycleConflictError) {
				toast.error(t('usr.error.conflict'));
				await onconflict();
			} else if (kind === 'activate' && (await alreadyActive(error))) {
				toast.error(t('usr.error.conflict'));
				await onconflict();
			} else {
				formError = t(actionErrorKey(error));
			}
		} finally {
			busy = false;
		}
	}
</script>

<FormDialog
	open={kind !== null}
	title={t(shown.title)}
	description={t(shown.body)}
	submitLabel={t(shown.submit)}
	{busy}
	error={formError}
	onsubmit={submit}
	{oncancel}
>
	<Select
		label={t('usr.reason')}
		{options}
		placeholder={t('usr.reason.choose')}
		required
		error={reasonError}
		bind:value={reason}
	/>
	<TextArea
		label={t('usr.reason.detail')}
		hint={t('usr.reason.detailHint')}
		rows={3}
		maxlength={500}
		bind:value={detail}
	/>
	{#if kind === 'suspend'}
		<NumberField
			label={t('usr.suspend.hours')}
			unit={t('usr.suspend.hoursUnit')}
			min={1}
			max={8760}
			hint={t('usr.suspend.hoursHint')}
			error={hoursError}
			bind:value={hours}
			bind:invalid={hoursBad}
		/>
	{:else if kind === 'lock'}
		<TextField
			label={t('usr.lock.until')}
			type="datetime-local"
			hint={`${zoneNote} ${t('usr.lock.untilHint')}`}
			error={untilError}
			oninput={(event) => (untilBad = badInput(event))}
			onblur={(event) => (untilBad = badInput(event))}
			bind:value={until}
		/>
	{/if}
</FormDialog>
