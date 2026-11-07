<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { apiAssetUrl } from '#lib/api/assets.js';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import PickerDialog, { type PickerGroup } from '#lib/ui/patterns/PickerDialog.svelte';
	import { apiBgPresets, bgPresetGroups, type BgPresetSource } from './bg-presets';

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
	// Each load gets a number; closing or opening again makes an older one's answer void.
	let request = 0;

	async function show() {
		open = true;
		status = 'loading';
		const mine = ++request;
		try {
			const presets = await source();
			if (mine !== request) return;
			groups = bgPresetGroups(presets);
			status = 'ready';
		} catch {
			if (mine === request) status = 'failed';
		}
	}

	// While loading, after a failure or with no presets, one column says so.
	const shown = $derived.by((): PickerGroup[] => {
		if (status === 'ready' && groups.length) return groups;
		const empty =
			status === 'loading'
				? t('th.bg.loading')
				: status === 'failed'
					? t('th.bg.loadFailed')
					: t('th.bg.none');
		return [{ id: 'status', label: t('th.bg.title'), icon: 'image', empty, items: [] }];
	});

	function close() {
		request++;
		open = false;
	}
</script>

<IconButton icon="folder" size="sm" label={t('th.bg.browse')} {disabled} onclick={show} />

<PickerDialog
	{open}
	title={t('th.bg.title')}
	groups={shown}
	value={typeof value === 'string' ? value : null}
	chooseLabel={t('th.bg.apply')}
	currentLabel={t('th.bg.current')}
	onchoose={(url) => {
		onchoose(url);
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
