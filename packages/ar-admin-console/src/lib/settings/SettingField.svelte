<script lang="ts">
	import type { SettingMeta } from '@authrim/ar-lib-core/utils/settings-manager';
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import FieldRow from '$lib/ui/patterns/FieldRow.svelte';
	import OnOff from '$lib/ui/primitives/OnOff.svelte';
	import Checkbox from '$lib/ui/primitives/Checkbox.svelte';
	import DurationField from '$lib/ui/primitives/DurationField.svelte';
	import NumberField from '$lib/ui/primitives/NumberField.svelte';
	import { DURATION_UNITS } from '$lib/ui/primitives/number-input';
	import Select from '$lib/ui/primitives/Select.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import { useChangeMark } from '$lib/ui/save/save-scope';
	import { formatSetting } from './setting-format';
	import { settingText } from './setting-text';
	import { fieldOf, type Entry, type FallbackSource } from './settings-model';

	/**
	 * One Settings API setting that the admin may change, as a row: its name (what it does
	 * behind a "?") on the start side; on the end side "Override" with the default beside it
	 * ("Platform default: 1 day"), and the value under them.
	 *
	 * The value can be changed once "Override" is checked, so a setting is never overridden
	 * by accident; unchecking goes back to the default. An on/off
	 * setting takes its value from a list (On / Off), so two checkboxes never sit together.
	 *
	 * A setting the scope above has fixed shows why (a lock and "Fixed by the platform") and
	 * its value as text: nothing to check, nothing that looks editable.
	 */
	interface Props {
		key: string;
		meta: SettingMeta;
		entry: Entry;
		/** What applies while it is not set here. */
		fallback: { value: unknown; source: FallbackSource };
		/**
		 * The scope being set. What applies otherwise comes from the scope above it: the
		 * platform's default for a tenant, the tenant's for an app.
		 */
		level: 'platform' | 'tenant' | 'client';
		/** Why the API refused the value last saved. */
		error?: string;
		/** Allow decimals in a number. */
		decimal?: boolean;
	}

	let { key, meta, entry = $bindable(), fallback, level, error, decimal = false }: Props = $props();

	const field = $derived(fieldOf(key));
	const text = $derived(settingText(key));
	const label = $derived(t(text.label));
	const hint = $derived(text.description ? t(text.description) : undefined);
	const fallbackText = $derived.by(() => {
		const value = formatSetting(key, meta, fallback.value);
		if (level === 'tenant') return t('settings.defaultFrom.platform', { value });
		if (level === 'client') return t('settings.defaultFrom.tenant', { value });
		return t('inherit.defaultIs', { value });
	});

	// Durations in milliseconds show in whole seconds and up, unless the setting allows less.
	const inMs = $derived(meta.unit === 'ms');
	const asDuration = $derived(meta.type === 'duration' && (!inMs || (meta.min ?? 0) >= 1000));
	const toSeconds = (ms: number | undefined) =>
		ms === undefined ? undefined : inMs ? ms / 1000 : ms;
	const units = $derived(
		DURATION_UNITS.filter((u) => meta.max === undefined || u.seconds <= toSeconds(meta.max)!).map(
			(u) => u.id
		)
	);

	// The draft holds the API's value (milliseconds); the duration control works in seconds, so
	// the change mark compares the API values here rather than letting the control do it.
	const marks = useChangeMark();
	const changed = $derived(marks.changed(`${field}.v`, entry.v));

	function setHere(on: boolean): void {
		entry.here = on;
		if (!on) entry.v = fallback.value;
	}

	const lockedText = $derived(
		level === 'client' ? t('settings.locked.tenant') : t('settings.locked.platform')
	);

	const numberOf = (value: unknown) => (typeof value === 'number' ? value : null);
	const inherited = $derived(!entry.here);
</script>

<FieldRow {label} info={hint} align="text">
	{#if entry.locked}
		<div class="setting">
			<p class="setting__locked">
				<span class="setting__lock" aria-hidden="true"><Icon name="lock" /></span>{lockedText}
			</p>
			<p class="setting__value">
				{#if meta.type === 'boolean'}
					<OnOff on={entry.v === true} />
				{:else}
					{formatSetting(key, meta, entry.v)}
				{/if}
			</p>
		</div>
	{:else}
		<div class="setting">
			<div class="setting__choice">
				<Checkbox
					size="sm"
					field="{field}.here"
					bind:checked={() => entry.here, (on) => setHere(on)}
					>{t('settings.setHereOption')}<span class="sr-only">: {label}</span></Checkbox
				>
				<span class="setting__default">{fallbackText}</span>
			</div>
			<div class="setting__control">
				{#if meta.type === 'boolean'}
					<Select
						{label}
						hideLabel
						{changed}
						disabled={inherited}
						options={[
							{ value: 'true', label: t('settings.value.on') },
							{ value: 'false', label: t('settings.value.off') }
						]}
						bind:value={
							() => (entry.v === true ? 'true' : 'false'), (next) => (entry.v = next === 'true')
						}
					/>
				{:else if asDuration}
					<DurationField
						{label}
						hideLabel
						{error}
						{changed}
						{units}
						total={false}
						disabled={inherited}
						min={toSeconds(meta.min)}
						max={toSeconds(meta.max)}
						bind:value={
							() => (typeof entry.v === 'number' ? toSeconds(entry.v)! : null),
							(seconds) => (entry.v = seconds === null ? null : inMs ? seconds * 1000 : seconds)
						}
					/>
				{:else if meta.type === 'duration' || meta.type === 'number'}
					<NumberField
						{label}
						hideLabel
						{error}
						{changed}
						{decimal}
						unit={inMs ? 'ms' : undefined}
						disabled={inherited}
						min={meta.min}
						max={meta.max}
						bind:value={() => numberOf(entry.v), (next) => (entry.v = next)}
					/>
				{:else if meta.type === 'enum'}
					<Select
						{label}
						hideLabel
						{error}
						{changed}
						disabled={inherited}
						options={(meta.enum ?? []).map((choice) => ({
							value: choice,
							label: t(text.choice(choice))
						}))}
						bind:value={() => String(entry.v ?? ''), (next) => (entry.v = next)}
					/>
				{:else}
					<TextField
						{label}
						hideLabel
						{error}
						{changed}
						disabled={inherited}
						bind:value={() => String(entry.v ?? ''), (next) => (entry.v = next)}
					/>
				{/if}
			</div>
		</div>
	{/if}
</FieldRow>

<style>
	.setting {
		display: grid;
		gap: 8px;
		min-width: 0;
	}

	/* "Set for this tenant" and, beside it, what applies otherwise. */
	.setting__choice {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 16px;
	}

	.setting__default {
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	/* Fixed above: why, then the value as text where the control would be. */
	.setting__locked {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-caption);
	}

	.setting__lock {
		display: inline-flex;
		color: var(--text-muted);
		--icon-size: var(--icon-sm);
	}

	.setting__value {
		margin: 0;
		color: var(--text-primary);
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	/* Lists and text as wide as a duration field, not the whole column. */
	.setting__control {
		width: min(16rem, 100%);
	}
</style>
