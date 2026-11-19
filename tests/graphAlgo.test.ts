import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	computeDegrees,
	computeGraphStats,
	filterIgnoredGraph,
	getNeighbors,
	traverseGraph,
} from '../src/core/graphAlgo';
import type { GraphEdge, GraphNode, SessionEvent } from '../src/types';

interface MiniVaultFixture {
	nodes: GraphNode[];
	edges: GraphEdge[];
	events: SessionEvent[];
}

function loadMiniVault(): MiniVaultFixture {
	const currentDir = dirname(fileURLToPath(import.meta.url));
	const raw = readFileSync(
		resolve(currentDir, 'fixtures/mini-vault.json'),
		'utf8',
	);
	return JSON.parse(raw) as MiniVaultFixture;
}

describe('graphAlgo', () => {
	const fixture = loadMiniVault();
	const activeGraph = filterIgnoredGraph(fixture.nodes, fixture.edges, [
		'Archive/Old Draft.md',
	]);

	it('filters out ignored nodes and all edges touching them', () => {
		expect(
			activeGraph.nodes.some((n) => n.id === 'Archive/Old Draft.md'),
		).toBe(false);
		expect(
			activeGraph.edges.some(
				(e) =>
					e.sourceId === 'Archive/Old Draft.md' ||
					e.targetId === 'Archive/Old Draft.md',
			),
		).toBe(false);
		expect(activeGraph.nodes.length).toBe(fixture.nodes.length - 1);
	});

	it('computes directed inDegree and outDegree accurately', () => {
		const nodesWithDegrees = computeDegrees(
			activeGraph.nodes,
			activeGraph.edges,
		);
		const hub = nodesWithDegrees.find(
			(n) => n.id === 'Meta/World Index.md',
		);
		const baron = nodesWithDegrees.find(
			(n) => n.id === 'World/NPC/Baron Keld.md',
		);
		const myth = nodesWithDegrees.find(
			(n) => n.id === 'Lore/Ancient Myth.md',
		);

		expect(hub?.outDegree).toBe(10);
		expect(hub?.inDegree).toBe(0);
		expect(baron?.outDegree).toBe(2);
		expect(baron?.inDegree).toBe(7);
		expect(myth?.inDegree).toBe(0);
		expect(myth?.outDegree).toBe(0);
	});

	it('traverses undirected 1-hop and 2-hop neighborhoods deterministically with paths', () => {
		const oneHop = getNeighbors(
			activeGraph.nodes,
			activeGraph.edges,
			'World/Quests/Siege of Black Citadel.md',
			1,
		);
		expect(oneHop).toEqual(['World/Locations/Black Citadel.md']);

		const twoHopVisits = traverseGraph(
			activeGraph.nodes,
			activeGraph.edges,
			['World/Quests/Siege of Black Citadel.md'],
			2,
		);
		expect(twoHopVisits).toEqual([
			{
				nodeId: 'World/Quests/Siege of Black Citadel.md',
				hopDistance: 0,
				path: ['World/Quests/Siege of Black Citadel.md'],
			},
			{
				nodeId: 'World/Locations/Black Citadel.md',
				hopDistance: 1,
				path: [
					'World/Quests/Siege of Black Citadel.md',
					'World/Locations/Black Citadel.md',
				],
			},
			{
				nodeId: 'World/NPC/Necromancer Malcor.md',
				hopDistance: 2,
				path: [
					'World/Quests/Siege of Black Citadel.md',
					'World/Locations/Black Citadel.md',
					'World/NPC/Necromancer Malcor.md',
				],
			},
		]);

		// Disconnected node only visits itself
		const disconnected = traverseGraph(
			activeGraph.nodes,
			activeGraph.edges,
			['Lore/Ancient Myth.md'],
			2,
		);
		expect(disconnected).toHaveLength(1);
		expect(disconnected[0]?.nodeId).toBe('Lore/Ancient Myth.md');

		// Missing anchor or empty graph yields empty result
		expect(
			traverseGraph(
				activeGraph.nodes,
				activeGraph.edges,
				['NonExistent.md'],
				2,
			),
		).toEqual([]);
	});

	it('computes graph statistics across nodes, types, statuses, and edge kinds', () => {
		const stats = computeGraphStats(activeGraph.nodes, activeGraph.edges);

		expect(stats.totalNodes).toBe(21);
		expect(stats.totalEdges).toBe(34);
		expect(stats.dirtyNodes).toBe(0);
		expect(stats.byType.NPC).toBe(6);
		expect(stats.byType.LOCATION).toBe(4);
		expect(stats.byType.QUEST).toBe(3);
		expect(stats.byType.META).toBe(1);
		expect(stats.edgesByKind.FRONTMATTER).toBe(1);
		expect(stats.edgesByKind.EMBED).toBe(1);
		expect(stats.edgesByKind.LINK).toBe(32);
	});
});
