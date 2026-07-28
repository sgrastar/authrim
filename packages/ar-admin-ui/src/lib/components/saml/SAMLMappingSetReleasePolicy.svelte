<script lang="ts">
	import type { SAMLDestinationFieldReleaseMode } from '$lib/api/admin-saml';
	import type { SAMLMappingSetReleaseField } from '$lib/saml/mapping-set-release-policy';
	import { getLocale } from '$i18n/i18n-svelte';

	let {
		fields,
		policies,
		loading = false,
		error = '',
		onChange
	}: {
		fields: SAMLMappingSetReleaseField[];
		policies: Record<string, SAMLDestinationFieldReleaseMode>;
		loading?: boolean;
		error?: string;
		onChange: (key: string, mode: SAMLDestinationFieldReleaseMode) => void;
	} = $props();

	function text(ja: string, en: string): string {
		return getLocale() === 'ja' ? ja : en;
	}
</script>

<div class="release-policy">
	<div class="release-policy__header">
		<div>
			<h3>{text('SP属性ポリシー', 'SP attribute policy')}</h3>
			<p>
				{text(
					'このSPへ送信する属性を必須・任意・非表示から選択します。任意属性はconsent画面でユーザーが解除できます。',
					'Choose whether each attribute is required, optional, or hidden. Users can deselect optional attributes on the consent screen.'
				)}
			</p>
		</div>
	</div>

	{#if loading}
		<p class="release-policy__state">{text('属性を読み込んでいます…', 'Loading attributes…')}</p>
	{:else if error}
		<p class="release-policy__state release-policy__state--error">{error}</p>
	{:else if fields.length === 0}
		<p class="release-policy__state">
			{text(
				'選択したMapping Setの有効なSAML Destination属性が見つかりません。',
				'No active SAML destination attributes were found for the selected Mapping Set.'
			)}
		</p>
	{:else}
		<div class="release-policy__table">
			<div class="release-policy__row release-policy__row--header">
				<span>{text('属性', 'Attribute')}</span>
				<span>{text('分類', 'Classification')}</span>
				<span>{text('扱い', 'Release mode')}</span>
			</div>
			{#each fields as field (field.key)}
				<div class="release-policy__row">
					<div class="release-policy__attribute">
						<strong>{field.label}</strong>
						<code>{field.key}</code>
					</div>
					<span class="release-policy__classification">{field.classification || 'internal'}</span>
					<select
						class="admin-select"
						aria-label={text(`${field.label} の送信区分`, `${field.label} release mode`)}
						value={policies[field.key] || 'optional'}
						onchange={(event) =>
							onChange(
								field.key,
								(event.currentTarget as HTMLSelectElement).value as SAMLDestinationFieldReleaseMode
							)}
					>
						<option value="required">{text('必須', 'Required')}</option>
						<option value="optional">{text('任意', 'Optional')}</option>
						<option value="hidden">{text('非表示', 'Hidden')}</option>
					</select>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.release-policy {
		width: 100%;
		border: 1px solid var(--color-border);
		border-radius: 12px;
		overflow: hidden;
		background: var(--color-surface);
	}

	.release-policy__header {
		padding: 16px 18px;
		border-bottom: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-surface) 92%, var(--color-primary) 8%);
	}

	.release-policy__header h3 {
		margin: 0 0 4px;
		font-size: 15px;
	}

	.release-policy__header p,
	.release-policy__state {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 13px;
		line-height: 1.5;
	}

	.release-policy__state {
		padding: 18px;
	}

	.release-policy__state--error {
		color: var(--color-danger);
	}

	.release-policy__table {
		overflow-x: auto;
	}

	.release-policy__row {
		display: grid;
		grid-template-columns: minmax(280px, 1fr) 140px 180px;
		gap: 14px;
		align-items: center;
		min-width: 680px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--color-border);
	}

	.release-policy__row:last-child {
		border-bottom: 0;
	}

	.release-policy__row--header {
		color: var(--color-text-muted);
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
	}

	.release-policy__attribute {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.release-policy__attribute code {
		overflow: hidden;
		color: var(--color-text-muted);
		font-size: 11px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.release-policy__classification {
		font-size: 12px;
		text-transform: capitalize;
	}
</style>
