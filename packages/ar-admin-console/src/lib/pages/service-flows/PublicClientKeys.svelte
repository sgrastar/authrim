<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import type { RpForm } from './connection-model';
	import { publicKeyProblem } from './public-client-keys';
	let { form = $bindable() }: { form: RpForm } = $props();
</script>

<Callout tone="info">{t('cs.live.publicOnly')}</Callout>
<SelectRow
	label={t('cs.live.keySource')}
	value={form.keySource ?? 'uri'}
	options={[
		{ value: 'uri', label: t('cs.live.sourceUrl') },
		{ value: 'inline', label: t('cs.live.sourceInline') }
	]}
	onchange={(value) => {
		if (value === 'uri' || value === 'inline') form.keySource = value;
	}}
/>
{#if form.keySource === 'inline'}
	<TextArea
		label={t('cs.live.publicJwks')}
		mono
		maxlength={65536}
		value={form.publicJwks ?? ''}
		oninput={(event) => (form.publicJwks = event.currentTarget.value)}
		error={publicKeyProblem(form)}
	/>
{:else}
	<TextRow
		label={t('cs.row.jwksUri')}
		value={form.jwksUri ?? ''}
		oninput={(event) => (form.jwksUri = event.currentTarget.value)}
		error={publicKeyProblem(form)}
		placeholder="https://app.example.com/.well-known/jwks.json"
		maxlength={2048}
	/>
{/if}
