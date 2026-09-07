import { describe, expect, it } from 'vitest';
import {
	missingMappingRequiredSourceNodes,
	selectDraftDirectionGraph,
	sourceProfileIdsForDraft
} from '../draft-direction';
import type { MappingEdge, MappingNode, MappingSample } from '../types';

const nodes: MappingNode[] = [
	{
		id: 'scim-user-name',
		ruleId: 'scim-user-name',
		role: 'source',
		profileId: 'source_scim_core',
		label: 'User name',
		caption: 'userName',
		mappingRequired: true
	},
	{
		id: 'identity-preferred-username',
		ruleId: 'identity-preferred-username',
		role: 'target',
		label: 'Preferred username',
		caption: 'preferred_username'
	},
	{
		id: 'oidc-preferred-username',
		ruleId: 'oidc-preferred-username',
		role: 'destination',
		label: 'preferred_username',
		caption: 'preferred_username'
	}
];

const edges: MappingEdge[] = [
	{ id: 'source-edge', from: 'scim-user-name', to: 'identity-preferred-username' },
	{
		id: 'destination-edge',
		from: 'identity-preferred-username',
		to: 'oidc-preferred-username',
		destinationSide: true
	}
];

const sample = {
	id: 'source-profile-source_scim_core',
	title: 'SCIM Core User',
	nodes
} as MappingSample;

describe('field mapping draft direction isolation', () => {
	it('keeps only Source -> Identity DB state in a source draft', () => {
		const graph = selectDraftDirectionGraph(nodes, edges, 'source');

		expect(graph.nodes.some((node) => node.role === 'destination')).toBe(false);
		expect(graph.edges.map((edge) => edge.id)).toEqual(['source-edge']);
		expect(sourceProfileIdsForDraft(sample, graph.nodes, 'source')).toEqual(['source_scim_core']);
		expect(missingMappingRequiredSourceNodes(graph.nodes, graph.edges, 'source')).toEqual([]);
	});

	it('keeps only Identity DB -> Destination state and ignores inbound requirements', () => {
		const graph = selectDraftDirectionGraph(nodes, edges, 'destination');

		expect(graph.nodes.some((node) => node.role === 'source')).toBe(false);
		expect(graph.edges.map((edge) => edge.id)).toEqual(['destination-edge']);
		expect(sourceProfileIdsForDraft(sample, graph.nodes, 'destination')).toEqual([]);
		expect(missingMappingRequiredSourceNodes(nodes, [], 'destination')).toEqual([]);
	});

	it('still reports an unconnected required Source field in source mode', () => {
		expect(missingMappingRequiredSourceNodes(nodes, [], 'source')).toEqual([
			expect.objectContaining({ id: 'scim-user-name', label: 'User name' })
		]);
	});
});
