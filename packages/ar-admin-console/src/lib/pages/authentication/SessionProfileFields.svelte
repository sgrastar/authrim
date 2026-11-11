<script lang="ts">
	import type { SessionProfileValues } from '#lib/api/session-profiles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { formatSetting } from '#lib/settings/setting-format.js';
	import { settingText } from '#lib/settings/setting-text.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import OnOff from '#lib/ui/primitives/OnOff.svelte';
	import DurationField from '#lib/ui/primitives/DurationField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import {
		SESSION_LENGTH_KEYS,
		SESSION_METHOD_LENGTH_KEYS,
		SESSION_PROFILE_KEYS,
		SESSION_SWITCH_KEYS,
		msToSeconds,
		sessionSettingMeta
	} from './session-profile-fields';

	/**
	 * A session profile's settings: how long a session lasts (the per-method lengths under
	 * Advanced), whether it can be extended, and single sign-on. Lengths are kept in milliseconds,
	 * as the Settings API has them, and edited in seconds and up.
	 *
	 * A saved profile may leave a setting out: it then follows the Default profile (the tenant's
	 * settings), shown and chosen as such. Default itself has every setting: none is left empty.
	 */
	interface Props {
		values: SessionProfileValues;
		canWrite: boolean;
		/** The Default profile (the tenant's own settings), not a saved one. */
		isDefault?: boolean;
		onchange: (key: string, value: unknown) => void;
		/** Some value cannot be saved as it is (out of range, or empty on Default). */
		invalid?: boolean;
	}

	let {
		values,
		canWrite,
		isDefault = false,
		onchange,
		invalid = $bindable(false)
	}: Props = $props();

	let invalidKeys = $state<Record<string, boolean>>({});
	let emptyKeys = $state<Record<string, boolean>>({});
	$effect(() => {
		invalid = SESSION_PROFILE_KEYS.some((key) => invalidKeys[key] || emptyKeys[key]);
	});

	const INHERIT = 'inherit';
	const label = (key: string) => t(settingText(key).label);
	const info = (key: string) => {
		const description = settingText(key).description;
		return description ? t(description) : undefined;
	};
	const limit = (key: string, which: 'min' | 'max') => {
		const value = sessionSettingMeta(key)?.[which];
		return typeof value === 'number' ? value / 1000 : undefined;
	};
	const leftOut = (key: string) => values[key] === undefined;

	function setLength(key: string, seconds: number | null) {
		if (seconds === null && isDefault) {
			// Default is the tenant's own setting: it is never left empty.
			emptyKeys = { ...emptyKeys, [key]: true };
			return;
		}
		emptyKeys = { ...emptyKeys, [key]: false };
		onchange(key, seconds === null ? undefined : Math.round(seconds * 1000));
	}
</script>

{#snippet asDefault()}<span class="session-fields__inherit">{t('sp.fields.asDefault')}</span
	>{/snippet}

{#snippet length(key: string)}
	<FieldRow label={label(key)} info={info(key)}>
		{#if canWrite}
			<DurationField
				label={label(key)}
				hideLabel
				total={false}
				units={['minutes', 'hours', 'days']}
				min={limit(key, 'min')}
				max={limit(key, 'max')}
				required={isDefault}
				hint={isDefault ? undefined : t('sp.fields.emptyAsDefault')}
				error={emptyKeys[key] ? t('sp.fields.required') : undefined}
				bind:invalid={() => invalidKeys[key] ?? false, (bad) => (invalidKeys[key] = bad)}
				bind:value={() => msToSeconds(values[key]), (seconds) => setLength(key, seconds)}
			/>
		{:else if leftOut(key)}
			{@render asDefault()}
		{:else}
			<span>{formatSetting(key, sessionSettingMeta(key), values[key])}</span>
		{/if}
	</FieldRow>
{/snippet}

<div class="session-fields">
	<Card title={t('sp.fields.length')} description={t('sp.fields.lengthDesc')}>
		{#each SESSION_LENGTH_KEYS as key (key)}{@render length(key)}{/each}
		<Disclosure title={t('sp.fields.perMethod')} description={t('sp.fields.perMethodDesc')} boxed>
			{#each SESSION_METHOD_LENGTH_KEYS as key (key)}{@render length(key)}{/each}
		</Disclosure>
	</Card>
	<Card title={t('sp.fields.behaviour')}>
		{#each SESSION_SWITCH_KEYS as key (key)}
			<FieldRow label={label(key)} info={info(key)}>
				{#if canWrite}
					<Select
						label={label(key)}
						hideLabel
						options={[
							{ value: 'true', label: t('settings.value.on') },
							{ value: 'false', label: t('settings.value.off') },
							...(isDefault ? [] : [{ value: INHERIT, label: t('sp.fields.asDefault') }])
						]}
						bind:value={
							() =>
								leftOut(key) && !isDefault ? INHERIT : values[key] === true ? 'true' : 'false',
							(next) => onchange(key, next === INHERIT ? undefined : next === 'true')
						}
					/>
				{:else if leftOut(key)}
					{@render asDefault()}
				{:else}
					<OnOff on={values[key] === true} />
				{/if}
			</FieldRow>
		{/each}
	</Card>
</div>

<style>
	.session-fields {
		display: grid;
		gap: var(--space-section);
	}

	.session-fields__inherit {
		color: var(--text-muted);
	}
</style>
