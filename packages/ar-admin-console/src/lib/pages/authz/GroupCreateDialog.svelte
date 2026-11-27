<script lang="ts">
	import type { AuthzAccess } from '#lib/access/access.js';
	import type { EndUserGroupsClient, GroupKind } from '#lib/api/end-user-groups.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import EntityPicker, { type PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import RadioGroup from '#lib/ui/primitives/RadioGroup.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { refusalText } from './authz-errors';
	import { creatableKinds, groupKeyProblem, suggestKey } from './group-model';
	import { groupSearch } from './user-picker';

	/**
	 * A new group: static (members added by hand, or from SCIM, rules and invitations), or dynamic
	 * (members decided by a rule, set on the group's page after it is made). A static group can be
	 * put under a parent; its members then hold the parent's roles too.
	 */
	interface Props {
		client: EndUserGroupsClient;
		access: AuthzAccess;
		open: boolean;
		oncancel: () => void;
		oncreated: (groupId: string) => void;
	}

	let { client, access, open, oncancel, oncreated }: Props = $props();

	let kind = $state<GroupKind>('static');
	let name = $state('');
	let key = $state('');
	let keyTouched = $state(false);
	let description = $state('');
	let parent = $state<PickerItem[]>([]);
	const kinds = $derived(creatableKinds(access));
	const searchParents = $derived(groupSearch(client));
	let busy = $state(false);
	let tried = $state(false);
	let error = $state('');

	$effect(() => {
		if (!open) return;
		kind = kinds[0] ?? 'static';
		name = '';
		key = '';
		keyTouched = false;
		description = '';
		parent = [];
		tried = false;
		error = '';
	});

	const nameProblem = $derived(name.trim() ? undefined : t('grp.new.nameRequired'));
	const keyProblem = $derived.by(() => {
		const problem = groupKeyProblem(key, kind);
		return problem ? t(problem) : undefined;
	});

	async function create() {
		tried = true;
		error = '';
		if (nameProblem || keyProblem || !kinds.includes(kind)) return;
		busy = true;
		try {
			let id: string;
			if (kind === 'dynamic') {
				const catalog = await client.catalog();
				const saved = await client.saveDynamic(
					{
						key: key.trim(),
						displayName: name.trim(),
						description: description.trim(),
						enabled: true,
						condition: null
					},
					catalog.revision
				);
				id = saved.groups.find((group) => group.key === key.trim())?.id ?? '';
			} else {
				id = (
					await client.create({
						group_key: key,
						display_name: name,
						description,
						parent_group_id: parent[0]?.value ?? null
					})
				).id;
			}
			toast.success(t('grp.toast.created', { name: name.trim() }));
			// The catalog's answer always names the new group; without its id, the list is shown.
			if (id) oncreated(id);
			else oncancel();
		} catch (failure) {
			error = refusalText(failure, t);
		} finally {
			busy = false;
		}
	}
</script>

<FormDialog
	{open}
	title={t('grp.new.title')}
	submitLabel={t('grp.new.submit')}
	{busy}
	{error}
	onsubmit={create}
	{oncancel}
>
	{#if kinds.length > 1}
		<RadioGroup
			label={t('grp.new.kind')}
			options={kinds.map((value) => ({
				value,
				label: t(value === 'dynamic' ? 'grp.kind.dynamic' : 'grp.kind.static'),
				description: t(
					value === 'dynamic' ? 'grp.new.kind.dynamic.desc' : 'grp.new.kind.static.desc'
				)
			}))}
			bind:value={
				() => kind,
				(value) => {
					kind = value as GroupKind;
					if (!keyTouched) key = suggestKey(name, kind);
				}
			}
		/>
	{/if}
	<TextField
		label={t('grp.new.name')}
		required
		maxlength={200}
		error={tried ? nameProblem : undefined}
		bind:value={name}
		oninput={() => {
			if (!keyTouched) key = suggestKey(name, kind);
		}}
	/>
	<TextField
		label={t('grp.new.key')}
		required
		maxlength={kind === 'dynamic' ? 64 : 128}
		hint={kind === 'dynamic' ? t('grp.new.dynamicKeyHint') : t('grp.new.keyHint')}
		error={tried ? keyProblem : undefined}
		bind:value={key}
		oninput={() => (keyTouched = true)}
	/>
	<TextArea label={t('grp.new.description')} maxlength={2000} bind:value={description} />
	{#if kind === 'static'}
		<EntityPicker
			label={t('grp.new.parent')}
			placeholder={t('az.picker.groupPlaceholder')}
			hint={t('grp.new.parentHint')}
			multiple={false}
			search={searchParents}
			bind:items={parent}
		/>
	{/if}
</FormDialog>
