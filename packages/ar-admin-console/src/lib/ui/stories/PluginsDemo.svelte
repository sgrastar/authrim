<script lang="ts">
	import type { IconName } from '../icons/icons';
	import InlineGroup from '../patterns/InlineGroup.svelte';
	import ItemCard from '../patterns/ItemCard.svelte';
	import ItemGrid from '../patterns/ItemGrid.svelte';
	import Badge from '../primitives/Badge.svelte';
	import Button from '../primitives/Button.svelte';
	import Toggle from '../primitives/Toggle.svelte';
	import { sample, type SampleKey } from './sample';

	/**
	 * Storybook demo after the legacy plugin list: icon, name and marks, an on/off switch
	 * (it applies at once), what the plugin does, what it provides, and its health.
	 */
	interface Props {
		columns?: 2 | 3;
	}

	let { columns = 3 }: Props = $props();

	interface Plugin {
		id: string;
		name: string;
		icon: IconName;
		release: SampleKey;
		description: SampleKey;
		provides: string[];
		configured: boolean;
	}

	const PLUGINS: Plugin[] = [
		{
			id: 'cf-email',
			name: 'Cloudflare Email Service',
			icon: 'mail',
			release: 'pluginBeta',
			description: 'pluginEmailDesc',
			provides: ['notifier.email'],
			configured: true
		},
		{
			id: 'turnstile',
			name: 'Cloudflare Turnstile',
			icon: 'shield',
			release: 'pluginBeta',
			description: 'pluginHumanDesc',
			provides: ['human_verification.turnstile'],
			configured: false
		},
		{
			id: 'console',
			name: 'Console Notifier',
			icon: 'plug',
			release: 'pluginStable',
			description: 'pluginConsoleDesc',
			provides: ['notifier.email', 'notifier.sms', 'notifier.push'],
			configured: true
		},
		{
			id: 'recaptcha',
			name: 'Google reCAPTCHA',
			icon: 'shield',
			release: 'pluginBeta',
			description: 'pluginHumanDesc',
			provides: ['human_verification.recaptcha'],
			configured: false
		},
		{
			id: 'hcaptcha',
			name: 'hCaptcha',
			icon: 'shield',
			release: 'pluginBeta',
			description: 'pluginHumanDesc',
			provides: ['human_verification.hcaptcha'],
			configured: false
		},
		{
			id: 'resend',
			name: 'Resend Email',
			icon: 'mail',
			release: 'pluginStable',
			description: 'pluginResendDesc',
			provides: ['notifier.email'],
			configured: false
		}
	];

	let enabled = $state<Record<string, boolean>>({ 'cf-email': true });
</script>

<ItemGrid label={sample('plugins')} {columns} minWidth="260px">
	{#each PLUGINS as plugin (plugin.id)}
		<ItemCard title={plugin.name} icon={plugin.icon} description={sample(plugin.description)}>
			{#snippet meta()}
				<Badge>{sample('pluginOfficial')}</Badge>
				<Badge>{sample(plugin.release)}</Badge>
			{/snippet}
			{#snippet actions()}
				<Toggle
					label="{sample('enabled')}: {plugin.name}"
					checked={enabled[plugin.id] ?? false}
					onchange={(on) => (enabled[plugin.id] = on)}
				/>
			{/snippet}
			<InlineGroup>
				{#each plugin.provides as capability (capability)}<Badge>{capability}</Badge>{/each}
			</InlineGroup>
			{#snippet footer()}
				<span>{plugin.configured ? sample('pluginNoHealth') : sample('pluginNeedsConfig')}</span>
				<Button size="sm" variant="ghost">{sample('pluginCheckHealth')}</Button>
			{/snippet}
		</ItemCard>
	{/each}
</ItemGrid>
