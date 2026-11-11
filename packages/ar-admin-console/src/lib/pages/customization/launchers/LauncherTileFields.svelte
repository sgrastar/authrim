<script lang="ts">
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CheckRow from '#lib/ui/patterns/CheckRow.svelte';
	import Columns from '#lib/ui/patterns/Columns.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import TextAreaRow from '#lib/ui/patterns/TextAreaRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import ColorField from '#lib/ui/primitives/ColorField.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import Slider from '#lib/ui/primitives/Slider.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import LauncherIconPicker from './LauncherIconPicker.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import {
		BACKGROUND_PRESETS,
		TILE_PRESETS,
		GRID_COLUMNS,
		LIMITS,
		type LauncherEditorValue,
		type ProblemField
	} from './launcher-model';

	/**
	 * How a launcher's tile looks: its icon (one of the allowed Phosphor icons in the tile's
	 * colours, or a picture), the background and icon colours (the icon colour checked for
	 * contrast against the background), the description and category under the name, how many
	 * of the account page's eight columns it spans, and whether users may star it.
	 */
	interface Props {
		value: LauncherEditorValue;
		icons: readonly string[];
		/** Categories other launchers use, offered while typing. */
		categories: readonly string[];
		errors: Partial<Record<ProblemField, MessageKey>>;
		disabled?: boolean;
	}

	let { value = $bindable(), icons, categories, errors, disabled = false }: Props = $props();

	const uid = $props.id();
	const iconChoices = $derived(
		icons.includes(value.iconName) || !value.iconName ? icons : [value.iconName, ...icons]
	);
</script>

<Card title={t('ln.card.tile')}>
	<RowStack>
		<FieldRow label={t('ln.field.icon')} align="text" plain>
			<div class="tile-fields__icon">
				<SegmentedControl
					label={t('ln.field.iconKind')}
					size="sm"
					field="iconType"
					{disabled}
					value={value.iconType}
					options={[
						{ value: 'phosphor', label: t('ln.field.iconPhosphor') },
						{ value: 'image', label: t('ln.field.iconImage') }
					]}
					onchange={(next) => (value.iconType = next === 'image' ? 'image' : 'phosphor')}
				/>
				{#if value.iconType === 'phosphor'}
					<LauncherIconPicker
						label={t('ln.field.icon')}
						icons={iconChoices}
						background={value.backgroundColor}
						color={value.iconColor}
						field="iconName"
						{disabled}
						bind:value={value.iconName}
					/>
				{:else}
					<TextField
						label={t('ln.field.imageUrl')}
						type="url"
						placeholder="https://"
						required
						maxlength={LIMITS.url}
						hint={t('ln.field.imageHint')}
						field="imageUrl"
						error={errors.imageUrl ? t(errors.imageUrl) : undefined}
						{disabled}
						bind:value={value.imageUrl}
					/>
				{/if}
			</div>
		</FieldRow>

		<FieldRow label={t('ln.field.colors')} align="text" plain>
			<Columns columns={2} minWidth="180px">
				<ColorField
					label={t('ln.field.background')}
					presets={BACKGROUND_PRESETS}
					required
					field="backgroundColor"
					{disabled}
					bind:value={value.backgroundColor}
				/>
				{#if value.iconType === 'phosphor'}
					<ColorField
						label={t('ln.field.iconColor')}
						contrastWith={value.backgroundColor}
						contrastLabel={t('ln.field.background')}
						minContrast={3}
						required
						field="iconColor"
						{disabled}
						bind:value={value.iconColor}
					/>
				{/if}
			</Columns>
			{#if errors.colors}
				<p class="tile-fields__error" role="alert">{t(errors.colors)}</p>
			{/if}
		</FieldRow>

		<FieldRow label={t('ln.field.tileBackground')} align="text" plain>
			<div class="tile-fields__tile">
				<Checkbox field="tileColored" {disabled} bind:checked={value.tileColored}
					>{t('ln.field.tileColored')}</Checkbox
				>
				{#if value.tileColored}
					<ColorField
						label={t('ln.field.tileColor')}
						presets={TILE_PRESETS}
						required
						hint={t('ln.field.tileColorHint')}
						field="tileBackground"
						{disabled}
						bind:value={value.tileBackground}
					/>
				{/if}
			</div>
		</FieldRow>

		<TextAreaRow
			label={t('ln.field.description')}
			rows={2}
			maxlength={LIMITS.description}
			field="description"
			{disabled}
			bind:value={value.description}
		/>

		<TextRow
			label={t('ln.field.category')}
			info={t('ln.field.categoryInfo')}
			maxlength={LIMITS.category}
			list="{uid}-categories"
			autocomplete="off"
			field="category"
			{disabled}
			bind:value={value.category}
		/>
		<datalist id="{uid}-categories">
			{#each categories as category (category)}<option value={category}></option>{/each}
		</datalist>

		<FieldRow label={t('ln.field.width')} info={t('ln.field.widthInfo')} plain>
			<Slider
				label={t('ln.field.width')}
				min={1}
				max={GRID_COLUMNS}
				step={1}
				ticks={1}
				tickLabels
				snapToTicks
				showValue
				compact
				unit={t('ln.field.widthUnit')}
				field="gridWidth"
				{disabled}
				bind:value={value.gridWidth}
			/>
		</FieldRow>

		<CheckRow
			label={t('ln.field.favorite')}
			text={t('ln.field.allowFavorite')}
			field="allowFavorite"
			{disabled}
			bind:checked={value.allowFavorite}
		/>
	</RowStack>
</Card>

<style>
	.tile-fields__icon {
		display: grid;
		gap: var(--space-related);
		justify-items: start;
		min-inline-size: 0;
	}

	.tile-fields__tile {
		display: grid;
		gap: var(--space-related);
		justify-items: start;
		min-inline-size: 0;
	}

	.tile-fields__error {
		margin: var(--space-related) 0 0;
		color: var(--danger);
		font-size: var(--fs-caption);
	}

	.tile-fields__icon > :global(:last-child) {
		justify-self: stretch;
	}
</style>
