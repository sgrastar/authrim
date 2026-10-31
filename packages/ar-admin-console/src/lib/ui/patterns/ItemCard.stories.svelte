<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../stories/subcomponents';
	import { t } from '$lib/i18n/i18n.svelte';
	import Badge from '../primitives/Badge.svelte';
	import IconButton from '../primitives/IconButton.svelte';
	import DateTime from '../time/DateTime.svelte';
	import Card from './Card.svelte';
	import DetailItem from './DetailItem.svelte';
	import DetailList from './DetailList.svelte';
	import ItemCard from './ItemCard.svelte';
	import ItemGrid from './ItemGrid.svelte';
	import PluginsDemo from '../stories/PluginsDemo.svelte';
	import SocialProvidersDemo from '../stories/SocialProvidersDemo.svelte';

	// The props table's main tab (see named()).
	named(ItemCard, 'ItemCard');

	const { Story } = defineMeta({
		title: 'Patterns/Item cards',
		component: ItemCard,
		subcomponents: subcomponents({ ItemGrid }),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'A short collection shown as cards — passkeys, connected devices, API keys. Each card: name and marks on top, its own actions at the end, a few facts below (a small `DetailList`). `ItemGrid` fits as many columns as there is room for and is a list for screen readers. Use cards when there are only a handful of items and each is looked at on its own; use `DataTable` when items are compared, sorted or many.\n\nA card can carry an icon — or an `image` such as a product logo, shown on a light tile that stays light in dark schemes — marks next to the name (`meta`), actions at the end — icon buttons, or a `Toggle` when switching the item on or off applies at once — a sentence on what it is (`description`), facts (`children`) and a `footer` for its state and one follow-up action; footers line up across a row. `ItemGrid columns={2|3}` caps the columns; fewer are used when a card would get narrower than `minWidth`.'
				}
			}
		}
	});

	const passkeys = [
		{
			id: 'a',
			name: 'Work MacBook',
			provider: 'iCloud Keychain',
			created: '2026-02-06T00:00:00Z',
			used: '2026-09-25T19:00:00Z'
		},
		{ id: 'b', name: 'YubiKey 5C', provider: null, created: '2026-05-07T00:00:00Z', used: null }
	];
</script>

<Story name="Passkeys">
	{#snippet template()}
		<Card title={t('me.passkeys')} description={t('me.passkeysDesc')}>
			<ItemGrid label={t('me.passkeys')}>
				{#each passkeys as passkey (passkey.id)}
					<ItemCard title={passkey.name} icon="fingerprint">
						{#snippet meta()}
							{#if passkey.provider}<Badge>{passkey.provider}</Badge>{/if}
						{/snippet}
						{#snippet actions()}
							<IconButton icon="pencil" label="{t('me.passkey.rename')}: {passkey.name}" />
							<IconButton icon="trash" label="{t('me.passkey.delete')}: {passkey.name}" />
						{/snippet}
						<DetailList size="sm">
							<DetailItem label={t('me.passkey.created')}
								><DateTime value={passkey.created} /></DetailItem
							>
							<DetailItem label={t('me.passkey.lastUsed')}>
								{#if passkey.used}<DateTime value={passkey.used} />{:else}{t(
										'me.passkey.never'
									)}{/if}
							</DetailItem>
						</DetailList>
					</ItemCard>
				{/each}
			</ItemGrid>
		</Card>
	{/snippet}
</Story>

<Story name="Only one left">
	{#snippet template()}
		<Card title={t('me.passkeys')}>
			<ItemGrid label={t('me.passkeys')}>
				<ItemCard title="YubiKey 5C" icon="fingerprint">
					{#snippet meta()}<Badge tone="info">{t('me.passkey.only')}</Badge>{/snippet}
					{#snippet actions()}
						<IconButton icon="pencil" label="{t('me.passkey.rename')}: YubiKey 5C" />
						<IconButton icon="trash" label="{t('me.passkey.delete')}: YubiKey 5C" disabled />
					{/snippet}
					<DetailList size="sm">
						<DetailItem label={t('me.passkey.created')}
							><DateTime value="2026-05-07T00:00:00Z" /></DetailItem
						>
						<DetailItem label={t('me.passkey.lastUsed')}>{t('me.passkey.never')}</DetailItem>
					</DetailList>
				</ItemCard>
			</ItemGrid>
		</Card>
	{/snippet}
</Story>

<Story name="Plugins, three columns">
	{#snippet template()}<PluginsDemo columns={3} />{/snippet}
</Story>

<Story name="Plugins, two columns">
	{#snippet template()}<PluginsDemo columns={2} />{/snippet}
</Story>

<Story name="With logos">
	{#snippet template()}<SocialProvidersDemo />{/snippet}
</Story>
