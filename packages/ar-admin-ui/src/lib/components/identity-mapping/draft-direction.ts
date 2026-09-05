import type { MappingEdge, MappingNode, MappingSample } from './types';

export type MappingViewMode = 'overview' | 'source' | 'destination';

export function selectDraftDirectionGraph(
	nodes: MappingNode[],
	edges: MappingEdge[],
	side: MappingViewMode
): { nodes: MappingNode[]; edges: MappingEdge[] } {
	const selectedNodes = nodes.filter(
		(node) =>
			node.role === 'target' ||
			node.role === 'transform' ||
			(side !== 'destination' && node.role === 'source') ||
			(side !== 'source' && node.role === 'destination')
	);
	const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
	return {
		nodes: selectedNodes,
		edges: edges.filter((edge) => selectedNodeIds.has(edge.from) && selectedNodeIds.has(edge.to))
	};
}

export function sourceProfileIdsForDraft(
	_sample: MappingSample,
	nodes: MappingNode[],
	side: MappingViewMode
): string[] {
	if (side === 'destination') return [];
	return Array.from(
		new Set(
			nodes.flatMap((node) => (node.role === 'source' && node.profileId ? [node.profileId] : []))
		)
	);
}

export function missingMappingRequiredSourceNodes(
	nodes: MappingNode[],
	edges: MappingEdge[],
	side: MappingViewMode
): MappingNode[] {
	if (side === 'destination') return [];
	const connectedSourceNodeIds = new Set(edges.map((edge) => edge.from));
	return nodes.filter(
		(node) =>
			node.role === 'source' &&
			node.mappingRequired === true &&
			!connectedSourceNodeIds.has(node.id)
	);
}
