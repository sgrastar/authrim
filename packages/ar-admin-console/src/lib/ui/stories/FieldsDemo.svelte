<script lang="ts">
	import Card from '../patterns/Card.svelte';
	import Disclosure from '../patterns/Disclosure.svelte';
	import EntityPicker, { type PickerItem } from '../patterns/EntityPicker.svelte';
	import InheritedSetting from '../patterns/InheritedSetting.svelte';
	import KeyValueField, { type KeyValue } from '../patterns/KeyValueField.svelte';
	import ListField from '../patterns/ListField.svelte';
	import DurationField from '../primitives/DurationField.svelte';
	import NumberField from '../primitives/NumberField.svelte';
	import SecretField from '../primitives/SecretField.svelte';
	import { Draft } from '../save/draft.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import { localized } from './sample';
	import { searchPeople } from './people';

	/**
	 * Storybook demo: an application's settings page built from the field parts — a lifetime
	 * that follows the platform default until overridden, limits with units, lists of URIs and
	 * headers, a stored secret, members found by search, and rarely used options folded away.
	 */
	interface Settings {
		ttlOverridden: boolean;
		accessTtl: number | null;
		refreshTtl: number | null;
		maxSessions: number | null;
		redirectUris: string[];
		headers: KeyValue[];
		secret: string;
		owners: PickerItem[];
	}

	const PLATFORM_TTL = 3600;
	const settings = new Draft<Settings>({
		ttlOverridden: false,
		accessTtl: PLATFORM_TTL,
		refreshTtl: 2_592_000,
		maxSessions: 5,
		redirectUris: ['https://app.example.com/callback'],
		headers: [{ key: 'X-Tenant', value: 'acme' }],
		secret: '',
		owners: [{ value: 'u-aiko', label: 'Aiko Tanaka', description: 'aiko@example.com' }]
	});

	const copy = {
		tokens: ['トークン', 'Tokens', 'Token', 'الرموز'],
		access: [
			'アクセストークンの有効期間',
			'Access token lifetime',
			'Gültigkeit des Zugriffstokens',
			'مدة صلاحية رمز الوصول'
		],
		refresh: [
			'リフレッシュトークンの有効期間',
			'Refresh token lifetime',
			'Gültigkeit des Aktualisierungstokens',
			'مدة صلاحية رمز التحديث'
		],
		hour: ['1 時間', '1 hour', '1 Stunde', 'ساعة واحدة'],
		sessions: [
			'同時にログインできる数',
			'Concurrent sign-ins',
			'Gleichzeitige Anmeldungen',
			'عمليات الدخول المتزامنة'
		],
		sessionsUnit: ['件', 'sign-ins', 'Anmeldungen', 'عمليات'],
		sessionsHint: [
			'上限に達すると、いちばん古いログインを終了します。',
			'At the limit, the oldest sign-in ends.',
			'Beim Erreichen des Limits endet die älteste Anmeldung.',
			'عند بلوغ الحد، تنتهي أقدم عملية دخول.'
		],
		redirects: ['リダイレクト URI', 'Redirect URIs', 'Weiterleitungs-URIs', 'عناوين إعادة التوجيه'],
		addUri: ['URI を追加', 'Add a URI', 'URI hinzufügen', 'إضافة عنوان'],
		https: [
			'https:// で始まる URL を入力してください。',
			'Enter a URL starting with https://.',
			'Geben Sie eine URL ein, die mit https:// beginnt.',
			'أدخل عنوانًا يبدأ بـ https://.'
		],
		owners: ['管理者', 'Owners', 'Verantwortliche', 'المالكون'],
		ownersHint: [
			'名前またはメールアドレス',
			'Name or email',
			'Name oder E-Mail',
			'الاسم أو البريد'
		],
		secret: ['クライアントシークレット', 'Client secret', 'Client-Geheimnis', 'سر العميل'],
		advanced: ['詳細設定', 'Advanced settings', 'Erweiterte Einstellungen', 'إعدادات متقدمة'],
		advancedDesc: [
			'通常は変更不要です',
			'Rarely needs changing',
			'Muss selten geändert werden',
			'نادرًا ما يلزم تغييرها'
		],
		headers: [
			'追加のリクエストヘッダー',
			'Extra request headers',
			'Zusätzliche Header',
			'ترويسات إضافية'
		]
	} as const;
	const c = (key: keyof typeof copy) => localized(copy[key]);

	const httpsOnly = (value: string) => (/^https:\/\/\S+$/.test(value) ? undefined : c('https'));
	const save = () => new Promise((resolve) => setTimeout(resolve, 700)).then(() => {});
</script>

<SaveScope draft={settings} onsave={save}>
	<div style="display:grid;gap:16px;max-width:720px">
		<Card title={c('tokens')}>
			<div style="display:grid;gap:14px">
				<InheritedSetting
					field="ttlOverridden"
					defaultValue={c('hour')}
					bind:overridden={settings.value.ttlOverridden}
					onchange={(own) => {
						if (!own) settings.value.accessTtl = PLATFORM_TTL;
					}}
				>
					{#snippet children({ inherited })}
						<DurationField
							label={c('access')}
							field="accessTtl"
							min={60}
							max={86_400}
							disabled={inherited}
							bind:value={settings.value.accessTtl}
						/>
					{/snippet}
				</InheritedSetting>
				<DurationField
					label={c('refresh')}
					field="refreshTtl"
					units={['hours', 'days']}
					min={3600}
					max={31_536_000}
					bind:value={settings.value.refreshTtl}
				/>
				<NumberField
					label={c('sessions')}
					unit={c('sessionsUnit')}
					hint={c('sessionsHint')}
					field="maxSessions"
					min={1}
					max={100}
					bind:value={settings.value.maxSessions}
				/>
			</div>
		</Card>
		<Card title={c('redirects')}>
			<div style="display:grid;gap:14px">
				<ListField
					label={c('redirects')}
					field="redirectUris"
					placeholder="https://"
					addLabel={c('addUri')}
					mono
					validate={httpsOnly}
					bind:values={settings.value.redirectUris}
				/>
				<SecretField label={c('secret')} stored field="secret" bind:value={settings.value.secret} />
				<EntityPicker
					label={c('owners')}
					placeholder={c('ownersHint')}
					field="owners"
					search={searchPeople}
					bind:items={settings.value.owners}
				/>
				<Disclosure title={c('advanced')} description={c('advancedDesc')}>
					<KeyValueField
						label={c('headers')}
						field="headers"
						keyPlaceholder="X-Header-Name"
						bind:entries={settings.value.headers}
					/>
				</Disclosure>
			</div>
		</Card>
	</div>
</SaveScope>
