<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import SegmentedControl from '../primitives/SegmentedControl.svelte';
	import Toggle from '../primitives/Toggle.svelte';
	import DateTime from './DateTime.svelte';
	import { timePreference } from './time-preference.svelte';

	/**
	 * Per-admin date/time display: UTC or local, and whether to show the other one alongside.
	 * Both apply immediately, so the secondary zone is a toggle; its label names what would be
	 * added, so it reads correctly for either choice.
	 */
	interface Props {
		/** A timestamp to preview the choice with. */
		example?: string;
	}

	let { example = '2026-09-26T05:05:00Z' }: Props = $props();
</script>

<div class="time-settings">
	<SegmentedControl
		label={t('time.zone')}
		hideLabel={false}
		size="sm"
		block
		value={timePreference.zone}
		options={[
			{ value: 'local', label: t('time.local') },
			{ value: 'utc', label: t('time.utc') }
		]}
		onchange={(value) => timePreference.setZone(value === 'utc' ? 'utc' : 'local')}
	/>
	<div class="time-settings__row">
		<span class="time-settings__label" aria-hidden="true">
			{timePreference.zone === 'utc' ? t('time.alsoLocal') : t('time.alsoUtc')}
		</span>
		<Toggle
			label={timePreference.zone === 'utc' ? t('time.alsoLocal') : t('time.alsoUtc')}
			checked={timePreference.showSecondary}
			onchange={(checked) => timePreference.setShowSecondary(checked)}
		/>
	</div>
	<p class="time-settings__example">
		<span>{t('time.example')}</span>
		<DateTime value={example} stacked />
	</p>
</div>

<style>
	.time-settings {
		display: grid;
		gap: 10px;
	}

	.time-settings__row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.time-settings__label {
		font-size: var(--fs-body);
		font-weight: var(--fw-name);
	}

	.time-settings__example {
		display: grid;
		gap: 3px;
		margin: 0;
		padding: 8px 10px;
		border-radius: var(--radius-control);
		background: var(--bg-subtle);
		font-size: var(--fs-label);
	}

	.time-settings__example > span {
		color: var(--text-muted);
		font-size: var(--fs-small);
	}
</style>
