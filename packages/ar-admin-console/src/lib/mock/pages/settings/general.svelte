<script lang="ts">
	import { createFakeTenantInfo } from '$lib/api/fake/tenant-info-fake';
	import TenantGeneral from '$lib/pages/tenant-general/TenantGeneral.svelte';

	const info = createFakeTenantInfo({ delay: 120 });
</script>

<TenantGeneral {info} tenantId="acme" />
