<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type { ScreenListItem, ScreensClient } from '#lib/api/screens.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import ColumnBrowser from '#lib/ui/patterns/ColumnBrowser.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Wizard from '#lib/ui/patterns/Wizard.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { screenErrorKey } from './screen-errors';
	import { fieldsToBuilder } from './screen-layout';
	import {
		SCREEN_CATEGORIES,
		screenInputFromTemplate,
		screenKeyIsValid,
		screenTemplates,
		type ScreenCategory
	} from './screen-creation';
	import ScreenPreview from './ScreenPreview.svelte';

	interface Props {
		client: ScreensClient;
		canWrite: boolean;
		oncancel: () => void;
		oncreated: (id: string) => void;
	}

	let { client, canWrite, oncancel, oncreated }: Props = $props();
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let screens = $state<ScreenListItem[]>([]);
	let current = $state(0);
	let groupId = $state<ScreenCategory>('registration');
	let itemId = $state('');
	let name = $state('');
	let key = $state('');
	let description = $state('');
	let busy = $state(false);
	let gone = false;
	let request: AbortController | null = null;
	let loadNumber = 0;
	onDestroy(() => {
		gone = true;
		request?.abort();
	});

	async function load() {
		request?.abort();
		const controller = new AbortController();
		request = controller;
		const turn = ++loadNumber;
		phase = 'loading';
		try {
			const result = await client.list(controller.signal);
			if (gone || turn !== loadNumber) return;
			screens = result.screens;
			phase = 'ready';
		} catch (error) {
			if (gone || turn !== loadNumber || controller.signal.aborted) return;
			phase = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed';
		}
	}

	$effect(() => {
		if (canWrite) untrack(() => void load());
	});

	const groups = $derived(
		SCREEN_CATEGORIES.map((category) => ({
			id: category,
			label: t(`sc.create.category.${category}` as MessageKey)
		}))
	);
	const templates = $derived(screenTemplates(screens, t('sc.create.blank')));
	const selected = $derived(templates.find((item) => item.id === itemId) ?? null);
	const steps = $derived([
		{ id: 'template', label: t('sc.create.choose') },
		{ id: 'details', label: t('sc.create.details') }
	]);
	const keyTaken = $derived(screens.some((screen) => screen.screen_key === key.trim()));
	const valid = $derived(!!name.trim() && screenKeyIsValid(key) && !keyTaken);

	// Changing the selected template starts a new draft of its metadata.
	let seededId = '';
	$effect(() => {
		const template = selected;
		if (!template || template.id === seededId) return;
		untrack(() => {
			seededId = template.id;
			name = template.source
				? t('sc.copy.name', { name: template.source.display_name }).slice(0, 200)
				: '';
			key = template.source
				? `${template.source.screen_key.slice(0, 80)}_copy_${Date.now().toString(36)}`
				: '';
			description = '';
		});
	});

	function previewOf(template: NonNullable<typeof selected>) {
		const fields = template.source?.fields ?? [
			{
				field: 'title',
				label: t('sc.create.blankHeading'),
				required: false,
				block_type: 'heading' as const,
				block_id: 'title'
			}
		];
		let next = 0;
		return fieldsToBuilder(fields, (prefix) => `${prefix}-preview-${++next}`);
	}

	async function create() {
		if (!canWrite || !selected || !valid || busy) return;
		busy = true;
		try {
			// Snapshot the reactive source before structuredClone builds an independent save payload.
			const template = {
				...selected,
				source: selected.source ? ($state.snapshot(selected.source) as ScreenListItem) : null
			};
			const created = await client.create(
				screenInputFromTemplate(template, { name, key, description })
			);
			if (gone) return;
			toast.success(t('sc.editor.created'));
			oncreated(created.id);
		} catch (error) {
			if (!gone) toast.error(t(screenErrorKey(error, 'sc.editor.saveFailed')));
		} finally {
			busy = false;
		}
	}
</script>

<Page>
	<PageHeader title={t('sc.list.create')} description={t('sc.create.intro')}>
		{#snippet back()}
			<BackLink onclick={oncancel}>{t('sc.editor.back')}</BackLink>
		{/snippet}
	</PageHeader>

	{#if !canWrite}
		<Callout tone="warning">{t('sc.editor.readOnly')}</Callout>
	{:else if phase === 'loading'}
		<LoadingState label={t('sc.create.loading')} />
	{:else if phase === 'forbidden'}
		<Callout tone="warning">{t('sc.list.noAccess')}</Callout>
	{:else if phase === 'failed'}
		<Callout tone="danger" live>{t('sc.list.loadFailed')}</Callout>
		<div>
			<Button variant="secondary" onclick={() => void load()}>{t('sc.create.retry')}</Button>
		</div>
	{:else}
		<Wizard
			{steps}
			bind:current
			canNext={current === 0 ? !!selected : valid}
			description={current === 0 ? t('sc.create.chooseDesc') : t('sc.create.detailsDesc')}
			finishLabel={t('sc.list.create')}
			{busy}
			onfinish={() => void create()}
			{oncancel}
		>
			{#snippet children(step)}
				{#if step.id === 'template'}
					<ColumnBrowser
						label={t('sc.create.templates')}
						{groups}
						items={templates}
						bind:groupId
						bind:itemId
					>
						{#snippet detail(template)}
							{@const preview = previewOf(template)}
							<p class="template-kind">{t(`sc.kind.${template.kind}` as MessageKey)}</p>
							<h3 class="template-title">{template.label}</h3>
							{#if template.source?.description}
								<p class="template-description">{template.source.description}</p>
							{/if}
							<div class="template-preview" aria-label={t('sc.preview.title')}>
								<ScreenPreview
									rows={preview.rows}
									settings={preview.settings}
									rowSettings={preview.rowSettings}
								/>
							</div>
							<p class="template-note">{t('sc.preview.note')}</p>
						{/snippet}
					</ColumnBrowser>
				{:else}
					{#if selected}
						<p class="selected-template">
							{t('sc.create.selected', { name: selected.label })}
						</p>
					{/if}
					<div class="metadata">
						<TextField label={t('sc.editor.name')} bind:value={name} required maxlength={200} />
						<TextField
							label={t('sc.editor.key')}
							bind:value={key}
							required
							maxlength={96}
							hint={t('sc.editor.keyHint')}
							error={key.trim()
								? !screenKeyIsValid(key)
									? t('sc.editor.keyInvalid')
									: keyTaken
										? t('sc.error.keyTaken')
										: undefined
								: undefined}
						/>
						<TextArea label={t('sc.editor.description')} bind:value={description} rows={3} />
					</div>
				{/if}
			{/snippet}
		</Wizard>
	{/if}
</Page>

<style>
	.template-kind {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.template-title {
		margin: 0;
		font-size: var(--fs-heading);
	}

	.template-description,
	.template-note {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.template-preview {
		max-height: 360px;
		overflow: auto;
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
	}

	.selected-template {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.metadata {
		display: grid;
		gap: var(--space-field);
		max-width: 580px;
	}
</style>
