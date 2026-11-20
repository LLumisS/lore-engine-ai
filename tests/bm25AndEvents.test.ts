import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	cosineSimilarity,
	fuseHybridRankings,
	searchBm25,
	tokenizeForBm25,
} from '../src/core/bm25';
import {
	determineSessionId,
	mergeReparsedSessionEvents,
	parsePersistedEventsFile,
	splitSessionLogIntoChunks,
	validateExtractedEventsJson,
} from '../src/engine/eventManager';
import { isPathInSessionFolder } from '../src/engine/vaultParser';
import { getSessionExtractionSystemPrompt } from '../src/llm/prompts';
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

describe('deterministic Cyrillic BM25 & hybrid fusion', () => {
	const fixture = loadMiniVault();

	it('produces shared stems for inflected Ukrainian/Russian case forms', () => {
		const nom = tokenizeForBm25('Барон Келд');
		const gen = tokenizeForBm25('Барона Келда');
		const dat = tokenizeForBm25('Барону Келду');

		expect(nom).toContain('барон');
		expect(gen).toContain('барон');
		expect(dat).toContain('барон');
		expect(nom).toContain('келд');
		expect(gen).toContain('келд');
		expect(dat).toContain('келд');
	});

	it('ranks expected nodes first across Ukrainian inflected queries deterministically', () => {
		const q1 = searchBm25(fixture.nodes, 'Що сталося з Бароном Келдом', 5);
		expect(q1[0]?.nodeId).toBe('World/NPC/Baron Keld.md');

		const q2 = searchBm25(
			fixture.nodes,
			'давня Болотяної вежі на північ',
			5,
		);
		expect(q2[0]?.nodeId).toBe('World/Locations/Swamp Tower.md');

		const q3 = searchBm25(fixture.nodes, 'змовники з Гільдією Тіней', 5);
		expect(q3[0]?.nodeId).toBe('World/Factions/Shadow Guild.md');

		// Determinism check
		const q1Repeat = searchBm25(
			fixture.nodes,
			'Що сталося з Бароном Келдом',
			5,
		);
		expect(q1Repeat).toEqual(q1);
	});

	it('computes cosine similarity on Float32Array and degrades gracefully without vectors', () => {
		const a = new Float32Array([1, 0, 0]);
		const b = new Float32Array([0.8, 0.6, 0]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(0.8, 5);

		const lexical = searchBm25(fixture.nodes, 'Барона Келда', 5);
		const bm25Only = fuseHybridRankings(lexical, [], 5);
		expect(bm25Only.length).toBeGreaterThan(0);
		expect(bm25Only[0]?.vectorScore).toBe(0);
		expect(bm25Only[0]?.score).toBe(1);

		const hybrid = fuseHybridRankings(
			lexical,
			[{ nodeId: 'World/Locations/Oakhaven.md', score: 0.95 }],
			5,
		);
		expect(hybrid.some((h) => h.vectorScore > 0)).toBe(true);
	});

	it('excludes SESSION_LOG and META nodes from anchor search by default', () => {
		const sessionNode: GraphNode = {
			...fixture.nodes[0]!,
			id: 'Sessions/Session 99.md',
			title: 'Session 99 Барон Келд',
			aliases: [],
			type: 'SESSION_LOG',
			content: 'Барон Келд Барон Келд Барон Келд',
		};
		const metaNode: GraphNode = {
			...fixture.nodes[0]!,
			id: 'Meta/Index.md',
			title: 'Index Барон Келд',
			aliases: [],
			type: 'META',
			content: 'Барон Келд індекс',
		};
		const pool = [...fixture.nodes, sessionNode, metaNode];

		const defaultResults = searchBm25(pool, 'Барон Келд', 10);
		expect(
			defaultResults.some(
				(r) =>
					r.nodeId === 'Sessions/Session 99.md' ||
					r.nodeId === 'Meta/Index.md',
			),
		).toBe(false);

		const unfiltered = searchBm25(pool, 'Барон Келд', 10, {
			excludeTypes: [],
		});
		expect(
			unfiltered.some((r) => r.nodeId === 'Sessions/Session 99.md'),
		).toBe(true);
	});
});

describe('session event extraction validation & persistence helpers', () => {
	const fixture = loadMiniVault();

	it('validates fenced JSON arrays and rejects malformed payloads', () => {
		const fenced = [
			'```json',
			'[{"subjects":["Барон Келд"],"action":"вбивство","details":"Барона вбили.","stateChanges":[{"subject":"Барон Келд","newStatusType":"TERMINATED","newStatusNote":"вбитий"}]}]',
			'```',
		].join('\n');

		const valid = validateExtractedEventsJson(fenced);
		expect(valid.ok).toBe(true);
		if (valid.ok) {
			expect(valid.events).toHaveLength(1);
			expect(valid.events[0]?.stateChanges[0]?.newStatusType).toBe(
				'TERMINATED',
			);
		}

		const invalidStatus = validateExtractedEventsJson(
			'[{"subjects":["X"],"action":"тест","details":"Опис.","stateChanges":[{"subject":"X","newStatusType":"BROKEN","newStatusNote":""}]}]',
		);
		expect(invalidStatus.ok).toBe(false);

		const notJson = validateExtractedEventsJson('Ось події сесії...');
		expect(notJson.ok).toBe(false);
	});

	it('determines sessionId and splits large logs into chunks', () => {
		expect(
			determineSessionId({
				frontmatter: { session: 7 },
				title: 'Note',
				sessionNumberPattern: '(?:Сесія|Session)\\s*(\\d+)',
				existingEvents: fixture.events,
			}),
		).toBe(7);

		expect(
			determineSessionId({
				frontmatter: null,
				title: 'Сесія 14 — Падіння вежі',
				sessionNumberPattern: '(?:Сесія|Session)\\s*(\\d+)',
				existingEvents: fixture.events,
			}),
		).toBe(14);

		const longSection = `## Битва\n${Array.from({ length: 40 }, (_, i) => `Абзац ${i}: герої билися біля Болотяної вежі з нежиттю та культистами Гільдії Тіней.`).join('\n\n')}`;
		const chunks = splitSessionLogIntoChunks(longSection, 150);
		expect(chunks.length).toBeGreaterThan(1);
	});

	it('replaces events idempotently on re-parse and detects corrupted events.json', () => {
		const initial: SessionEvent[] = [
			{
				id: 'evt-old-1',
				sessionId: 2,
				sourceNoteId: 'Sessions/Session 2.md',
				subjects: ['Барон Келд'],
				subjectIds: ['World/NPC/Baron Keld.md'],
				action: 'вбивство',
				details: 'Агенти вбили Барона Келда.',
				stateChanges: [],
				userVerified: true,
				createdAt: 1000,
			},
			{
				id: 'evt-other-session',
				sessionId: 1,
				sourceNoteId: 'Sessions/Session 1.md',
				subjects: ['Окхейвен'],
				subjectIds: ['World/Locations/Oakhaven.md'],
				action: 'прибуття',
				details: 'Герої прибули до міста.',
				stateChanges: [],
				userVerified: true,
				createdAt: 900,
			},
		];

		const reparsedDrafts: SessionEvent[] = [
			{
				id: 'evt-new-temp',
				sessionId: 2,
				sourceNoteId: 'Sessions/Session 2.md',
				subjects: ['Барона Келда'],
				subjectIds: [],
				action: 'вбивство',
				details: 'Агенти вбили Барона Келда.',
				stateChanges: [],
				userVerified: false,
				createdAt: 2000,
			},
		];

		const merged = mergeReparsedSessionEvents({
			existingEvents: initial,
			sourceNoteId: 'Sessions/Session 2.md',
			sessionId: 2,
			newDrafts: reparsedDrafts,
			nodes: fixture.nodes,
		});

		// Must NOT duplicate Session 2 events, and must preserve Session 1 event
		expect(merged).toHaveLength(2);
		const s2 = merged.find((e) => e.sessionId === 2)!;
		expect(s2.id).toBe('evt-old-1');
		expect(s2.userVerified).toBe(true);
		expect(s2.subjectIds).toEqual(['World/NPC/Baron Keld.md']);

		expect(parsePersistedEventsFile('{ broken json').ok).toBe(false);
		const withStates = parsePersistedEventsFile(
			JSON.stringify({
				schemaVersion: 1,
				updatedAt: 1,
				events: initial,
				entityStates: {
					'World/NPC/Baron Keld.md': {
						statusType: 'TERMINATED',
						statusNote: 'убит',
						updatedAt: 1000,
					},
				},
			}),
		);
		expect(withStates.ok).toBe(true);
		expect(withStates.entityStates['World/NPC/Baron Keld.md']).toEqual({
			statusType: 'TERMINATED',
			statusNote: 'убит',
			updatedAt: 1000,
		});
	});

	it('builds language-specific session extraction prompts for uk, ru, and en', () => {
		const ruPrompt = getSessionExtractionSystemPrompt('ru');
		expect(ruPrompt).toContain('НА РУССКОМ ЯЗЫКЕ');
		expect(ruPrompt).toContain('захват власти');

		const ukPrompt = getSessionExtractionSystemPrompt('uk');
		expect(ukPrompt).toContain('УКРАЇНСЬКОЮ МОВОЮ');
		expect(ukPrompt).toContain('захоплення влади');

		const enPrompt = getSessionExtractionSystemPrompt('en');
		expect(enPrompt).toContain('IN ENGLISH');
		expect(enPrompt).toContain('seizure of power');
	});

	it('restricts session folder membership strictly to configured sessionFolder', () => {
		expect(isPathInSessionFolder('Sessions/Session 1.md', 'Sessions')).toBe(
			true,
		);
		expect(
			isPathInSessionFolder('sessions\\arc1\\session-2.md', '/Sessions/'),
		).toBe(true);
		expect(isPathInSessionFolder('World/NPC/Baron Keld.md', 'Sessions')).toBe(
			false,
		);
		expect(isPathInSessionFolder('SessionsOld/Session 0.md', 'Sessions')).toBe(
			false,
		);
		expect(isPathInSessionFolder('Sessions/Session 1.md', '')).toBe(false);
	});
});
