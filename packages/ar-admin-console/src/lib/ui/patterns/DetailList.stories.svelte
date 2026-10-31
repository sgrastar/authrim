<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { named, subcomponents } from '../stories/subcomponents';
	import { t } from '$lib/i18n/i18n.svelte';
	import Badge from '../primitives/Badge.svelte';
	import CopyButton from '../primitives/CopyButton.svelte';
	import DateTime from '../time/DateTime.svelte';
	import Card from './Card.svelte';
	import DetailItem from './DetailItem.svelte';
	import DetailList from './DetailList.svelte';
	import InlineGroup from './InlineGroup.svelte';
	import OnOff from '../primitives/OnOff.svelte';

	// The props table's main tab (see named()).
	named(DetailList, 'DetailList');

	const { Story } = defineMeta({
		title: 'Patterns/Detail list',
		component: DetailList,
		subcomponents: subcomponents({ DetailItem, InlineGroup, OnOff }),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Read-only facts as label/value pairs (a `<dl>`): account details, a record’s properties. Labels sit in one column so values line up; on phones each label moves above its value. Editable values belong in a form, not here.\n\n**Ruled** (`ruled`) is a quiet table for values someone may only look at, such as settings in view-only access: rows divided by a line, no vertical lines, the value stronger than its name, on/off with `OnOff`, and a badge only where a value is not the default.\n\n**A control at the end of the row** (`end` on `DetailItem`) is for a value to hand on, such as a copy button. It sits at the end edge of the row, level with the value, and not right after the text, so the buttons of a list line up whatever the length of each value.'
				}
			}
		}
	});
</script>

<Story name="Account">
	{#snippet template()}
		<Card title={t('me.profile')}>
			<DetailList>
				<DetailItem label={t('me.name')}>Dev Admin</DetailItem>
				<DetailItem label={t('me.email')}>dev-admin@example.com</DetailItem>
				<DetailItem label={t('me.roles')}>
					<InlineGroup><Badge>platform_admin</Badge><Badge>tenant_admin</Badge></InlineGroup>
				</DetailItem>
				<DetailItem label={t('me.scope')}>{t('me.scopePlatform')}</DetailItem>
				<DetailItem label={t('me.lastSignIn')}><DateTime value="2026-09-25T23:40:00Z" /></DetailItem
				>
			</DetailList>
		</Card>
	{/snippet}
</Story>

<!-- A value to hand on: the copy button is at the end of the row, so the buttons line up. -->
<Story
	name="Copy button at the end"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const buttons = canvas.getAllByRole('button', { name: /^Copy / });
		await expect(buttons).toHaveLength(4);
		const rights = buttons.map((button) => Math.round(button.getBoundingClientRect().right));
		// All at the same place, however long the value before each one is (the longest wraps).
		await expect(new Set(rights).size).toBe(1);
		// And at the end of the row: the value is on its left.
		const value = canvas.getByText('https://acme.authrim.example/saml/idp/metadata');
		await expect(value.getBoundingClientRect().right).toBeLessThan(
			buttons[1].getBoundingClientRect().left
		);
	}}
>
	{#snippet template()}
		<div style="max-width: 560px">
			<Card title="Authrim’s details">
				<DetailList columns={1} ruled>
					{#each [['Entity ID', 'https://acme.authrim.example/saml/idp'], ['Metadata address', 'https://acme.authrim.example/saml/idp/metadata'], ['Sign-on address', 'https://acme.authrim.example/saml/idp/sso'], ['Discovery document', 'https://acme.authrim.example/.well-known/openid-configuration']] as [label, value] (label)}
						<DetailItem {label}>
							<code>{value}</code>
							{#snippet end()}<CopyButton
									variant="icon"
									text={value}
									label={`Copy ${label}`}
								/>{/snippet}
						</DetailItem>
					{/each}
				</DetailList>
			</Card>
		</div>
	{/snippet}
</Story>

<Story name="Ruled (view-only settings)">
	{#snippet template()}
		<Card title={t('set.section.signIn')} description={t('set.section.signIn.desc')}>
			<DetailList ruled>
				<DetailItem label={t('set.k.session.default_ttl')}>
					12 {t('duration.hours')}
					<Badge>{t('settings.badge.here')}</Badge>
				</DetailItem>
				<DetailItem label={t('set.k.session.refresh_default')}><OnOff on /></DetailItem>
				<DetailItem label={t('set.k.oauth.sso_enabled')}><OnOff on={false} /></DetailItem>
				<DetailItem label={t('set.k.oauth.refresh_token_expiry')}>
					30 {t('duration.days')}
				</DetailItem>
			</DetailList>
		</Card>
	{/snippet}
</Story>
