<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Disclosure from '../patterns/Disclosure.svelte';
	import Badge from '../primitives/Badge.svelte';
	import NumberField from '../primitives/NumberField.svelte';
	import TextField from '../primitives/TextField.svelte';
	import { Draft } from '../save/draft.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import { localized } from './sample';

	/** Storybook demo: rarely used options folded away inside a settings form. */
	interface Props {
		/** Framed (a form's Advanced part). */
		boxed?: boolean;
		/** Values inside that differ from the default, counted on the heading. */
		overridden?: number;
	}

	let { boxed = false, overridden = 0 }: Props = $props();

	const form = new Draft({ issuer: 'https://id.example.com', skew: 60 as number | null });
</script>

<SaveScope draft={form} onsave={() => Promise.resolve()} bar={false}>
	<div style="display:grid;gap:14px;max-width:520px">
		<TextField
			label={localized(['発行者', 'Issuer', 'Aussteller', 'المُصدر'])}
			field="issuer"
			bind:value={form.value.issuer}
		/>
		<Disclosure
			{boxed}
			title={localized([
				'詳細設定',
				'Advanced settings',
				'Erweiterte Einstellungen',
				'إعدادات متقدمة'
			])}
			description={localized([
				'通常は変更不要です',
				'Rarely needs changing',
				'Muss selten geändert werden',
				'نادرًا ما يلزم تغييرها'
			])}
		>
			{#snippet meta()}
				{#if overridden > 0}<Badge>{t('settings.setHere', { n: overridden })}</Badge>{/if}
			{/snippet}
			<NumberField
				label={localized([
					'許容する時刻のずれ',
					'Allowed clock skew',
					'Erlaubte Zeitabweichung',
					'فرق الساعة المسموح'
				])}
				unit={localized(['秒', 'seconds', 'Sekunden', 'ثوانٍ'])}
				field="skew"
				min={0}
				max={600}
				bind:value={form.value.skew}
			/>
		</Disclosure>
	</div>
</SaveScope>
