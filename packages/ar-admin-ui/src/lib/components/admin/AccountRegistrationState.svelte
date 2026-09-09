<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import type { AccountRegistrationState } from '@authrim/ar-lib-core';
	let { state } = $props<{ state?: AccountRegistrationState }>();
</script>

<span
	>{state === 'guest'
		? $LL.admin_registration_guest()
		: state === 'registered'
			? $LL.admin_registration_registered()
			: '-'}</span
>
