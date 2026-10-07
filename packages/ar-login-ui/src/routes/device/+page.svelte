<script lang="ts">
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import DeviceView from '$lib/views/DeviceView.svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { LL } from '$i18n/i18n-svelte';
	import { deviceFlowAPI } from '$lib/api/client';
	import { createDeviceFlow, type DeviceFlowState } from './device-decision';

	const { brandingStore } = useLoginUIStores();

	// The flow (device-decision.ts) owns the requests: it approves or denies only the code whose
	// details are shown, and ignores lookup answers for a code that was edited meanwhile.
	const flow = createDeviceFlow({
		api: deviceFlowAPI,
		translations: () => get(LL),
		onChange: (next) => (view = next),
		onDenied: () => {
			window.location.href = '/';
		}
	});
	let view = $state<DeviceFlowState>(flow.state);

	onMount(() => {
		const code = $page.url.searchParams.get('user_code');
		if (code) {
			flow.setUserCode(code);
		}
	});

	function handleCodeInput(event: Event) {
		const target = event.target as HTMLInputElement;
		target.value = flow.setUserCode(target.value);
	}

	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			void flow.verify();
		}
	}
</script>

<svelte:head>
	<title>{$LL.device_title()} - {brandingStore.brandName || $LL.app_title()}</title>
</svelte:head>

<AuthPageShell>
	<DeviceView
		step={view.step}
		userCode={view.userCode}
		error={view.error}
		success={view.success}
		verifying={view.verifying}
		loading={view.loading}
		deviceInfo={view.deviceInfo}
		onCodeInput={handleCodeInput}
		onKeyPress={handleKeyPress}
		onVerify={() => void flow.verify()}
		onApprove={() => void flow.decide('approve')}
		onDeny={() => void flow.decide('deny')}
		onDismissError={() => flow.dismissError()}
	/>
</AuthPageShell>
