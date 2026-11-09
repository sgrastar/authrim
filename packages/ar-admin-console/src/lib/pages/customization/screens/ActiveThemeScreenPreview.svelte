<script lang="ts">
	import type { ThemeValues } from '#lib/api/login-ui-themes.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import ThemePreview from '../ThemePreview.svelte';
	import { newThemeDraft, type ThemeDraft } from '../theme-draft';
	import { valuesToDraft } from '../theme-values';
	import type { ScreenPreviewContent } from './screen-preview-content';

	interface Props {
		preview: ScreenPreviewContent;
		/** Reads the applied Login UI settings, rather than the theme's latest saved draft. */
		loadTheme?: (signal: AbortSignal) => Promise<ThemeValues>;
	}

	let { preview, loadTheme }: Props = $props();
	let draft = $state<ThemeDraft>(newThemeDraft());
	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let retry = $state(0);
	let mode = $state<'light' | 'dark'>('light');
	const scheme = $derived(draft.mode === 'auto' ? mode : draft.mode);

	$effect(() => {
		const source = loadTheme;
		const attempt = retry;
		if (!source) {
			phase = 'ready';
			return;
		}
		const controller = new AbortController();
		phase = 'loading';
		void source(controller.signal)
			.then((values) => {
				if (controller.signal.aborted || attempt !== retry) return;
				draft = valuesToDraft(values);
				phase = 'ready';
			})
			.catch(() => {
				if (!controller.signal.aborted && attempt === retry) phase = 'failed';
			});
		return () => controller.abort();
	});
</script>

{#if phase === 'loading'}
	<LoadingState label={t('common.loading')} />
{:else if phase === 'failed'}
	<Callout tone="warning" title={t('sc.preview.themeLoadFailed')}>
		<Button size="sm" onclick={() => (retry += 1)}>{t('common.retry')}</Button>
	</Callout>
{:else}
	<ThemePreview {draft} {scheme} {preview} bind:mode note={t('sc.preview.note')} />
{/if}
