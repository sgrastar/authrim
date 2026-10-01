<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { t } from '$lib/i18n/i18n.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import DurationField from '../primitives/DurationField.svelte';
	import Select from '../primitives/Select.svelte';
	import Card from './Card.svelte';
	import FieldRow from './FieldRow.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Field row',
		component: FieldRow,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'A settings form as a table: each field’s name on the start side (what it does behind a “?”), the control on the end side, rows divided by a line, no vertical lines. The columns match a ruled **Detail list**, so a page looks the same to an admin who may change it and to one who may only look.\n\nThe name here is for the eye: give the control the same label with `hideLabel`, so assistive tech reads it with the control. On narrow screens the name goes above the control.'
				}
			}
		}
	});
</script>

<Story name="Settings form">
	{#snippet template()}
		<Card title={t('set.section.signIn')} description={t('set.section.signIn.desc')}>
			<FieldRow label={t('set.k.session.default_ttl')} info={t('set.k.session.default_ttl.desc')}>
				<DurationField label={t('set.k.session.default_ttl')} hideLabel value={43200} />
			</FieldRow>
			<FieldRow label={t('set.k.oauth.sso_enabled')} info={t('set.k.oauth.sso_enabled.desc')}>
				<Checkbox hideLabel checked>{t('set.k.oauth.sso_enabled')}</Checkbox>
			</FieldRow>
			<FieldRow
				label={t('set.k.session.backchannel_on_failure')}
				info={t('set.k.session.backchannel_on_failure.desc')}
			>
				<Select
					label={t('set.k.session.backchannel_on_failure')}
					hideLabel
					value="log"
					options={['ignore', 'log', 'error'].map((value) => ({
						value,
						label: t(`set.k.session.backchannel_on_failure.${value}` as Parameters<typeof t>[0])
					}))}
				/>
			</FieldRow>
		</Card>
	{/snippet}
</Story>
