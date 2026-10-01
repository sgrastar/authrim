<script lang="ts">
	import Button from '../primitives/Button.svelte';
	import ColumnBrowser from '../patterns/ColumnBrowser.svelte';
	import { sample } from './sample';

	/** Storybook demo with the SAML attribute templates of the legacy Admin UI. */
	interface Props {
		initialGroup?: string;
		initialItem?: string;
	}

	let { initialGroup = 'academic', initialItem = 'gakunin' }: Props = $props();
	// Seeded from the story args; the browser owns them afterwards.
	let groupId = $derived(initialGroup);
	let itemId = $derived(initialItem);

	const groups = $derived([
		{ id: 'general', label: sample('catGeneral'), icon: 'folder' as const },
		{ id: 'academic', label: sample('catAcademic'), icon: 'graduationCap' as const },
		{ id: 'vendor', label: sample('catVendor'), icon: 'building' as const }
	]);

	const items = [
		{
			id: 'saml-std',
			groupId: 'general',
			label: 'Standard SAML attributes',
			version: 'v1',
			updated: '2026-06-02',
			description: 'Common SAML NameID and attribute release profile for SP assertions.'
		},
		{
			id: 'refeds',
			groupId: 'academic',
			label: 'REFEDS Research and Scholarship',
			version: 'v1',
			updated: '2026-06-02',
			description: 'Attribute bundle for research and scholarship services across federations.'
		},
		{
			id: 'gakunin',
			groupId: 'academic',
			label: 'GakuNin application standard',
			version: 'v2.8',
			updated: '2024-03',
			description:
				'Attributes defined for GakuNin (Japan) service providers, including eduPersonAffiliation values.'
		},
		{
			id: 'kafe',
			groupId: 'academic',
			label: 'KAFE attribute map',
			version: '2023-03-28',
			updated: '2023-03-28',
			description: 'Korean Access Federation attribute map.'
		},
		{
			id: 'ukf',
			groupId: 'academic',
			label: 'UK federation core attributes',
			version: 'TRP 1.5',
			updated: '2026-06-02',
			description:
				'Core attributes from the UK Access Management Federation technical recommendations.'
		},
		{
			id: 'switch',
			groupId: 'academic',
			label: 'Switch edu-ID core attributes',
			version: 'v1',
			updated: '2026-06-02',
			description: 'Core SAML attributes from the Switch edu-ID federation specification.'
		},
		{
			id: 'aaf',
			groupId: 'academic',
			label: 'Australian Access Federation core',
			version: '2024-01-01',
			updated: '2024-01-01',
			description: 'AAF core attributes for Australian research and education services.'
		},
		{
			id: 'enterprise',
			groupId: 'vendor',
			label: 'Enterprise SAML basic',
			version: 'v1',
			updated: '2026-06-02',
			description: 'Minimal attribute set for common enterprise SaaS applications.'
		}
	];
</script>

<ColumnBrowser label={sample('templates')} {groups} {items} bind:groupId bind:itemId>
	{#snippet detail(item)}
		<p
			style="margin:0;color:var(--text-muted);font-size:11.5px;font-weight:700;letter-spacing:0.04em"
		>
			{sample('kind')}
		</p>
		<p style="margin:0;font-size:15px;font-weight:650">{item.label}</p>
		<p style="margin:0;color:var(--text-secondary);font-size:13px;line-height:1.55">
			{item.description}
		</p>
		<dl
			style="display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:4px 0 0;font-size:12.5px"
		>
			<dt style="color:var(--text-muted)">{sample('version')}</dt>
			<dd style="margin:0">{item.version}</dd>
			<dt style="color:var(--text-muted)">{sample('updated')}</dt>
			<dd style="margin:0">{item.updated}</dd>
		</dl>
		<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
			<Button size="sm" variant="ghost">{sample('previewTpl')}</Button>
			<Button size="sm" variant="primary">{sample('useTpl')}</Button>
		</div>
	{/snippet}
</ColumnBrowser>
