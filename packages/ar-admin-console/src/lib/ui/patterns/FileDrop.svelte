<script lang="ts">
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';
	import { formatBytes } from '../format';
	import IconButton from '../primitives/IconButton.svelte';
	import { describeAccept, partitionFiles, type FileRejection } from './files';

	/**
	 * Drop zone plus file picker. Dropped files get the same type/size checks as picked ones;
	 * rejected files are listed with the reason instead of being silently ignored.
	 */
	interface Props {
		label: string;
		files?: File[];
		/** Same syntax as the input's `accept` attribute, e.g. ".json,application/json". */
		accept?: string;
		maxBytes?: number;
		multiple?: boolean;
		disabled?: boolean;
	}

	let {
		label,
		files = $bindable([]),
		accept,
		maxBytes,
		multiple = false,
		disabled = false
	}: Props = $props();

	let dragging = $state(false);
	let rejected = $state<FileRejection[]>([]);
	let input = $state<HTMLInputElement>();
	const uid = $props.id();

	const limits = $derived.by(() => {
		const types = describeAccept(accept);
		const max = maxBytes === undefined ? '' : formatBytes(maxBytes, i18n.locale);
		if (types && max) return t('file.limits', { types, max });
		if (max) return t('file.maxOnly', { max });
		return types;
	});

	function take(list: FileList | null | undefined) {
		if (!list || disabled) return;
		const result = partitionFiles([...list], { accept, maxBytes });
		rejected = result.rejected;
		files = multiple ? [...files, ...result.accepted] : result.accepted.slice(0, 1);
		if (input) input.value = '';
	}

	function remove(index: number) {
		files = files.filter((_, i) => i !== index);
	}
</script>

<div class="drop" class:is-disabled={disabled}>
	<p class="drop__label" id="{uid}-label">{label}</p>
	<div
		class="drop__zone"
		class:is-dragging={dragging}
		role="group"
		aria-labelledby="{uid}-label"
		ondragenter={(event) => {
			event.preventDefault();
			if (!disabled) dragging = true;
		}}
		ondragover={(event) => event.preventDefault()}
		ondragleave={(event) => {
			if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node))
				dragging = false;
		}}
		ondrop={(event) => {
			event.preventDefault();
			dragging = false;
			take(event.dataTransfer?.files);
		}}
	>
		<span class="drop__icon"><Icon name="upload" /></span>
		<p class="drop__text">
			{multiple ? t('file.drop') : t('file.dropOne')}
			<span class="drop__or">{t('file.or')}</span>
			<label class="drop__pick">
				{multiple ? t('file.choose') : t('file.chooseOne')}
				<input
					bind:this={input}
					class="sr-only"
					type="file"
					{accept}
					{multiple}
					{disabled}
					onchange={(event) => take(event.currentTarget.files)}
				/>
			</label>
		</p>
		{#if limits}<p class="drop__limits">{limits}</p>{/if}
	</div>

	{#if rejected.length}
		<ul class="drop__errors" role="alert">
			{#each rejected as item (item.name)}
				<li>
					<Icon name="warningCircle" />
					{item.reason === 'size'
						? t('file.tooLarge', { name: item.name, max: formatBytes(maxBytes ?? 0, i18n.locale) })
						: t('file.wrongType', { name: item.name })}
				</li>
			{/each}
		</ul>
	{/if}

	{#if files.length}
		<ul class="drop__files">
			{#each files as file, index (`${file.name}:${file.size}:${index}`)}
				<li>
					<Icon name="file" />
					<span class="drop__name">{file.name}</span>
					<span class="drop__size">{formatBytes(file.size, i18n.locale)}</span>
					<IconButton
						icon="close"
						label={t('file.remove', { name: file.name })}
						onclick={() => remove(index)}
					/>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.drop {
		display: grid;
		gap: 8px;
	}

	.drop.is-disabled {
		opacity: 0.55;
	}

	.drop__label {
		margin: 0;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
		color: var(--text-secondary);
	}

	.drop__zone {
		display: grid;
		justify-items: center;
		gap: 6px;
		padding: 22px 16px;
		border: 1.5px dashed var(--border-strong);
		border-radius: var(--radius-panel);
		background: var(--bg-subtle);
		text-align: center;
		transition:
			border-color 120ms,
			background 120ms;
	}

	.drop__zone.is-dragging {
		border-color: var(--primary);
		background: var(--bg-hover);
	}

	.drop__icon {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		border-radius: 50%;
		background: var(--bg-card);
		color: var(--text-secondary);
		box-shadow: var(--shadow-sm);
		--icon-size: var(--icon-lg);
	}

	.drop__text {
		margin: 0;
		font-size: var(--fs-body);
		color: var(--text-secondary);
	}

	.drop__or {
		margin: 0 6px;
		color: var(--text-muted);
	}

	.drop__pick {
		color: var(--primary);
		font-weight: var(--fw-semibold);
		text-decoration: underline;
		text-underline-offset: 3px;
		cursor: pointer;
	}

	.drop__pick:has(input:focus-visible) {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
		border-radius: 2px;
	}

	.is-disabled .drop__pick {
		cursor: not-allowed;
	}

	.drop__limits {
		margin: 0;
		font-size: var(--fs-small);
		color: var(--text-muted);
	}

	.drop__errors,
	.drop__files {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.drop__errors li {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: var(--fs-caption);
		color: var(--danger);
		--icon-size: var(--icon-sm);
	}

	.drop__files li {
		display: flex;
		align-items: center;
		gap: 9px;
		padding-block: 4px;
		padding-inline: 10px 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		font-size: var(--fs-body);
		--icon-size: var(--icon-md);
	}

	.drop__name {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.drop__size {
		color: var(--text-muted);
		font-size: var(--fs-caption);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	@media (prefers-reduced-motion: reduce) {
		.drop__zone {
			transition: none;
		}
	}
</style>
