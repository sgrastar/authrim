<script lang="ts">
	import type { ApprovalGrantSubjectTokenResult } from '$lib/api/admin-approvals';

	type Props = {
		token: ApprovalGrantSubjectTokenResult;
	};

	let { token }: Props = $props();

	function buildTokenExchangeCurl(result: ApprovalGrantSubjectTokenResult): string {
		const audienceLine = result.integration_hint.target_audience
			? `  -d "audience=${result.integration_hint.target_audience}" \\\n`
			: '';
		return [
			`curl -X POST "${result.integration_hint.token_endpoint}" \\`,
			'  -H "Content-Type: application/x-www-form-urlencoded" \\',
			'  -u "${SERVICE_CLIENT_ID}:${SERVICE_CLIENT_SECRET}" \\',
			'  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \\',
			`  -d "subject_token_type=${result.token_exchange_hint.subject_token_type}" \\`,
			`  -d "subject_token=${result.subject_token}" \\`,
			audienceLine
				? audienceLine.trimEnd()
				: '  -d "requested_token_type=urn:ietf:params:oauth:token-type:access_token"',
			audienceLine
				? '  -d "requested_token_type=urn:ietf:params:oauth:token-type:access_token"'
				: ''
		]
			.filter(Boolean)
			.join('\n');
	}

	function buildIntrospectionCurl(result: ApprovalGrantSubjectTokenResult): string {
		return [
			`curl -X POST "${result.integration_hint.introspection_endpoint}" \\`,
			'  -H "Content-Type: application/x-www-form-urlencoded" \\',
			'  -u "${SERVICE_CLIENT_ID}:${SERVICE_CLIENT_SECRET}" \\',
			'  -d "token=${DOWNSTREAM_ACCESS_TOKEN}" \\',
			'  -d "token_type_hint=access_token"'
		].join('\n');
	}

	function buildProtectedResourceCurl(result: ApprovalGrantSubjectTokenResult): string {
		const resourceId = result.integration_hint.resource_ids[0] ?? '${RESOURCE_ID}';
		const tokenEndpoint = new URL(result.integration_hint.token_endpoint);
		const productRoutePath = result.integration_hint.product_route?.path_template;
		const resolvedPath = productRoutePath
			? productRoutePath.replace(':userId', resourceId)
			: `/resources/${resourceId}`;
		const basePath = `${tokenEndpoint.protocol}//${tokenEndpoint.host}`;
		return [
			`curl -X GET "${basePath}${resolvedPath}" \\`,
			'  -H "Authorization: Bearer ${DOWNSTREAM_ACCESS_TOKEN}" \\',
			'  -H "Accept: application/json"'
		].join('\n');
	}

	function buildServiceMiddlewareSnippet(result: ApprovalGrantSubjectTokenResult): string {
		const audience = result.integration_hint.authorization_defaults.expected_audience;
		const audienceValue = audience ? `'${audience}'` : 'null';
		const resourceClass = result.integration_hint.authorization_defaults.required_resource_class;
		const detailClasses = JSON.stringify(
			result.integration_hint.authorization_defaults.required_detail_classes
		);

		return [
			'import {',
			`  ${result.integration_hint.service_sdk.authorizer_factory},`,
			`  ${result.integration_hint.service_sdk.protected_resource_middleware},`,
			'  getDownstreamGrantProtectedResourceContext,',
			`  ${result.integration_hint.service_sdk.projection_helper},`,
			"} from '@authrim/ar-lib-core';",
			'',
			`const authorizer = ${result.integration_hint.service_sdk.authorizer_factory}({`,
			`  expectedAudience: ${audienceValue},`,
			`  requiredResourceClass: '${resourceClass}',`,
			'});',
			'',
			"app.use('/resources/:id',",
			`  ${result.integration_hint.service_sdk.protected_resource_middleware}({`,
			'    authorizer,',
			"    resolveResourceId: (c) => c.req.param('id')!,",
			'    loadResource: async ({ resourceId }) => resourceStore.get(resourceId) ?? null,',
			`    resolveRequiredDetailClasses: async () => ${detailClasses},`,
			'    resolveLocalAuthorization: async ({ decision, resource }) => ({',
			'      allowed: decision.context.targetSubjectId === resource.subjectId,',
			"      reasonCode: 'subject_mismatch',",
			'    }),',
			'  })',
			');',
			'',
			"app.get('/resources/:id', (c) => {",
			'  const resourceContext = getDownstreamGrantProtectedResourceContext(c)!;',
			'  const body = projectDownstreamGrantProtectedResource(',
			'    {',
			'      resource: resourceContext.resource,',
			'      redactionLevel: resourceContext.authorization.redactionLevel ?? "masked",',
			'    },',
			'    {',
			'      summary: (resource) => ({ id: resource.id, displayName: resource.displayName }),',
			'      masked: (resource) => ({ id: resource.id, email: "***" }),',
			'      raw: (resource) => resource,',
			'    }',
			'  );',
			'  return c.json(body);',
			'});'
		].join('\n');
	}

	function buildProtectedResourceFetchSnippet(result: ApprovalGrantSubjectTokenResult): string {
		const audience = result.integration_hint.target_audience;
		const audienceLine = audience ? `  audience: '${audience}',\n` : '';
		const resourceId = result.integration_hint.resource_ids[0] ?? '${RESOURCE_ID}';
		const detailClass = result.integration_hint.detail_classes[0] ?? '${DETAIL_CLASS}';
		const tokenEndpoint = new URL(result.integration_hint.token_endpoint);
		const productRoutePath = result.integration_hint.product_route?.path_template;
		const resourceUrl = productRoutePath
			? `${tokenEndpoint.protocol}//${tokenEndpoint.host}${productRoutePath.replace(':userId', resourceId)}`
			: `https://service.example.com/resources/${resourceId}`;

		return [
			"import { fetchProtectedResourceWithDownstreamGrant } from '@authrim/ar-lib-core';",
			'',
			'const result = await fetchProtectedResourceWithDownstreamGrant({',
			`  tokenEndpoint: '${result.integration_hint.token_endpoint}',`,
			`  introspectionEndpoint: '${result.integration_hint.introspection_endpoint}',`,
			'  client: {',
			'    clientId: process.env.SERVICE_CLIENT_ID!,',
			'    clientSecret: process.env.SERVICE_CLIENT_SECRET!,',
			'  },',
			'  subjectToken: issuedSubjectToken.subject_token,',
			audienceLine.trimEnd(),
			'  authorization: {',
			`    expectedAudience: ${audience ? `'${audience}'` : 'null'},`,
			`    requiredResourceClass: '${result.integration_hint.resource_class}',`,
			`    requiredResourceId: '${resourceId}',`,
			`    requiredDetailClass: '${detailClass}',`,
			`    requireFullAccess: ${String(result.integration_hint.authorization_defaults.require_full_access)},`,
			'  },',
			`  resourceUrl: '${resourceUrl}',`,
			'});',
			'',
			'console.log(result.resourceData);'
		]
			.filter(Boolean)
			.join('\n');
	}

	function formatDetailClasses(result: ApprovalGrantSubjectTokenResult): string {
		return result.integration_hint.detail_classes.length > 0
			? result.integration_hint.detail_classes.join(', ')
			: '-';
	}

	function formatResourceIds(result: ApprovalGrantSubjectTokenResult): string {
		return result.integration_hint.resource_ids.length > 0
			? result.integration_hint.resource_ids.join(', ')
			: '-';
	}
</script>

<div class="grant-details">
	<h4 class="panel-subtitle">Service Integration</h4>
	<div class="detail-grid compact-grid">
		<div>
			<strong>Token Endpoint</strong>
			<div>{token.integration_hint.token_endpoint}</div>
		</div>
		<div>
			<strong>Introspection Endpoint</strong>
			<div>{token.integration_hint.introspection_endpoint}</div>
		</div>
		<div>
			<strong>Audience</strong>
			<div>{token.integration_hint.target_audience ?? '-'}</div>
		</div>
		<div>
			<strong>Resource Class</strong>
			<div>{token.integration_hint.resource_class}</div>
		</div>
		<div>
			<strong>Resource IDs</strong>
			<div>{formatResourceIds(token)}</div>
		</div>
		<div>
			<strong>Detail Classes</strong>
			<div>{formatDetailClasses(token)}</div>
		</div>
		<div>
			<strong>Online Check</strong>
			<div>{token.integration_hint.requires_online_check ? 'Required' : 'If Needed'}</div>
		</div>
		<div>
			<strong>Fail Closed</strong>
			<div>{token.integration_hint.fail_closed ? 'Yes' : 'Policy Controlled'}</div>
		</div>
		<div>
			<strong>SDK Helper</strong>
			<div>{token.integration_hint.service_sdk.exchange_helper}</div>
		</div>
		<div>
			<strong>Resource Fetch</strong>
			<div>{token.integration_hint.service_sdk.resource_fetch_helper}</div>
		</div>
		<div>
			<strong>Protected Middleware</strong>
			<div>{token.integration_hint.service_sdk.protected_resource_middleware}</div>
		</div>
		<div>
			<strong>Projection</strong>
			<div>{token.integration_hint.service_sdk.projection_helper}</div>
		</div>
		{#if token.integration_hint.product_route}
			<div>
				<strong>Product Route</strong>
				<div>{token.integration_hint.product_route.path_template}</div>
			</div>
			<div>
				<strong>Service Package</strong>
				<div>{token.integration_hint.product_route.service_package}</div>
			</div>
		{/if}
	</div>

	<details class="grant-details">
		<summary>Token Exchange cURL</summary>
		<pre class="json-block">{buildTokenExchangeCurl(token)}</pre>
	</details>

	<details class="grant-details">
		<summary>Introspection cURL</summary>
		<pre class="json-block">{buildIntrospectionCurl(token)}</pre>
	</details>

	<details class="grant-details">
		<summary>Protected Resource cURL</summary>
		<pre class="json-block">{buildProtectedResourceCurl(token)}</pre>
	</details>

	<details class="grant-details">
		<summary>Service SDK Guidance</summary>
		<pre class="json-block">{JSON.stringify(token.integration_hint.service_sdk, null, 2)}</pre>
	</details>

	<details class="grant-details">
		<summary>Service Middleware Snippet</summary>
		<pre class="json-block">{buildServiceMiddlewareSnippet(token)}</pre>
	</details>

	<details class="grant-details">
		<summary>Protected Resource Fetch Snippet</summary>
		<pre class="json-block">{buildProtectedResourceFetchSnippet(token)}</pre>
	</details>

	<details class="grant-details">
		<summary>Authorization Defaults</summary>
		<pre class="json-block">{JSON.stringify(
				token.integration_hint.authorization_defaults,
				null,
				2
			)}</pre>
	</details>
</div>
