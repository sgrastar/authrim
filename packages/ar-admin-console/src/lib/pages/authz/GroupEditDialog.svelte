<script lang="ts">
	import type {
		EndUserGroupDetail,
		EndUserGroupsClient,
		GroupChanges,
		GroupLifecycle
	} from '#lib/api/end-user-groups.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import EntityPicker, { type PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { refusalText } from './authz-errors';
	import { groupSearch } from './user-picker';

	/**
	 * A group's name, description, parent and state (its key is set once). Moving a group, or
	 * switching it on or off, changes the roles of everyone below it: when it or a parent carries
	 * roles the API asks the roles' write permission and a grant ceiling covering them.
	 */
	interface Props {
		client: EndUserGroupsClient;
		group: EndUserGroupDetail;
		open: boolean;
		oncancel: () => void;
		onsaved: () => void;
	}

	let { client, group, open, oncancel, onsaved }: Props = $props();

	let name = $state('');
	let description = $state('');
	let parentPick = $state<PickerItem[]>([]);
	let lifecycle = $state<GroupLifecycle>('active');
	const parent = $derived(parentPick[0]?.value ?? '');
	// The group itself is never offered as its parent; one below it is refused by the API (a loop).
	const searchParents = $derived(groupSearch(client, { exclude: () => new Set([group.id]) }));
	let busy = $state(false);
	let error = $state('');

	$effect(() => {
		if (!open) return;
		name = group.display_name;
		description = group.description ?? '';
		const current = group.parent_chain[0];
		parentPick = current
			? [{ value: current.id, label: current.display_name, description: current.group_key }]
			: [];
		lifecycle = group.lifecycle_state;
		error = '';
	});

	const moves = $derived(
		parent !== (group.parent_group_id ?? '') || lifecycle !== group.lifecycle_state
	);

	async function save() {
		if (!name.trim()) {
			error = t('grp.new.nameRequired');
			return;
		}
		const changes: GroupChanges = {};
		if (name.trim() !== group.display_name) changes.display_name = name;
		if (description.trim() !== (group.description ?? '')) changes.description = description;
		if (parent !== (group.parent_group_id ?? '')) changes.parent_group_id = parent || null;
		if (lifecycle !== group.lifecycle_state) changes.lifecycle_state = lifecycle;
		if (Object.keys(changes).length === 0) {
			oncancel();
			return;
		}
		busy = true;
		error = '';
		try {
			await client.update(group.id, changes);
			toast.success(t('grp.toast.saved'));
			onsaved();
		} catch (failure) {
			error = refusalText(failure, t);
		} finally {
			busy = false;
		}
	}
</script>

<FormDialog
	{open}
	title={t('grp.edit.title')}
	submitLabel={t('grp.edit.save')}
	{busy}
	{error}
	onsubmit={save}
	{oncancel}
>
	<TextField label={t('grp.new.name')} required maxlength={200} bind:value={name} />
	<TextArea label={t('grp.new.description')} maxlength={2000} bind:value={description} />
	<EntityPicker
		label={t('grp.new.parent')}
		placeholder={t('az.picker.groupPlaceholder')}
		hint={t('grp.edit.parentHint')}
		multiple={false}
		search={searchParents}
		bind:items={parentPick}
	/>
	<Select
		label={t('grp.list.col.state')}
		options={[
			{ value: 'active', label: t('grp.state.active') },
			{ value: 'inactive', label: t('grp.state.inactive') }
		]}
		bind:value={() => lifecycle, (value) => (lifecycle = value as GroupLifecycle)}
	/>
	{#if moves}
		<Callout icon="info">{t('grp.edit.movesRoles')}</Callout>
	{/if}
</FormDialog>
