<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { apiAssetUrl } from '#lib/api/assets.js';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import PickerDialog, {
		type PickerGroup,
		type PickerNotice
	} from '#lib/ui/patterns/PickerDialog.svelte';
	import { guideSignal } from '#lib/onboarding/signals.js';
	import { apiBgPresets, bgPresetGroups, loadBgPresets, type BgPresetSource } from './bg-presets';

	/**
	 * A small folder button beside a background picture that opens the shared presets in a large
	 * column browser (category → picture → preview). Applying one hands its path to `onchoose`:
	 * the theme refers to the shared picture, nothing is uploaded.
	 */
	interface Props {
		/** The field's current picture: the preset it is, if any, is marked as the current one. */
		value?: string | File | null;
		disabled?: boolean;
		source?: BgPresetSource;
		onchoose: (url: string) => void;
	}

	let { value = null, disabled = false, source = apiBgPresets, onchoose }: Props = $props();

	let open = $state(false);
	let groups = $state<PickerGroup[]>([]);
	let status = $state<'loading' | 'failed' | 'ready'>('loading');
	// Each load gets a number; a later one makes an earlier one's answer void.
	let request = 0;

	/**
	 * Asks for the list. It is asked for as soon as the button is on the page, so the first
	 * press finds it ready; a press while it is still on its way waits on the same request, and
	 * after a failure asks again.
	 */
	async function load(fresh = false) {
		status = 'loading';
		const mine = ++request;
		try {
			const presets = await loadBgPresets(source, { fresh });
			if (mine !== request) return;
			groups = bgPresetGroups(presets);
			status = 'ready';
		} catch {
			if (mine === request) status = 'failed';
		}
	}

	onMount(() => void load());

	function show() {
		open = true;
		// An empty list is asked for again too: presets may have been installed since.
		if (status !== 'ready' || !groups.length) void load(status === 'failed');
	}

	// Loading, failed or with nothing to show, the dialog says so (and, after a failure, offers to
	// try again) instead of showing a list that is not there.
	const notice = $derived.by((): PickerNotice | undefined => {
		if (status === 'loading') return { text: t('th.bg.loading'), busy: true };
		if (status === 'failed') {
			return {
				text: t('th.bg.loadFailed'),
				actionLabel: t('th.bg.retry'),
				onaction: () => void load(true)
			};
		}
		return groups.length ? undefined : { text: t('th.bg.none') };
	});

	function close() {
		open = false;
	}
</script>

<IconButton
	icon="folder"
	size="sm"
	label={t('th.bg.browse')}
	data-guide="theme-bg-preset"
	{disabled}
	onclick={show}
/>

<PickerDialog
	{open}
	title={t('th.bg.title')}
	groups={status === 'ready' ? groups : []}
	{notice}
	value={typeof value === 'string' ? value : null}
	chooseLabel={t('th.bg.apply')}
	currentLabel={t('th.bg.current')}
	onchoose={(url) => {
		onchoose(url);
		guideSignal('theme.preset-chosen');
		close();
	}}
	oncancel={close}
>
	{#snippet preview(item)}
		<div class="bg-preview">
			<img src={apiAssetUrl(item.value)} alt={item.label} />
		</div>
	{/snippet}
</PickerDialog>

<style>
	.bg-preview {
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-subtle);
		aspect-ratio: 16 / 10;
	}

	.bg-preview img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
