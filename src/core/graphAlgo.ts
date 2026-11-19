import type {
	EntityType,
	GraphEdge,
	GraphNode,
	GraphStats,
	StatusType,
} from '../types';

export interface TraversalVisit {
	nodeId: string;
	hopDistance: number;
	path: string[];
}

const ENTITY_TYPES: readonly EntityType[] = [
	'NPC',
	'LOCATION',
	'FACTION',
	'QUEST',
	'ITEM',
	'SESSION_LOG',
	'LORE',
	'META',
	'UNTYPED',
];

const STATUS_TYPES: readonly StatusType[] = [
	'ACTIVE',
	'INACTIVE',
	'TERMINATED',
	'UNKNOWN',
];

/**
 * Removes ignored nodes and drops any edges touching them.
 */
export function filterIgnoredGraph(
	nodes: GraphNode[],
	edges: GraphEdge[],
	ignoredIds: Iterable<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
	const ignored = new Set(ignoredIds);
	const filteredNodes = nodes.filter((node) => !ignored.has(node.id));
	const filteredEdges = edges.filter(
		(edge) =>
			!ignored.has(edge.sourceId) && !ignored.has(edge.targetId),
	);

	return {
		nodes: filteredNodes,
		edges: filteredEdges,
	};
}

/**
 * Recomputes `inDegree` and `outDegree` for every node from directed edges.
 */
export function computeDegrees(
	nodes: GraphNode[],
	edges: GraphEdge[],
): GraphNode[] {
	const validIds = new Set(nodes.map((node) => node.id));
	const inCounts = new Map<string, number>();
	const outCounts = new Map<string, number>();

	for (const edge of edges) {
		if (!validIds.has(edge.sourceId) || !validIds.has(edge.targetId)) {
			continue;
		}
		if (edge.sourceId === edge.targetId) {
			continue;
		}
		outCounts.set(edge.sourceId, (outCounts.get(edge.sourceId) ?? 0) + 1);
		inCounts.set(edge.targetId, (inCounts.get(edge.targetId) ?? 0) + 1);
	}

	return nodes.map((node) => ({
		...node,
		inDegree: inCounts.get(node.id) ?? 0,
		outDegree: outCounts.get(node.id) ?? 0,
	}));
}

function buildUndirectedAdjacency(
	nodes: GraphNode[],
	edges: GraphEdge[],
): Map<string, string[]> {
	const validIds = new Set(nodes.map((node) => node.id));
	const adjSets = new Map<string, Set<string>>();

	for (const id of validIds) {
		adjSets.set(id, new Set());
	}

	for (const edge of edges) {
		if (!validIds.has(edge.sourceId) || !validIds.has(edge.targetId)) {
			continue;
		}
		if (edge.sourceId === edge.targetId) {
			continue;
		}
		adjSets.get(edge.sourceId)?.add(edge.targetId);
		adjSets.get(edge.targetId)?.add(edge.sourceId);
	}

	const sortedAdj = new Map<string, string[]>();
	for (const [nodeId, neighbors] of adjSets.entries()) {
		sortedAdj.set(
			nodeId,
			Array.from(neighbors).sort((a, b) => a.localeCompare(b)),
		);
	}

	return sortedAdj;
}

/**
 * Performs deterministic undirected BFS from `anchorIds` up to `maxHops`,
 * recording shortest hop distance and path for each reachable node.
 */
export function traverseGraph(
	nodes: GraphNode[],
	edges: GraphEdge[],
	anchorIds: string[],
	maxHops: number,
): TraversalVisit[] {
	if (nodes.length === 0 || anchorIds.length === 0 || maxHops < 0) {
		return [];
	}

	const adjacency = buildUndirectedAdjacency(nodes, edges);
	const visited = new Map<string, TraversalVisit>();
	const queue: TraversalVisit[] = [];

	const sortedAnchors = Array.from(
		new Set(anchorIds.filter((id) => adjacency.has(id))),
	).sort((a, b) => a.localeCompare(b));

	for (const anchorId of sortedAnchors) {
		const visit: TraversalVisit = {
			nodeId: anchorId,
			hopDistance: 0,
			path: [anchorId],
		};
		visited.set(anchorId, visit);
		queue.push(visit);
	}

	let head = 0;
	while (head < queue.length) {
		const current = queue[head];
		head += 1;
		if (!current || current.hopDistance >= maxHops) {
			continue;
		}

		const neighbors = adjacency.get(current.nodeId) ?? [];
		for (const neighborId of neighbors) {
			if (visited.has(neighborId)) {
				continue;
			}
			const nextVisit: TraversalVisit = {
				nodeId: neighborId,
				hopDistance: current.hopDistance + 1,
				path: [...current.path, neighborId],
			};
			visited.set(neighborId, nextVisit);
			queue.push(nextVisit);
		}
	}

	return Array.from(visited.values()).sort((a, b) => {
		if (a.hopDistance !== b.hopDistance) {
			return a.hopDistance - b.hopDistance;
		}
		return a.nodeId.localeCompare(b.nodeId);
	});
}

/**
 * Returns deterministic neighbor node IDs within `maxHops` (excluding `anchorId`).
 */
export function getNeighbors(
	nodes: GraphNode[],
	edges: GraphEdge[],
	anchorId: string,
	maxHops = 1,
): string[] {
	return traverseGraph(nodes, edges, [anchorId], maxHops)
		.filter((visit) => visit.hopDistance >= 1)
		.map((visit) => visit.nodeId);
}

/**
 * Computes summary statistics for the in-memory knowledge graph.
 */
export function computeGraphStats(
	nodes: GraphNode[],
	edges: GraphEdge[],
): GraphStats {
	const byType = {} as Record<EntityType, number>;
	for (const entityType of ENTITY_TYPES) {
		byType[entityType] = 0;
	}

	const byStatus = {} as Record<StatusType, number>;
	for (const statusType of STATUS_TYPES) {
		byStatus[statusType] = 0;
	}

	const edgesByKind: Record<GraphEdge['kind'], number> = {
		LINK: 0,
		EMBED: 0,
		FRONTMATTER: 0,
	};

	let dirtyNodes = 0;
	for (const node of nodes) {
		byType[node.type] = (byType[node.type] ?? 0) + 1;
		const status = node.staticState.statusType;
		byStatus[status] = (byStatus[status] ?? 0) + 1;
		if (node.isDirty) {
			dirtyNodes += 1;
		}
	}

	for (const edge of edges) {
		edgesByKind[edge.kind] = (edgesByKind[edge.kind] ?? 0) + 1;
	}

	return {
		totalNodes: nodes.length,
		totalEdges: edges.length,
		dirtyNodes,
		byType,
		byStatus,
		edgesByKind,
	};
}
