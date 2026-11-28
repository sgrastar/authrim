<script lang="ts">
	import { untrack } from 'svelte';
	import type { CheckApiKeyInput } from '#lib/api/check-api-keys.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import {
		EMPTY_KEY_FORM,
		KEY_OPERATIONS,
		keyInputOf,
		keyProblems,
		keyRefusalText,
		readKeyEnd,
		toggleOperation,
		type KeyForm,
		type KeyOperation
	} from '#lib/pages/authz/check-api-key-model.js';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
	import { timePreference } from '#lib/ui/time/time-preference.svelte.js';

	/**
	 * Make a Check API key: its name, the client (the app's backend) it belongs to, the operations
	 * it may use and, optionally, until when. The key belongs to this tenant. The API says what it
	 * refuses (the platform has machine credentials off, a value it does not take); the dialog
	 * stays open for a retry.
	 */
	interface Props {
		open: boolean;
		tenantId: string;
		onsubmit: (input: CheckApiKeyInput) => Promise<void>;
		oncancel: () => void;
		/** Override the zone the end is typed in (tests; normally the admin's choice). */
		zone?: TimeZoneMode;
	}

	let { open, tenantId, onsubmit, oncancel, zone }: Props = $props();

	// The zone is read each time the dialog opens, and the hint and the conversion share it.
	let inZone = $state<TimeZoneMode>('local');
	const zoneNote = $derived(t('range.zone', { zone: inZone === 'utc' ? 'UTC' : t('range.local') }));

	let form = $state<KeyForm>({ ...EMPTY_KEY_FORM, operations: [...EMPTY_KEY_FORM.operations] });
	let ends = $state('');
	let endsIncomplete = $state(false);
	let tried = $state(false);
	let busy = $state(false);
	let error = $state('');

	$effect(() => {
		if (!open) return;
		inZone = untrack(() => zone ?? timePreference.zone);
		form = { ...EMPTY_KEY_FORM, operations: [...EMPTY_KEY_FORM.operations] };
		ends = '';
		endsIncomplete = false;
		tried = false;
		error = '';
	});

	const problems = $derived(keyProblems(form));
	const end = $derived(readKeyEnd(ends, endsIncomplete, inZone));
	const shown = (field: keyof typeof problems) =>
		tried && problems[field] ? t(problems[field]) : undefined;

	async function submit() {
		tried = true;
		error = '';
		if (Object.keys(problems).length > 0 || end.problem) return;
		busy = true;
		try {
			await onsubmit(keyInputOf(form, end.ms ?? null));
		} catch (failure) {
			error = keyRefusalText(failure, t);
		} finally {
			busy = false;
		}
	}

	const badInput = (event: Event & { currentTarget: HTMLInputElement }) =>
		event.currentTarget.validity.badInput;
	const OPERATION_TEXT = {
		check: { label: 'az.keys.op.check', desc: 'az.keys.op.check.desc' },
		batch: { label: 'az.keys.op.batch', desc: 'az.keys.op.batch.desc' },
		subscribe: { label: 'az.keys.op.subscribe', desc: 'az.keys.op.subscribe.desc' }
	} as const;
</script>

<FormDialog
	{open}
	title={t('az.keys.new.title')}
	description={t('az.keys.new.desc', { tenant: tenantId })}
	submitLabel={t('az.keys.new.submit')}
	{busy}
	{error}
	onsubmit={submit}
	{oncancel}
>
	<TextField
		label={t('az.keys.new.name')}
		required
		placeholder="Documents backend"
		error={shown('name')}
		bind:value={form.name}
	/>
	<TextField
		label={t('az.keys.new.client')}
		required
		placeholder="docs-backend"
		hint={t('az.keys.new.clientHint')}
		error={shown('client_id')}
		bind:value={form.client_id}
	/>
	<fieldset class="ops">
		<legend>{t('az.keys.new.operations')}</legend>
		{#each KEY_OPERATIONS as operation (operation)}
			<Checkbox
				checked={form.operations.includes(operation)}
				description={t(OPERATION_TEXT[operation].desc)}
				onchange={(event) =>
					(form.operations = toggleOperation(
						form.operations,
						operation as KeyOperation,
						event.currentTarget.checked
					))}
			>
				{t(OPERATION_TEXT[operation].label)}
			</Checkbox>
		{/each}
		{#if shown('operations')}<p class="ops__error" role="alert">{shown('operations')}</p>{/if}
	</fieldset>
	<TextField
		label={t('az.keys.new.ends')}
		type="datetime-local"
		hint={`${zoneNote} ${t('az.keys.new.endsHint')}`}
		error={tried && end.problem ? t(end.problem) : undefined}
		oninput={(event) => (endsIncomplete = badInput(event))}
		onblur={(event) => (endsIncomplete = badInput(event))}
		bind:value={ends}
	/>
</FormDialog>

<style>
	.ops {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}

	.ops legend {
		padding: 0;
		margin-bottom: 6px;
		font-size: var(--fs-body);
		font-weight: var(--fw-medium);
		color: var(--text-primary);
	}

	.ops__error {
		margin: 0;
		font-size: var(--fs-caption);
		color: var(--danger);
	}
</style>
