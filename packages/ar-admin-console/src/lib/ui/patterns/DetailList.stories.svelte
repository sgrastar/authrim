<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../stories/subcomponents';
	import { t } from '$lib/i18n/i18n.svelte';
	import Badge from '../primitives/Badge.svelte';
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
						'Read-only facts as label/value pairs (a `<dl>`): account details, a record’s properties. Labels sit in one column so values line up; on phones each label moves above its value. Editable values belong in a form, not here.\n\n**Ruled** (`ruled`) is a quiet table for values someone may only look at, such as settings in view-only access: rows divided by a line, no vertical lines, the value stronger than its name, on/off with `OnOff`, and a badge only where a value is not the default.'
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
