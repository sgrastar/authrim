<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import MappingEditor from '#lib/ui/patterns/MappingEditor.svelte';
	import { provideSaveScope } from '#lib/ui/save/save-scope.js';
	import type { ConnectionMapping } from './connection-mapping.sample';
	import {
		ConnectionMappingState,
		type ConnectionMappingResources
	} from './connection-mapping.svelte.js';
	import ConnectionMappingExplain from './ConnectionMappingExplain.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import BusyScope from '#lib/ui/busy/BusyScope.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import RequiredBadge from '#lib/ui/primitives/RequiredBadge.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import LeaveGuard from './LeaveGuard.svelte';
	import DestinationProfileEditor from './destination-profile/DestinationProfileEditor.svelte';
	import type { DestinationProfileSaved } from '#lib/api/destination-profiles.js';

	/**
	 * A connection's one mapping, on its service flow's main screen: a provider's attributes into
	 * Authrim's (inbound), or Authrim's into what an app receives (outbound). Live RP/SP connections
	 * receive the facade and binding clients; existing prototype stories keep their local mapping.
	 */
	interface Props {
		mapping?: ConnectionMapping;
		resources?: ConnectionMappingResources;
		dirty?: boolean;
		bound?: string;
		readonly?: boolean;
		disabled?: boolean;
		pending?: boolean;
		guardNavigation?: boolean;
		connectionDirty?: boolean;
	}

	let {
		mapping = $bindable(),
		resources,
		dirty = $bindable(false),
		bound = $bindable(''),
		readonly = false,
		disabled = false,
		pending = $bindable(false),
		guardNavigation = true,
		connectionDirty = false
	}: Props = $props();
	const shared = untrack(() => (resources ? new ConnectionMappingState(resources) : null));
	let invalid = $state(false);
	let changeTo = $state<string | null>(null);
	let metadataOpen = $state(false);
	let explainError = $state(false);
	$effect(() => {
		dirty = (shared?.dirty ?? false) || editorState.dirty;
		pending = shared?.phase === 'saving' || shared?.phase === 'impact' || editorState.saving;
		bound = shared?.bound ?? '';
	});
	onMount(() => {
		if (shared) void shared.load();
	});
	// The output source of the connection's mapping: made or changed here, in place of the mapping
	// until it is saved or left.
	let profileEditor = $state<'new' | 'edit' | null>(null);
	let profileUsedBy = $state<string[]>([]);
	let profileUsageUnknown = $state(false);
	let editorState = $state({ dirty: false, saving: false });
	/** A new set with mappings in it cannot have its output source changed under them. */
	const profileEditBlocked = $derived(
		!!shared && !!shared.newKey && shared.form.value.mappings.length > 0
	);
	const canEditProfiles = $derived(!!resources?.profiles && !readonly && !disabled);
	const chosenProfile = $derived(
		shared?.allProfiles.find((profile) => profile.id === shared.form.value.profileId)
	);
	async function openProfileEditor(kind: 'new' | 'edit') {
		if (!shared) return;
		const used =
			kind === 'edit' && chosenProfile
				? await shared.setsUsing(chosenProfile.id)
				: { names: [], complete: true };
		profileUsedBy = used.names;
		profileUsageUnknown = !used.complete;
		editorState = { dirty: false, saving: false };
		profileEditor = kind;
	}
	async function profileSaved(saved: DestinationProfileSaved) {
		profileEditor = null;
		editorState = { dirty: false, saving: false };
		if (!shared) return;
		await shared.reloadProfiles();
		if (shared.newKey) {
			shared.form.value.profileId = saved.profile.id;
			shared.configure();
		} else if (shared.selected) {
			// What the set sends into has changed under it: read it again.
			await shared.select(shared.selected);
		}
	}
	function choose(value: string) {
		if (!shared || readonly || disabled) return;
		if (shared.dirty) changeTo = value;
		else if (value === '__new') {
			shared.create();
			metadataOpen = true;
		} else void shared.select(value);
	}
	function applyChoice() {
		const value = changeTo;
		changeTo = null;
		if (value === null || !shared) return;
		if (value === '__new') {
			shared.create();
			metadataOpen = true;
		} else if (value === '__inspect') void shared.inspectUnknown();
		else void shared.select(value);
	}

	// Mapping content has its own save operation, separate from connection settings.
	provideSaveScope({ original: (field) => shared?.form.original(field) });
	const COPY = {
		inbound: {
			title: 'sf.maps.in.title',
			description: 'sf.maps.in.description',
			label: 'sf.maps.in.label'
		},
		outbound: {
			title: 'sf.maps.out.title',
			description: 'sf.maps.out.description',
			label: 'sf.maps.out.label'
		}
	} as const;
	const copy = $derived(COPY[mapping?.direction ?? 'outbound']);
</script>

<Card title={t(copy.title)} description={t(copy.description)}>
	{#if shared}
		<LeaveGuard dirty={guardNavigation && (shared.dirty || editorState.dirty)} />
		<div class="mapping">
			{#if shared.phase === 'loading'}<LoadingState label={t('common.loading')} />{/if}
			{#if profileEditor && shared && resources?.profiles}
				<DestinationProfileEditor
					protocol={resources.protocol}
					tenantId={resources.tenantId}
					client={resources.profiles}
					profiles={shared.allProfiles}
					profile={profileEditor === 'edit' ? chosenProfile : undefined}
					usedBy={profileUsedBy}
					usageUnknown={profileUsageUnknown}
					onstate={(state) => (editorState = state)}
					onsaved={profileSaved}
					oncancel={() => {
						profileEditor = null;
						editorState = { dirty: false, saving: false };
					}}
				/>
			{:else}
				{#if shared.detail || shared.newKey}
					<div class="profile">
						<Select
							label={t('sf.dp.field.label')}
							hint={t('sf.dp.field.hint')}
							options={shared.profiles.map((profile) => ({
								value: profile.id,
								label: profile.displayName
							}))}
							placeholder={shared.detail?.destination_profile_id ?? t('mc.ro.choose')}
							value={shared.form.value.profileId}
							onchange={(value) => {
								shared.form.value.profileId = value;
								shared.configure();
							}}
							disabled={!!shared.detail || readonly || disabled || shared.locked}
							field="profileId"
						/>
						{#if canEditProfiles && !shared.locked}
							<div class="profile__actions">
								{#if shared.newKey}
									<Button variant="secondary" size="sm" onclick={() => openProfileEditor('new')}
										>{t('sf.dp.field.create')}</Button
									>
								{/if}
								{#if profileEditBlocked}<p class="profile__hint">
										{t('sf.dp.field.editBlocked')}
									</p>{/if}
								{#if chosenProfile}
									<Button
										variant="secondary"
										size="sm"
										disabled={(shared.dirty && !shared.newKey) || profileEditBlocked}
										onclick={() => openProfileEditor('edit')}>{t('sf.dp.field.edit')}</Button
									>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
				<Select
					label={t('sf.row.mappingSet')}
					placeholder={t('mc.ro.choose')}
					options={shared.sets.map((set) => ({
						value: set.id,
						label: set.display_name ?? set.field_mapping_key
					}))}
					value={shared.selected}
					onchange={choose}
					disabled={readonly ||
						disabled ||
						shared.locked ||
						shared.phase === 'loading' ||
						shared.pinned}
					changed={shared.selected !== shared.bound}
				/>
				{#if !readonly}<div>
						<Button
							variant="secondary"
							size="sm"
							onclick={() => choose('__new')}
							disabled={disabled || shared.locked || shared.pinned}>{t('cm.create')}</Button
						>
					</div>{/if}
				{#if shared.dirty}<Badge tone="changed">{t('common.changed')}</Badge>{/if}
				{#if shared.readonlyReason}<Callout tone="warning">{t('cm.readonly')}</Callout>{/if}
				{#if shared.phase === 'failed'}<Callout tone="warning" live
						>{t('mc.actionFailed')}
						<Button
							size="sm"
							onclick={() => (shared.sets.length ? choose(shared.selected) : shared.load())}
							>{t('common.retry')}</Button
						></Callout
					>{/if}
				{#if shared.phase === 'conflict'}<Callout tone="warning" live
						>{t('cm.conflict')}
						<Button size="sm" onclick={() => choose(shared.selected)}>{t('cm.reload')}</Button
						></Callout
					>{/if}
				{#if shared.phase === 'paused'}<Callout tone="info" live
						>{t('common.releasePaused')}</Callout
					>{/if}
				{#if shared.phase === 'stage_failed'}<Callout tone="warning" live
						>{t('cm.stageFailed', { stage: shared.stage })}
						<Button size="sm" onclick={() => choose(shared.selected)}>{t('cm.reload')}</Button
						></Callout
					>{/if}
				{#if shared.phase === 'outcome_unknown'}<Callout tone="warning" live
						>{t('cm.unknown')}
						<Button size="sm" disabled={disabled || readonly} onclick={() => shared.write()}
							>{t('common.retry')}</Button
						>
						<Button size="sm" onclick={() => choose('__inspect')}>{t('cm.reload')}</Button></Callout
					>{/if}
				{#if shared.phase === 'binding_failed'}<Callout tone="warning" live
						>{t('cm.bindingFailed')}
						<Button size="sm" disabled={disabled || readonly} onclick={() => shared.retryBinding()}
							>{t('cm.retryBinding')}</Button
						></Callout
					>{/if}
				{#if shared.phase === 'saved' && !shared.dirty}<Callout tone="info" live
						>{t('cm.saved')}</Callout
					>{/if}
				{#if shared.detail || shared.newKey}
					<BusyScope busy={disabled || readonly || shared.locked || shared.readonlyReason}>
						<Disclosure title={t('cm.options')} bind:open={metadataOpen}>
							{#snippet meta()}{#if !shared.form.value.name.trim() || !shared.form.value.profileId || !shared.form.value.catalogVersionId}<RequiredBadge
									/>{/if}{/snippet}
							<TextField
								label={t('sf.row.name')}
								bind:value={shared.form.value.name}
								field="name"
								required
							/>
							<TextArea
								label={t('cm.description')}
								bind:value={shared.form.value.description}
								field="description"
							/>
							<Select
								label={t('cm.catalog')}
								options={shared.catalogs.flatMap((catalog) =>
									catalog.versionId
										? [{ value: catalog.versionId, label: catalog.displayName }]
										: []
								)}
								placeholder={shared.detail?.content?.catalogVersionId ?? t('mc.ro.choose')}
								value={shared.form.value.catalogVersionId}
								onchange={(value) => {
									shared.form.value.catalogVersionId = value;
									shared.configure();
								}}
								disabled={!!shared.detail}
								field="catalogVersionId"
							/>
						</Disclosure>
						{#if shared.context && !shared.readonlyReason}
							<MappingEditor
								label={t(copy.label)}
								direction="outbound"
								sources={shared.context.sources}
								targets={shared.context.targets}
								bind:mappings={shared.form.value.mappings}
								bind:invalid
								field="mappings"
							/>
						{/if}
						{#if !readonly && !shared.readonlyReason}
							<div>
								<Button
									onclick={() => shared.save()}
									loading={shared.phase === 'saving'}
									disabled={invalid ||
										!shared.context ||
										((shared.form.dirty || !shared.detail) && !shared.form.value.name.trim()) ||
										!shared.form.value.mappings.length ||
										(!shared.form.dirty && shared.selected === shared.bound)}
									>{t('cm.saveBind')}</Button
								>
							</div>
						{/if}
					</BusyScope>
				{/if}
			{/if}
			{#if resources}<Disclosure title={t('mc.ex.form')}
					>{#snippet meta()}{#if explainError}<Badge tone="warning">{t('map.sample.failed')}</Badge
							>{/if}{/snippet}<ConnectionMappingExplain
						{resources}
						bind:error={explainError}
						changed={shared.dirty || connectionDirty}
						revision={`${shared.bound}:${shared.detail?.content_version ?? ''}:${resources.entityId ?? ''}`}
					/></Disclosure
				>{/if}
		</div>
		<ConfirmDialog
			open={shared.phase === 'impact'}
			title={t('cm.impactTitle')}
			body={t(shared.impact?.incomplete ? 'cm.impactIncomplete' : 'cm.impact', {
				count: shared.impact?.count ?? 0
			}) +
				(shared.impact?.connections.length
					? ' ' + t('cm.otherConnections', { names: shared.impact.connections.join(', ') })
					: '')}
			confirmLabel={t('cm.confirmImpact')}
			onconfirm={() => shared.confirmImpact()}
			oncancel={() => shared.cancelImpact()}
		/>
		<ConfirmDialog
			open={changeTo !== null}
			title={t('cm.discardTitle')}
			body={t('cm.discardBody')}
			confirmLabel={t('common.discard')}
			onconfirm={applyChoice}
			oncancel={() => (changeTo = null)}
		/>
	{:else if mapping}
		<MappingEditor
			label={t(copy.label)}
			direction={mapping.direction}
			sources={mapping.sources}
			targets={mapping.targets}
			bind:mappings={mapping.mappings}
		/>
	{/if}
</Card>

<style>
	.profile {
		display: grid;
		gap: var(--space-related);
	}

	.profile__hint {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.profile__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
	}

	.mapping {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: var(--space-field);
	}
</style>
