import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { matchEntityName, resolveSubjects } from '../src/core/entityMatcher';
import {
	getVerifiedEventsForNode,
	resolveEffectiveState,
} from '../src/core/stateResolver';
import type { GraphNode, SessionEvent } from '../src/types';

interface MiniVaultFixture {
	nodes: GraphNode[];
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

describe('entityMatcher', () => {
	const fixture = loadMiniVault();

	it('resolves exact titles, aliases, and inflected Ukrainian case forms', () => {
		expect(matchEntityName('Барон Келд', fixture.nodes).id).toBe(
			'World/NPC/Baron Keld.md',
		);
		expect(matchEntityName('Барона Келда', fixture.nodes).id).toBe(
			'World/NPC/Baron Keld.md',
		);
		expect(matchEntityName('Барону Келду', fixture.nodes).id).toBe(
			'World/NPC/Baron Keld.md',
		);
		expect(matchEntityName('Окхейвені', fixture.nodes).id).toBe(
			'World/Locations/Oakhaven.md',
		);
		expect(matchEntityName('Болотяної вежі', fixture.nodes).id).toBe(
			'World/Locations/Swamp Tower.md',
		);
	});

	it('flags ambiguous candidates instead of silently picking one', () => {
		const similarNodes: GraphNode[] = [
			{
				...fixture.nodes[0]!,
				id: 'NPC/Guard North.md',
				title: 'Вартовий Півночі',
				aliases: ['Вартовий'],
			},
			{
				...fixture.nodes[1]!,
				id: 'NPC/Guard South.md',
				title: 'Вартовий Півдня',
				aliases: ['Вартовий'],
			},
		];

		const res = matchEntityName('Вартовий', similarNodes);
		expect(res.id).toBeNull();
		expect(res.ambiguous).toBe(true);
		expect(res.candidates).toHaveLength(2);
	});

	it('never fuzzy-matches short names <= 3 chars and tracks unresolved subjects', () => {
		const shortNodes: GraphNode[] = [
			{
				...fixture.nodes[0]!,
				id: 'NPC/Tor.md',
				title: 'Тор',
				aliases: [],
			},
		];
		expect(matchEntityName('Тон', shortNodes).id).toBeNull();

		const resolved = resolveSubjects(
			['Барона Келда', 'Невідомий Асасин'],
			fixture.nodes,
		);
		expect(resolved.subjectIds).toEqual(['World/NPC/Baron Keld.md']);
		expect(resolved.unresolvedSubjects).toEqual(['Невідомий Асасин']);
	});
});

describe('stateResolver', () => {
	const fixture = loadMiniVault();

	it('overrides static ACTIVE tag with verified TERMINATED session event', () => {
		const baron = fixture.nodes.find(
			(n) => n.id === 'World/NPC/Baron Keld.md',
		)!;
		expect(baron.staticState.statusType).toBe('ACTIVE');

		const effective = resolveEffectiveState(baron, fixture.events);
		expect(effective.statusType).toBe('TERMINATED');
		expect(effective.statusNote).toBe('вбитий під час заколоту');
		expect(effective.sessionUpdated).toBe(2);
		expect(effective.source).toBe('EVENT');
	});

	it('ignores unverified events and selects highest sessionId among verified events', () => {
		const baron = fixture.nodes.find(
			(n) => n.id === 'World/NPC/Baron Keld.md',
		)!;
		const events: SessionEvent[] = [
			...fixture.events,
			{
				id: 'evt-s3-unverified',
				sessionId: 3,
				sourceNoteId: 'Sessions/Session 3.md',
				subjects: ['Барон Келд'],
				subjectIds: ['World/NPC/Baron Keld.md'],
				action: 'воскресіння',
				details: 'Непідтверджене припущення про повернення Келда.',
				stateChanges: [
					{
						subject: 'Барон Келд',
						newStatusType: 'ACTIVE',
						newStatusNote: 'воскрес',
					},
				],
				userVerified: false,
				createdAt: 1700000900,
			},
		];

		// Unverified session 3 event must be ignored -> session 2 TERMINATED still wins
		expect(resolveEffectiveState(baron, events).statusType).toBe(
			'TERMINATED',
		);

		// When session 4 verified event exists, session 4 wins over session 2
		events.push({
			...events[1]!,
			id: 'evt-s4-verified',
			sessionId: 4,
			userVerified: true,
		});
		const afterS4 = resolveEffectiveState(baron, events);
		expect(afterS4.statusType).toBe('ACTIVE');
		expect(afterS4.sessionUpdated).toBe(4);
	});

	it('falls back to staticState or UNKNOWN and returns sorted verified events', () => {
		const vorn = fixture.nodes.find(
			(n) => n.id === 'World/NPC/Archivist Vorn.md',
		)!;
		const nika = fixture.nodes.find(
			(n) => n.id === 'World/NPC/Whisperer Nika.md',
		)!;

		expect(resolveEffectiveState(vorn, fixture.events).statusType).toBe(
			'INACTIVE',
		);
		expect(resolveEffectiveState(vorn, fixture.events).source).toBe('TAG');

		expect(resolveEffectiveState(nika, fixture.events).statusType).toBe(
			'UNKNOWN',
		);
		expect(resolveEffectiveState(nika, fixture.events).source).toBe(
			'DEFAULT',
		);

		expect(
			getVerifiedEventsForNode('World/NPC/Baron Keld.md', fixture.events),
		).toHaveLength(1);
	});
});
