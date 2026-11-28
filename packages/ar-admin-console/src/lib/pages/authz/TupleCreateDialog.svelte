<script lang="ts">
	import { untrack } from 'svelte';
	import type { TupleInput } from '#lib/api/end-user-rebac.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import EntityPicker, { type PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import RadioGroup from '#lib/ui/primitives/RadioGroup.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
	import { timePreference } from '#lib/ui/time/time-preference.svelte.js';
	import { readRoleEnd } from '../team/team-model';
	import ObjectTypeField from './ObjectTypeField.svelte';
	import {
		EMPTY_TUPLE_FORM,
		SUBJECT_KINDS,
		tupleInputOf,
		tupleProblems,
		rebacRefusalText,
		type SubjectKind,
		type TupleForm
	} from './rebac-model';
	import type { PickerSearch } from './user-picker';

	/**
	 * Add a relationship tuple: who (a user, every member of a group, or another object, for a
	 * path a definition declares with “follow a relation to another object”), which relation, on
	 * which object, and optionally until when. The API says if the kind of tuple is not one it
	 * takes, or the tuple already exists; the dialog stays open for a retry.
	 */
	interface Props {
		open: boolean;
		/** The object types the definitions use. */
		objectTypes: readonly string[];
		searchUsers: PickerSearch;
		searchGroups: PickerSearch;
		onsubmit: (input: TupleInput) => Promise<void>;
		oncancel: () => void;
		/** Override the zone the end is typed in (tests; normally the admin's choice). */
		zone?: TimeZoneMode;
	}

	let { open, objectTypes, searchUsers, searchGroups, onsubmit, oncancel, zone }: Props = $props();

	const inZone = untrack(() => zone ?? timePreference.zone);
	const zoneNote = t('range.zone', { zone: inZone === 'utc' ? 'UTC' : t('range.local') });

	let form = $state<TupleForm>({ ...EMPTY_TUPLE_FORM });
	let userPick = $state<PickerItem[]>([]);
	let groupPick = $state<PickerItem[]>([]);
	let ends = $state('');
	let endsIncomplete = $state(false);
	let tried = $state(false);
	let busy = $state(false);
	let error = $state('');

	$effect(() => {
		if (!open) return;
		form = { ...EMPTY_TUPLE_FORM };
		userPick = [];
		groupPick = [];
		ends = '';
		endsIncomplete = false;
		tried = false;
		error = '';
	});

	// The picked user or group is the form's subject.
	const subjectId = $derived(
		form.kind === 'user'
			? (userPick[0]?.value ?? '')
			: form.kind === 'group'
				? (groupPick[0]?.value ?? '')
				: ''
	);
	const filled = $derived<TupleForm>({ ...form, subject_id: subjectId });
	const problems = $derived(tupleProblems(filled));
	const end = $derived(readRoleEnd(ends, endsIncomplete, inZone));
	const shown = <K extends keyof TupleForm>(field: K) =>
		tried && problems[field] ? t(problems[field]) : undefined;

	async function submit() {
		tried = true;
		error = '';
		if (Object.keys(problems).length > 0 || end.problem) return;
		busy = true;
		try {
			await onsubmit(tupleInputOf(filled, end.ms ?? null));
		} catch (failure) {
			error = rebacRefusalText(failure, 'tuple', t);
		} finally {
			busy = false;
		}
	}

	const badInput = (event: Event & { currentTarget: HTMLInputElement }) =>
		event.currentTarget.validity.badInput;
	const KIND_LABEL = {
		user: 'rb.tuple.kind.user',
		group: 'rb.tuple.kind.group',
		object: 'rb.tuple.kind.object'
	} as const;
</script>

<FormDialog
	{open}
	title={t('rb.tuple.new.title')}
	description={t('rb.tuple.new.desc')}
	submitLabel={t('rb.tuple.new.submit')}
	{busy}
	{error}
	onsubmit={submit}
	{oncancel}
>
	<RadioGroup
		label={t('rb.tuple.subjectKind')}
		options={SUBJECT_KINDS.map((kind) => ({ value: kind, label: t(KIND_LABEL[kind]) }))}
		bind:value={() => form.kind, (value) => (form.kind = value as SubjectKind)}
	/>
	{#if form.kind === 'user'}
		<EntityPicker
			label={t('rb.tuple.user')}
			placeholder={t('az.picker.placeholder')}
			multiple={false}
			required
			search={searchUsers}
			error={shown('subject_id')}
			bind:items={userPick}
		/>
	{:else if form.kind === 'group'}
		<EntityPicker
			label={t('rb.tuple.group')}
			placeholder={t('az.picker.groupPlaceholder')}
			multiple={false}
			required
			search={searchGroups}
			error={shown('subject_id')}
			hint={t('rb.tuple.groupHint')}
			bind:items={groupPick}
		/>
	{:else}
		<ObjectTypeField
			label={t('rb.tuple.sourceType')}
			types={objectTypes}
			required
			hint={t('rb.tuple.objectHint')}
			error={shown('object_type')}
			bind:value={form.object_type}
		/>
		<TextField
			label={t('rb.tuple.sourceId')}
			required
			placeholder="doc_1"
			error={shown('object_id')}
			bind:value={form.object_id}
		/>
	{/if}
	<TextField
		label={t('rb.tuple.relation')}
		required
		placeholder={form.kind === 'object' ? 'parent' : 'viewer'}
		hint={form.kind === 'object' ? t('rb.tuple.edgeRelationHint') : undefined}
		error={shown('relation')}
		bind:value={form.relation}
	/>
	<ObjectTypeField
		label={t('rb.tuple.toType')}
		types={objectTypes}
		required
		error={shown('to_type')}
		bind:value={form.to_type}
	/>
	<TextField
		label={t('rb.tuple.toId')}
		required
		placeholder={form.kind === 'object' ? 'folder_a' : 'doc_1'}
		error={shown('to_id')}
		bind:value={form.to_id}
	/>
	<TextField
		label={t('rb.tuple.ends')}
		type="datetime-local"
		hint={`${zoneNote} ${t('rb.tuple.endsHint')}`}
		error={tried && end.problem ? t(end.problem) : undefined}
		oninput={(event) => (endsIncomplete = badInput(event))}
		onblur={(event) => (endsIncomplete = badInput(event))}
		bind:value={ends}
	/>
</FormDialog>
