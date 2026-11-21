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
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import SaveBar from '#lib/ui/patterns/SaveBar.svelte';
	import MappingSetPanel from '../mapping/MappingSetPanel.svelte';
	import LeaveGuard from './LeaveGuard.svelte';
	import { SAMPLE_USER_FEATURES } from './sample-user.js';
	import DestinationProfileEditor from './destination-profile/DestinationProfileEditor.svelte';
	import type { DestinationProfileSaved } from '#lib/api/destination-profiles.js';
	import type { MappingDestinationProfile } from '#lib/api/mapping-set.js';

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
		/** Whether an output source is chosen (the set's own, or the one a new mapping starts with). */
		outputChosen?: boolean;
		/** Show the test-user explanation (not for a federation, which has no one service to test against). */
		explain?: boolean;
		/**
		 * What is shown: the output source only, the mapping (set, attributes, save) only, or both.
		 * One instance holds the state, so a connection's flow can give each its own node.
		 */
		section?: 'output' | 'mapping' | 'all';
	}

	let {
		mapping = $bindable(),
		resources,
		dirty = $bindable(false),
		bound = $bindable(''),
		outputChosen = $bindable(false),
		readonly = false,
		disabled = false,
		pending = $bindable(false),
		guardNavigation = true,
		connectionDirty = false,
		explain = true,
		section = 'all'
	}: Props = $props();
	const shared = untrack(() => (resources ? new ConnectionMappingState(resources) : null));
	let invalid = $state(false);
	let changeTo = $state<string | null>(null);
	let explainError = $state(false);
	$effect(() => {
		dirty = (shared?.dirty ?? false) || editorState.dirty;
		pending = shared?.phase === 'saving' || shared?.phase === 'impact' || editorState.saving;
		bound = shared?.bound ?? '';
		outputChosen = !!(shared?.form.value.profileId || shared?.chosenProfileId);
	});
	onMount(() => {
		if (shared) void shared.load();
	});
	// The output source of the connection's mapping: made or changed here, in place of the mapping
	// until it is saved or left.
	let profileEditor = $state<'new' | 'edit' | null>(null);
	/** The output source the editor was opened on: a change of set under it does not move it. */
	let editingProfile = $state<MappingDestinationProfile | undefined>();
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
		editingProfile = kind === 'edit' ? chosenProfile : undefined;
		profileUsedBy = used.names;
		profileUsageUnknown = !used.complete;
		editorState = { dirty: false, saving: false };
		profileEditor = kind;
	}
	/** An output source was picked before any mapping: it is kept for the mapping to be made. */
	function chooseProfile(profileId: string) {
		if (!shared) return;
		shared.chosenProfileId = profileId;
	}
	/** No output source suits: one is made first; the mapping to come starts with it. */
	async function startWithNewProfile() {
		await openProfileEditor('new');
	}
	async function profileSaved(saved: DestinationProfileSaved) {
		const edited = profileEditor === 'edit';
		profileEditor = null;
		editorState = { dirty: false, saving: false };
		if (!shared) return;
		await shared.reloadProfiles();
		if (shared.newKey) {
			shared.form.value.profileId = saved.profile.id;
			shared.configure();
		} else if (!shared.selected) {
			// No mapping yet: the output source just made is the one the mapping will start with.
			shared.chosenProfileId = saved.profile.id;
		} else if (edited && shared.selected) {
			// What the set sends into has changed under it: read it again. An output source made
			// beside a set leaves the set as it is.
			await shared.select(shared.selected);
		}
	}
	function choose(value: string) {
		if (!shared || readonly || disabled) return;
		if (shared.dirty) changeTo = value;
		else if (value === '__new') {
			shared.create();
		} else void shared.select(value);
	}
	function applyChoice() {
		const value = changeTo;
		changeTo = null;
		if (value === null || !shared) return;
		if (value === '__new') {
			shared.create();
		} else if (value === '__inspect') void shared.inspectUnknown();
		else void shared.select(value);
	}

	/** An output source is being made or changed: the mapping waits until that is done or left. */
	const profileBusy = $derived(profileEditor !== null);
	/** What cannot be saved yet, in words ('' when nothing stops it). */
	const blockedReason = $derived.by(() => {
		if (!shared) return '';
		if (invalid) return t('common.fixErrors');
		if (shared.newKey && !shared.form.value.profileId) return t('cm.problem.profile');
		if (shared.newKey && !shared.form.value.catalogVersionId) return t('cm.problem.catalog');
		if (!shared.context) return t('cm.problem.context');
		if ((shared.form.dirty || !shared.detail) && !shared.form.value.name.trim())
			return t('cm.problem.name');
		if (!shared.form.value.mappings.length) return t('cm.problem.mappings');
		return '';
	});
	const blocked = $derived(blockedReason !== '');
	function save() {
		if (blocked || !shared) return;
		void shared.save();
	}
	/** Back to what the connection has now: its bound set, as it was read. */
	function discard() {
		// A save whose result is not known, or one waiting to be confirmed, is not thrown away.
		if (shared && !shared.locked) void shared.select(shared.bound);
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

{#snippet status()}
	{#if shared}
		{#if shared.phase === 'loading'}<LoadingState label={t('common.loading')} />{/if}
		<!-- A load that failed, or a release pause, is for whichever node is open. -->
		{#if shared.phase === 'failed'}<Callout tone="warning" live
				>{t('mc.actionFailed')}
				<Button
					size="sm"
					onclick={() => (shared.sets.length ? choose(shared.selected) : shared.load())}
					>{t('common.retry')}</Button
				></Callout
			>{/if}
		{#if shared.phase === 'paused'}<Callout tone="info" live>{t('common.releasePaused')}</Callout
			>{/if}
	{/if}
{/snippet}

{#if shared}
	<LeaveGuard dirty={guardNavigation && (shared.dirty || editorState.dirty)} />
	<div class="stack">
		<!-- Kept mounted while the mapping node is open, so an output source being edited keeps its
		     draft on the way. -->
		<div hidden={section === 'mapping'}>
			<Card title={t(copy.title)} description={t(copy.description)}>
				<div class="mapping">
					{@render status()}
					{#if profileEditor && resources?.profiles}
						<div>
							<DestinationProfileEditor
								protocol={resources.protocol}
								tenantId={resources.tenantId}
								client={resources.profiles}
								profiles={shared.allProfiles}
								profile={profileEditor === 'edit' ? editingProfile : undefined}
								usedBy={profileUsedBy}
								usageUnknown={profileUsageUnknown}
								onstate={(state) => (editorState = state)}
								onsaved={profileSaved}
								oncancel={() => {
									profileEditor = null;
									editorState = { dirty: false, saving: false };
								}}
							/>
						</div>
					{/if}
					{#if !(profileEditor && resources?.profiles)}
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
										<!-- A new output source can be made from here at any time; the editor opens with
									     "from a template" chosen. -->
										<Button variant="secondary" size="sm" onclick={() => openProfileEditor('new')}
											>{t('sf.dp.field.create')}</Button
										>
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
						{:else if !readonly && !disabled && !shared.locked && !shared.pinned && shared.phase === 'ready'}
							<!-- Nothing chosen and nothing being made: the output source can be picked or made first;
					     either one starts a new mapping set that sends into it. -->
							<div class="profile">
								<Select
									label={t('sf.dp.field.label')}
									hint={t('sf.dp.field.hint')}
									options={shared.profiles.map((profile) => ({
										value: profile.id,
										label: profile.displayName
									}))}
									placeholder={t('mc.ro.choose')}
									value={shared.chosenProfileId}
									onchange={chooseProfile}
								/>
								{#if canEditProfiles}
									<div class="profile__actions">
										<Button variant="secondary" size="sm" onclick={startWithNewProfile}
											>{t('sf.dp.field.create')}</Button
										>
									</div>
								{/if}
							</div>
						{/if}
					{/if}
				</div>
			</Card>
		</div>
		{#if section === 'mapping'}{@render status()}{/if}
		{#if section !== 'output'}
			<Card title={t('sf.row.mappingSet')}>
				<div class="mapping">
					{#if section === 'mapping' && profileBusy}<Callout tone="info"
							>{t('cm.finishOutputFirst')}</Callout
						>{/if}
					{#if section === 'mapping' && shared.newKey && !shared.form.value.profileId}<Callout
							tone="info">{t('cm.chooseOutputFirst')}</Callout
						>{/if}
					<Select
						label={t('sf.row.mappingSet')}
						required
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
							shared.pinned ||
							profileBusy}
						changed={shared.selected !== shared.bound}
					/>
					{#if !readonly}<div>
							<Button
								variant="secondary"
								size="sm"
								onclick={() => choose('__new')}
								disabled={disabled || shared.locked || shared.pinned || profileBusy}
								>{t('cm.create')}</Button
							>
						</div>{/if}
					{#if shared.readonlyReason}<Callout tone="warning">{t('cm.readonly')}</Callout>{/if}
					{#if shared.phase === 'conflict'}<Callout tone="warning" live
							>{t('cm.conflict')}
							<Button size="sm" onclick={() => choose(shared.selected)}>{t('cm.reload')}</Button
							></Callout
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
							<Button size="sm" onclick={() => choose('__inspect')}>{t('cm.reload')}</Button
							></Callout
						>{/if}
					{#if shared.phase === 'binding_failed'}<Callout tone="warning" live
							>{t('cm.bindingFailed')}
							<Button
								size="sm"
								disabled={disabled || readonly}
								onclick={() => shared.retryBinding()}>{t('cm.retryBinding')}</Button
							></Callout
						>{/if}
					{#if shared.phase === 'saved' && !shared.dirty}<Callout tone="info" live
							>{t('cm.saved')}</Callout
						>{/if}
					{#if shared.detail || shared.newKey}
						<BusyScope
							busy={disabled || readonly || shared.locked || shared.readonlyReason || profileBusy}
						>
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
						</BusyScope>
					{/if}
				</div>
			</Card>
			{#if shared.context && !shared.readonlyReason && (shared.detail || shared.newKey)}
				<BusyScope busy={disabled || readonly || shared.locked || profileBusy}>
					<div class="stack">
						<MappingSetPanel
							title={shared.form.value.name || t('sf.row.mappingSet')}
							description={shared.detail?.references
								? t('mc.ch.usedBy', { count: shared.detail.references.count })
								: undefined}
							sources={shared.context.sources}
							targets={shared.context.targets}
							bind:mappings={shared.form.value.mappings}
							bind:invalid
							setId={shared.selected}
							checkable={!!shared.selected}
							preview={shared.changes}
							stale={shared.changes !== null && shared.changesFor !== shared.draftKey}
							checking={shared.checking}
							actionError={shared.checkFailed ? t('mc.actionFailed') : ''}
							dirty={shared.form.dirty}
							oncheck={() => shared.check()}
						/>
					</div>
				</BusyScope>
			{/if}
			{#if SAMPLE_USER_FEATURES && resources && explain}<Disclosure title={t('mc.ex.form')}
					>{#snippet meta()}{#if explainError}<Badge tone="warning">{t('map.sample.failed')}</Badge
							>{/if}{/snippet}<ConnectionMappingExplain
						{resources}
						bind:error={explainError}
						changed={shared.dirty || connectionDirty}
						revision={`${shared.bound}:${shared.detail?.content_version ?? ''}:${resources.entityId ?? ''}`}
					/></Disclosure
				>{/if}
		{/if}
	</div>
	{#if !readonly && !disabled && !shared.readonlyReason && !profileBusy}
		<SaveBar
			dirty={shared.dirty}
			saving={shared.phase === 'saving'}
			invalid={blocked}
			invalidMessage={blockedReason}
			saveLabel={t('cm.saveBind')}
			onsave={save}
			ondiscard={discard}
		/>
	{/if}
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
	<Card title={t(copy.title)} description={t(copy.description)}>
		<MappingEditor
			label={t(copy.label)}
			direction={mapping.direction}
			sources={SAMPLE_USER_FEATURES
				? mapping.sources
				: mapping.sources.map(({ example: _example, ...field }) => field)}
			targets={mapping.targets}
			bind:mappings={mapping.mappings}
		/>
	</Card>
{/if}

<style>
	.stack {
		display: grid;
		gap: var(--space-section);
		min-width: 0;
	}

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
