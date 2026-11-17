<script lang="ts">
	import type { TenantIsolationPolicy } from '#lib/api/tenants.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import RadioGroup from '#lib/ui/primitives/RadioGroup.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { suggestTenantId, TENANT_ID_MAX } from './tenant-model';

	/**
	 * What a new tenant is asked for, when it is created and when it is copied: a name and an id
	 * (suggested from the name until the admin types one). The code, a description and how its
	 * data is stored are folded under "Advanced settings".
	 */
	interface Props {
		name: string;
		id: string;
		code: string;
		description: string;
		isolationPolicy: TenantIsolationPolicy;
		nameError?: string;
		idError?: string;
		codeError?: string;
		advancedOpen?: boolean;
	}

	let {
		name = $bindable(),
		id = $bindable(),
		code = $bindable(),
		description = $bindable(),
		isolationPolicy = $bindable(),
		nameError = '',
		idError = '',
		codeError = '',
		advancedOpen = $bindable(false)
	}: Props = $props();

	let idTouched = $state(false);

	const isolationOptions = $derived([
		{
			value: 'tenant_exclusive',
			label: t('tn.isolation.tenant_exclusive'),
			description: t('tn.isolation.tenant_exclusive.desc')
		},
		{
			value: 'shared_pool',
			label: t('tn.isolation.shared_pool'),
			description: t('tn.isolation.shared_pool.desc')
		}
	]);
	let isolationValue = $derived<string>(isolationPolicy);
</script>

<TextField
	label={t('tn.f.name')}
	required
	maxlength={200}
	error={nameError}
	bind:value={name}
	oninput={(event: Event) => {
		// From the field's own text: the bound `name` is updated after this handler runs.
		if (!idTouched) id = suggestTenantId((event.currentTarget as HTMLInputElement).value);
	}}
/>
<TextField
	label={t('tn.f.id')}
	required
	maxlength={TENANT_ID_MAX}
	hint={t('tn.f.idHint')}
	error={idError}
	bind:value={id}
	oninput={() => (idTouched = true)}
/>
<Disclosure title={t('tn.advanced')} bind:open={advancedOpen} boxed>
	<TextField
		label={t('tn.f.code')}
		maxlength={TENANT_ID_MAX}
		hint={t('tn.f.codeHint')}
		error={codeError}
		bind:value={code}
	/>
	<TextArea label={t('tn.f.description')} maxlength={500} bind:value={description} />
	<RadioGroup
		label={t('tn.f.isolation')}
		options={isolationOptions}
		value={isolationValue}
		onchange={(value) => (isolationPolicy = value as TenantIsolationPolicy)}
	/>
</Disclosure>
