/** Synthetic transport for stories; graph compilation/evaluation are the live implementations. */
import {
	defaultInboundSources,
	inboundProfileTargets,
	evaluateInboundMapping,
	oidcInboundSources,
	samlInboundAttributeValue
} from '@authrim/ar-lib-core/services/inbound-identity-mapping';
import { withMappingGraph } from '@authrim/ar-lib-field-mapping/authoring';
import type { SourceValueEnvelope } from '@authrim/ar-lib-field-mapping/contract';
import type { InboundMappingClient, InboundMappingDocument } from '#lib/api/inbound-mapping.js';
import { ApiError } from '#lib/api/api-error.js';
import { runtimeGraph } from '#lib/ui/patterns/mapping-codec.js';
import { inboundCodecContext } from './inbound-mapping.svelte';

export function inboundMappingFixture(kind: 'op' | 'idp', configured = false) {
	const protocol = kind === 'op' ? 'oidc' : 'saml';
	let current: InboundMappingDocument = {
		revision: 'incoming-1',
		protocol,
		role: protocol === 'oidc' ? 'rp' : 'sp',
		configured,
		editable: true,
		legacyMappingPresent: false,
		sources: defaultInboundSources(protocol),
		targets: inboundProfileTargets(),
		content: { catalogVersionId: 'inbound', rules: [] },
		providerUpdatedAt: '2026-11-17T00:00:01.000Z',
		enabled: false
	};
	const source = {
		side: 'source',
		namespace: protocol === 'oidc' ? 'oidc.userinfo' : 'saml.attribute',
		path: protocol === 'oidc' ? 'email' : 'mail'
	};
	const target = { side: 'destination', namespace: 'authrim.profile', path: 'email' };
	if (configured)
		current.content.rules = [
			{
				ruleKey: 'email',
				ruleKind: 'direct',
				action: 'allow',
				targetRef: target,
				edges: [{ sourceRef: source, targetRef: target }],
				output: { edgeIndex: 0 }
			}
		];
	let writes = 0;
	const client: InboundMappingClient = {
		async get() {
			return structuredClone(current);
		},
		async save(_kind, _id, draft) {
			if (draft.revision !== current.revision) throw new ApiError(409, 'conflict', 'Changed');
			writes++;
			current = {
				...current,
				revision: `incoming-${writes + 1}`,
				configured: true,
				sources: draft.sources.map((field) => ({
					...field,
					id: `inbound.source.${field.namespace}:${field.path}`,
					valueType: field.path === 'email_verified' ? 'boolean' : 'string',
					classification: 'pii',
					targetType: 'canonical'
				})),
				content: { catalogVersionId: 'inbound', rules: structuredClone(draft.rules) },
				providerUpdatedAt: new Date(Date.parse(current.providerUpdatedAt) + 1000).toISOString()
			};
			return structuredClone(current);
		},
		async preview(_kind, _id, draft, sample) {
			if (draft.revision !== current.revision) throw new ApiError(409, 'conflict', 'Changed');
			if (!sample || typeof sample !== 'object' || Array.isArray(sample))
				throw new Error('Invalid synthetic sample');
			const context = inboundCodecContext(current);
			const graph = withMappingGraph({
				graphRules: draft.rules.map((rule) => runtimeGraph(rule, context)),
				edges: [],
				transforms: []
			});
			const claims: Record<string, unknown> = Object.fromEntries(Object.entries(sample));
			const sources: SourceValueEnvelope[] =
				protocol === 'oidc'
					? oidcInboundSources(claims, current.sources)
					: current.sources.flatMap((field) => {
							const group = claims[field.namespace];
							return group && typeof group === 'object' && Object.hasOwn(group, field.path)
								? [
										{
											sourceRef: { side: 'source', namespace: field.namespace, path: field.path },
											value:
												field.namespace === 'saml.attribute'
													? samlInboundAttributeValue(Reflect.get(group, field.path))
													: Reflect.get(group, field.path)
										}
									]
								: [];
						});
			return evaluateInboundMapping({
				env: {},
				tenantId: 'synthetic-tenant',
				protocol,
				sources,
				targets: current.targets,
				binding: {
					...graph,
					catalog: {
						identity: {
							id: 'inbound',
							version: '1',
							contentHash: 'synthetic',
							compatibilityRange: '*'
						},
						entries: [...current.sources, ...current.targets]
					},
					validationRules: [],
					fieldMappingSet: { id: 'synthetic', rules: [] }
				}
			});
		}
	};
	return {
		client,
		get document() {
			return current;
		},
		get writes() {
			return writes;
		}
	};
}
