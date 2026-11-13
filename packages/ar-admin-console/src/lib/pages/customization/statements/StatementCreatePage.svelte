<script lang="ts">
	import type { ConsentStatementsClient } from '#lib/api/consent-statements.js';
	import { i18n, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { apiDetail, statementErrorKey } from './statement-errors';
	import {
		CATEGORY_KINDS,
		LIMITS,
		SLUG_PATTERN,
		categoryOfKind,
		todayVersion,
		type CategoryKind
	} from './statement-model';

	/**
	 * Makes a statement: its key (an identifier that does not change), its kind, and the text of
	 * its first version in the admin's language. The version is saved as a draft: it is looked at
	 * on the statement's page and published there.
	 */
	interface Props {
		client: ConsentStatementsClient;
		canWrite: boolean;
		listHref: string;
		oncreated: (id: string) => void;
	}

	let { client, canWrite, listHref, oncreated }: Props = $props();

	let slug = $state('');
	let kind = $state<CategoryKind>('terms');
	let title = $state('');
	let description = $state('');
	let body = $state('');
	let attempted = $state(false);
	let saving = $state(false);
	let error = $state('');

	const language = $derived(i18n.locale);
	const slugProblem = $derived<MessageKey | null>(
		!slug.trim()
			? 'cs.error.field.slug'
			: !SLUG_PATTERN.test(slug.trim()) || slug.trim().length > LIMITS.slug
				? 'cs.error.field.slugFormat'
				: null
	);
	const problem = (field: 'title' | 'description') =>
		attempted && !(field === 'title' ? title : description).trim()
			? t(`cs.error.field.${field}` as MessageKey)
			: undefined;
	const kinds = $derived(
		CATEGORY_KINDS.map((value) => ({ value, label: t(`cs.kind.${value}` as MessageKey) }))
	);

	async function create() {
		attempted = true;
		if (slugProblem || !title.trim() || !description.trim()) {
			error = t('cs.error.fix');
			return;
		}
		saving = true;
		error = '';
		let id = '';
		try {
			id = (await client.create({ slug: slug.trim(), category: categoryOfKind(kind) })).id;
		} catch (failure) {
			error = t(statementErrorKey(failure, 'create')) + apiDetail(failure);
			saving = false;
			return;
		}
		try {
			const version = await client.createVersion(id, {
				version: todayVersion(),
				content_type: 'inline',
				effective_at: Date.now()
			});
			await client.saveLocalization(id, version.id, language, {
				title: title.trim(),
				description: description.trim(),
				inline_content: body || null
			});
			toast.success(t('cs.create.created'));
		} catch (failure) {
			// The statement exists: its page is where the rest is finished.
			toast.error(t('cs.create.partial') + apiDetail(failure));
		}
		saving = false;
		oncreated(id);
	}
</script>

<Page>
	<PageHeader title={t('cs.list.create')} description={t('cs.create.intro')}>
		{#snippet back()}<BackLink href={listHref}>{t('cs.editor.back')}</BackLink>{/snippet}
	</PageHeader>

	{#if !canWrite}
		<EmptyState icon="lock" title={t('cs.create.noAccess')} />
	{:else}
		<form
			class="create"
			onsubmit={(event) => {
				event.preventDefault();
				void create();
			}}
		>
			{#if error}<Callout tone="danger" live>{error}</Callout>{/if}
			<Card title={t('cs.basic.title')}>
				<div class="create__fields">
					<TextField
						label={t('cs.create.slug')}
						hint={t('cs.create.slugHint')}
						maxlength={LIMITS.slug}
						spellcheck={false}
						autocomplete="off"
						error={attempted && slugProblem ? t(slugProblem) : undefined}
						bind:value={slug}
					/>
					<Select label={t('cs.basic.kind')} options={kinds} bind:value={kind} />
				</div>
			</Card>
			<Card title={t('cs.create.firstText')} description={t('cs.create.firstTextHint')}>
				<div class="create__fields">
					<TextField
						label={t('cs.content.name')}
						maxlength={LIMITS.title}
						error={problem('title')}
						bind:value={title}
					/>
					<TextArea
						label={t('cs.content.summary')}
						hint={t('cs.content.summaryHint')}
						rows={3}
						maxlength={LIMITS.description}
						error={problem('description')}
						bind:value={description}
					/>
					<TextArea
						label={t('cs.content.body')}
						rows={10}
						maxlength={LIMITS.content}
						bind:value={body}
					/>
				</div>
			</Card>
			<div class="create__actions">
				<Button variant="primary" type="submit" loading={saving}>{t('cs.create.submit')}</Button>
				<Button href={listHref}>{t('common.cancel')}</Button>
			</div>
		</form>
	{/if}
</Page>

<style>
	.create,
	.create__fields {
		display: grid;
		gap: var(--space-section);
		min-inline-size: 0;
	}

	.create__fields {
		gap: var(--space-related);
	}

	.create__actions {
		display: flex;
		gap: var(--space-related);
	}
</style>
