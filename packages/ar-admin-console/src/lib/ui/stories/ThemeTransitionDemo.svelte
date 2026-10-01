<script lang="ts">
	import Badge from '../primitives/Badge.svelte';
	import Button from '../primitives/Button.svelte';
	import Toggle from '../primitives/Toggle.svelte';
	import Callout from '../patterns/Callout.svelte';
	import Card from '../patterns/Card.svelte';
	import PageHeader from '../patterns/PageHeader.svelte';
	import SettingRow from '../patterns/SettingRow.svelte';
	import { applyThemeAttributes } from '../theme/theme-config';
	import { playSchemeTransition } from '../theme/theme.svelte';
	import { sample } from './sample';

	/**
	 * Storybook demo of the light ↔ dark transition from the redesign mock: colour tokens
	 * interpolate (1.8 s, eased at both ends) under one wash (2.28 s).
	 */
	let scheme = $state<'light' | 'dark'>(
		typeof document !== 'undefined' && document.documentElement.dataset.scheme === 'dark'
			? 'dark'
			: 'light'
	);

	function flip() {
		const root = document.documentElement;
		const next = scheme === 'dark' ? 'light' : 'dark';
		playSchemeTransition(root, next, () =>
			applyThemeAttributes(root, next, next, root.dataset.adminTheme ?? 'standard')
		);
		scheme = next;
	}
</script>

<div style="display:grid;gap:16px;max-width:760px">
	<div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px">
		<Button variant="primary" icon={scheme === 'dark' ? 'sun' : 'moon'} onclick={flip}>
			{scheme === 'dark' ? sample('toLight') : sample('toDark')}
		</Button>
		<span style="color:var(--text-muted);font-size:12.5px">{sample('transitionNote')}</span>
	</div>
	<PageHeader title={sample('authMethodsTitle')} description={sample('authMethodsDesc')} />
	<Callout tone="warning" title={sample('requiredTitle')}>{sample('requiredBody')}</Callout>
	<Card title={sample('state')} flush>
		<SettingRow icon="plug" title={sample('enableFlow')} description={sample('appliesNow')}>
			{#snippet meta()}<Badge tone="success" dot>{sample('enabled')}</Badge>{/snippet}
			<Toggle label={sample('enableFlow')} checked />
		</SettingRow>
	</Card>
</div>
