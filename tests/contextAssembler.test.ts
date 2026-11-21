import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
	normalizeBm25Scores,
	rankSectionsByBm25,
	searchBm25,
} from '../src/core/bm25';
import { assembleContext } from '../src/core/contextAssembler';
import { detectEntityMentionsInText } from '../src/core/entityMatcher';
import {
	classifyIntent,
	classifyIntentWithLlmFallback,
} from '../src/core/intentRouter';
import {
	computeDampedDegree,
	computeNodeRecency,
	computeTypeBoost,
} from '../src/core/scoring';
import { DEFAULT_SETTINGS, deepMergeSettings } from '../src/settings';
import type {
	GraphEdge,
	GraphNode,
	PluginSettings,
	SessionEvent,
} from '../src/types';

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

function makeSettings(overrides?: Partial<PluginSettings>): PluginSettings {
	return deepMergeSettings(DEFAULT_SETTINGS, {
		uiLanguage: 'uk',
		...overrides,
	});
}

describe('intentRouter & entity mention detection', () => {
	const fixture = loadMiniVault();

	it('classifies MECHANICS, PLOT_LIGHT, and PLOT_DEEP queries in uk, ru, and en', () => {
		const mechUk = classifyIntent(
			'Зроби стат-блок ворога CR 5 з балансом бою',
			fixture.nodes,
		);
		expect(mechUk.mode).toBe('MECHANICS');

		const mechRu = classifyIntent(
			'Помоги рассчитать баланс столкновения, КБ 16 и спасбросок',
			fixture.nodes,
		);
		expect(mechRu.mode).toBe('MECHANICS');

		const mechEn = classifyIntent(
			'Build an encounter balance with CR 4 and AC 17',
			fixture.nodes,
		);
		expect(mechEn.mode).toBe('MECHANICS');

		const lightRu = classifyIntent(
			'Кто такой Архіваріус Ворн?',
			fixture.nodes,
		);
		expect(lightRu.mode).toBe('PLOT_LIGHT');
		expect(lightRu.preferredTypes).toContain('NPC');

		const deepUk = classifyIntent(
			'Що буде, якщо Гільдія Тіней влаштує переворот за владу в Окхейвені?',
			fixture.nodes,
		);
		expect(deepUk.mode).toBe('PLOT_DEEP');
		expect(deepUk.preferredTypes).toContain('FACTION');
	});

	it('detects multiple campaign entity mentions via entityMatcher and routes to PLOT_DEEP', () => {
		const mentions = detectEntityMentionsInText(
			'Який звязок між Срібна Корона та Гільдія Тіней?',
			fixture.nodes,
		);
		expect(mentions).toContain('World/Factions/Silver Crown.md');
		expect(mentions).toContain('World/Factions/Shadow Guild.md');

		const multiIntent = classifyIntent(
			'Порівняй Срібна Корона і Гільдія Тіней',
			fixture.nodes,
		);
		expect(multiIntent.mode).toBe('PLOT_DEEP');
		expect(multiIntent.confidence).toBeGreaterThanOrEqual(0.7);
	});

	it('invokes injected LLM fallback only when rule confidence is low', async () => {
		const llmSpy = vi.fn(async () => ({
			mode: 'PLOT_DEEP' as const,
			preferredTypes: ['FACTION' as const],
			confidence: 0.88,
		}));

		const clearRes = await classifyIntentWithLlmFallback({
			query: 'Зроби стат-блок CR 3',
			nodes: fixture.nodes,
			llmClassifier: llmSpy,
		});
		expect(clearRes.mode).toBe('MECHANICS');
		expect(llmSpy).not.toHaveBeenCalled();

		const ambiguousRes = await classifyIntentWithLlmFallback({
			query: 'Що далі робити?',
			nodes: fixture.nodes,
			llmClassifier: llmSpy,
		});
		expect(llmSpy).toHaveBeenCalledTimes(1);
		expect(ambiguousRes.mode).toBe('PLOT_DEEP');
		expect(ambiguousRes.matchedKeywords).toContain('llm_fallback');
	});
});

describe('BM25 min-max normalization, sections & scoring', () => {
	const fixture = loadMiniVault();

	it('min-max normalizes BM25 scores within a query into [0, 1]', () => {
		const raw = searchBm25(fixture.nodes, 'Окхейвен Барон', 10);
		expect(raw.length).toBeGreaterThan(1);

		const norm = normalizeBm25Scores(raw);
		expect(norm[0]?.score).toBe(1);
		expect(norm[norm.length - 1]?.score).toBeCloseTo(0.05, 5);
		for (const item of norm) {
			expect(item.score).toBeGreaterThanOrEqual(0);
			expect(item.score).toBeLessThanOrEqual(1);
		}
	});

	it('ranks relevant sections of a long note higher via BM25', () => {
		const sections = [
			{
				heading: '',
				content: 'Короткий загальний вступ про стародавній рід.',
				tokenCount: 15,
			},
			{
				heading: 'Підземелля та пастки',
				content:
					'Глибоко під вежею сховано таємний ритуальний вівтар некроманта.',
				tokenCount: 22,
			},
			{
				heading: 'Торгівля',
				content: 'Місцеві купці торгують сіллю та рибою.',
				tokenCount: 14,
			},
		];

		const ranked = rankSectionsByBm25(sections, 'таємний вівтар некроманта');
		expect(ranked[0]?.index).toBe(1);
		expect(ranked[0]?.score).toBe(1);
	});

	it('dampens META hub nodes and respects disableTypePriority & recency', () => {
		const metaNode = fixture.nodes.find(
			(n) => n.id === 'Meta/World Index.md',
		)!;
		const baronNode = fixture.nodes.find(
			(n) => n.id === 'World/NPC/Baron Keld.md',
		)!;

		const metaDeg = computeDampedDegree(metaNode, 10);
		const baronDeg = computeDampedDegree(baronNode, 10);
		expect(metaDeg).toBeLessThan(baronDeg);

		expect(computeTypeBoost('FACTION', ['FACTION', 'NPC'], false)).toBe(1);
		expect(computeTypeBoost('FACTION', ['FACTION', 'NPC'], true)).toBe(0);

		const unverifiedOnly: SessionEvent[] = [
			{
				...fixture.events[0]!,
				userVerified: false,
			},
		];
		expect(computeNodeRecency(baronNode.id, fixture.events, 2)).toBe(1);
		expect(computeNodeRecency(baronNode.id, unverifiedOnly, 2)).toBe(0);
	});
});

describe('contextAssembler (Stage 5 core)', () => {
	const fixture = loadMiniVault();

	it('uses 0 vault tokens in MECHANICS mode and returns injected rules text', () => {
		const rules = 'Custom TTRPG Combat Rules: AC and CR guide.';
		const res = assembleContext({
			query: 'Зроби стат-блок CR 5',
			requestedMode: 'AUTO',
			nodes: fixture.nodes,
			edges: fixture.edges,
			events: fixture.events,
			settings: makeSettings(),
			mechanicsRulesText: rules,
		});

		expect(res.trace.resolvedMode).toBe('MECHANICS');
		expect(res.trace.baseLoreTokens).toBe(0);
		expect(res.trace.eventsTokens).toBe(0);
		expect(res.trace.totalTokensUsed).toBe(0);
		expect(res.trace.candidates).toEqual([]);
		expect(res.contextText).toBe(rules);
	});

	it('includes CUSTOM selected notes verbatim with no neighbor traversal or budget cap', () => {
		const tinyBudgetSettings = makeSettings({
			tokenBudgetDeep: 5,
		});

		const res = assembleContext({
			query: 'custom',
			requestedMode: 'CUSTOM',
			nodes: fixture.nodes,
			edges: fixture.edges,
			events: fixture.events,
			settings: tinyBudgetSettings,
			customNodeIds: [
				'Lore/Ancient Myth.md',
				'World/Items/Sunblade.md',
			],
		});

		expect(res.trace.resolvedMode).toBe('CUSTOM');
		expect(res.trace.candidates).toHaveLength(2);
		expect(res.trace.candidates.every((c) => c.included)).toBe(true);
		expect(res.trace.candidates.every((c) => c.inclusionReason === 'custom_selection')).toBe(true);
		expect(res.trace.totalTokensUsed).toBeGreaterThan(tinyBudgetSettings.tokenBudgetDeep);
		expect(res.contextText).toContain('Ancient Myth');
		expect(res.contextText).toContain('Sunblade');
	});

	it('handles empty graph and queries with no anchors gracefully', () => {
		const emptyRes = assembleContext({
			query: 'Барон Келд',
			requestedMode: 'PLOT_DEEP',
			nodes: [],
			edges: [],
			events: [],
			settings: makeSettings(),
		});
		expect(emptyRes.contextText).toBe('');
		expect(emptyRes.trace.totalTokensUsed).toBe(0);
		expect(emptyRes.trace.candidates).toEqual([]);

		const noAnchorRes = assembleContext({
			query: 'zzzzqxxxyyyunrelatedtoken',
			requestedMode: 'PLOT_DEEP',
			nodes: fixture.nodes,
			edges: fixture.edges,
			events: fixture.events,
			settings: makeSettings(),
			anchorMatches: [],
		});
		expect(noAnchorRes.contextText).toBe('');
		expect(noAnchorRes.trace.anchorIds).toEqual([]);
		expect(noAnchorRes.trace.candidates).toEqual([]);
	});

	it('caps events block by eventsBudgetShare and excludes unverified events', () => {
		const manyEvents: SessionEvent[] = [
			...fixture.events,
			{
				id: 'evt-unverified-spoiler',
				sessionId: 99,
				sourceNoteId: 'Sessions/Session 99.md',
				subjects: ['Барон Келд'],
				subjectIds: ['World/NPC/Baron Keld.md'],
				action: 'воскресіння (неперевірено)',
				details: 'Барон Келд нібито воскрес (чернетка без підтвердження).',
				stateChanges: [
					{
						subject: 'Барон Келд',
						newStatusType: 'ACTIVE',
						newStatusNote: 'живий знову',
					},
				],
				userVerified: false,
				createdAt: 9999999999,
			},
			...Array.from({ length: 12 }, (_, idx) => ({
				id: `evt-bulk-${idx}`,
				sessionId: 10 + idx,
				sourceNoteId: `Sessions/Session ${10 + idx}.md`,
				subjects: ['Окхейвен', 'Барон Келд'],
				subjectIds: [
					'World/Locations/Oakhaven.md',
					'World/NPC/Baron Keld.md',
				],
				action: `подія ${idx}`,
				details:
					'Дуже детальний опис наслідків політичної кризи у портовому місті Окхейвен та переговорів між фракціями.',
				stateChanges: [],
				userVerified: true,
				createdAt: 1700001000 + idx,
			})),
		];

		const settings = makeSettings({
			tokenBudgetLight: 450,
			eventsBudgetShare: 0.35,
		});

		const res = assembleContext({
			query: 'Торгівля в Окхейвені',
			requestedMode: 'PLOT_LIGHT',
			nodes: fixture.nodes,
			edges: fixture.edges,
			events: manyEvents,
			settings,
			anchorMatches: [
				{
					nodeId: 'World/Locations/Oakhaven.md',
					score: 1,
					lexicalScore: 5,
					vectorScore: 0,
				},
			],
		});

		const maxAllowedEventsTokens = Math.floor(res.trace.tokenBudget * 0.35);
		expect(res.trace.eventsTokens).toBeLessThanOrEqual(maxAllowedEventsTokens);
		expect(res.trace.includedEventIds).not.toContain('evt-unverified-spoiler');
		expect(res.contextText).not.toContain('воскресіння (неперевірено)');
		// Newest verified event must come first
		expect(res.trace.includedEventIds[0]).toBe('evt-bulk-11');
	});

	it('marks state-override warning on 1-hop neighbor and disables it under disableTemporalStratification', () => {
		// Anchor is Oakhaven (hop 0); Baron Keld is reached as 1-hop neighbor (hop 1)
		const params = {
			query: 'Портовий торг',
			requestedMode: 'PLOT_LIGHT' as const,
			nodes: fixture.nodes,
			edges: fixture.edges,
			events: fixture.events,
			anchorMatches: [
				{
					nodeId: 'World/Locations/Oakhaven.md',
					score: 1,
					lexicalScore: 4,
					vectorScore: 0,
				},
			],
		};

		const fullRes = assembleContext({
			...params,
			settings: makeSettings(),
		});

		const baronCandidate = fullRes.trace.candidates.find(
			(c) => c.nodeId === 'World/NPC/Baron Keld.md',
		);
		expect(baronCandidate).toBeDefined();
		expect(baronCandidate?.hopDistance).toBe(1);
		expect(baronCandidate?.inclusionReason).toBe('graph_neighbor');
		expect(baronCandidate?.effectiveState.statusType).toBe('TERMINATED');
		expect(fullRes.contextText).toContain(
			'### [[Baron Keld]] (NPC; стан: TERMINATED — вбитий під час заколоту) ⚠ Станом на сесію #2',
		);

		const noTemporalRes = assembleContext({
			...params,
			settings: makeSettings({
				experiment: {
					disableGraphTraversal: false,
					disableTemporalStratification: true,
					disableTypePriority: false,
					logRetrievalTraces: false,
				},
			}),
		});

		expect(noTemporalRes.trace.eventsTokens).toBe(0);
		expect(noTemporalRes.trace.includedEventIds).toEqual([]);
		expect(noTemporalRes.contextText).not.toContain('[АКТУАЛЬНІ ПОДІЇ]');
		expect(noTemporalRes.contextText).not.toContain('⚠');
	});

	it('prevents hub flooding, excludes ignored nodes, limits 1-hop expansion, and fills baseline budget under disableGraphTraversal', () => {
		// GraphRAG PLOT_DEEP: hub Meta/World Index.md & Archive/Old Draft.md must stay out
		const graphRes = assembleContext({
			query: 'Що буде з Окхейвеном?',
			requestedMode: 'PLOT_DEEP',
			nodes: fixture.nodes,
			edges: fixture.edges,
			events: fixture.events,
			settings: makeSettings({ firstHopMaxCandidates: 2 }),
			activePoolIds: ['Archive/Old Draft.md', 'World/Items/Sunblade.md'],
		});

		const candidateIds = new Set(graphRes.trace.candidates.map((c) => c.nodeId));
		expect(candidateIds.has('Meta/World Index.md')).toBe(false);
		expect(candidateIds.has('Sessions/Session 1.md')).toBe(false);

		const ignoredTrace = graphRes.trace.candidates.find(
			(c) => c.nodeId === 'Archive/Old Draft.md',
		);
		expect(ignoredTrace?.included).toBe(false);
		expect(ignoredTrace?.exclusionReason).toBe('ignored');

		const poolTrace = graphRes.trace.candidates.find(
			(c) => c.nodeId === 'World/Items/Sunblade.md',
		);
		expect(poolTrace?.included).toBe(true);
		expect(poolTrace?.inclusionReason).toBe('entity_pool');

		// Fair Vector-RAG baseline: disableGraphTraversal packs top-N semantic matches (> 3)
		const manyMatches = fixture.nodes
			.filter((n) => n.type !== 'SESSION_LOG' && n.type !== 'META' && !n.metadata?.ai_ignore)
			.map((n, idx) => ({
				nodeId: n.id,
				score: Number((1 - idx * 0.05).toFixed(2)),
				lexicalScore: 1,
				vectorScore: Number((1 - idx * 0.05).toFixed(2)),
			}));

		const baselineRes = assembleContext({
			query: 'Велика кампанія Окхейвен',
			requestedMode: 'PLOT_DEEP',
			nodes: fixture.nodes,
			edges: fixture.edges,
			events: fixture.events,
			settings: makeSettings({
				experiment: {
					disableGraphTraversal: true,
					disableTemporalStratification: false,
					disableTypePriority: false,
					logRetrievalTraces: false,
				},
			}),
			anchorMatches: manyMatches,
		});

		const includedBaseline = baselineRes.trace.candidates.filter((c) => c.included);
		expect(includedBaseline.length).toBeGreaterThan(3);
		expect(includedBaseline.every((c) => c.hopDistance === 0)).toBe(true);
	});

	it('is strictly deterministic and matches golden contextText format snapshot', () => {
		const baron = fixture.nodes.find(
			(n) => n.id === 'World/NPC/Baron Keld.md',
		)!;
		const oakhaven = fixture.nodes.find(
			(n) => n.id === 'World/Locations/Oakhaven.md',
		)!;
		const miniEdges: GraphEdge[] = [
			{
				sourceId: baron.id,
				targetId: oakhaven.id,
				kind: 'LINK',
			},
		];

		const input = {
			query: 'Барон Келд',
			requestedMode: 'PLOT_LIGHT' as const,
			nodes: [baron, oakhaven],
			edges: miniEdges,
			events: fixture.events,
			settings: makeSettings(),
			anchorMatches: [
				{
					nodeId: baron.id,
					score: 1,
					lexicalScore: 3,
					vectorScore: 0,
				},
			],
			now: 1700009999,
		};

		const run1 = assembleContext(input);
		const run2 = assembleContext(input);
		expect(run1).toEqual(run2);

		expect(run1.contextText).toBe(
			[
				'[БАЗОВИЙ ЛОР]',
				'',
				'### [[Baron Keld]] (NPC; стан: TERMINATED — вбитий під час заколоту) ⚠ Станом на сесію #2',
				'Барон Келд — правитель [[World/Locations/Oakhaven.md|Окхейвена]], союзник [[World/Factions/Silver Crown.md|Срібної Корони]].',
				'',
				'### [[Oakhaven]] (LOCATION; стан: ACTIVE — відвідано)',
				'Портове місто на перехресті торгових шляхів.',
				'',
				'[АКТУАЛЬНІ ПОДІЇ]',
				'- Сесія 2: вбивство: Агенти Гільдії Тіней вбили Барона Келда під час перевороту в Окхейвені. (суб\'єкти: [[Baron Keld]], [[World/Factions/Shadow Guild.md]]) ⚠ Стан [[Барон Келд]]: TERMINATED — вбитий під час заколоту',
			].join('\n'),
		);
	});

	it('prioritizes ALL strictly mentioned NPCs beyond anchorLimit=3 across inflections and avoids false positives', () => {
		// Mention 4 distinct NPCs in oblique cases: must all 4 be in anchorIds & included!
		const fourNpcRes = assembleContext({
			query: 'Що станеться, якщо зустрінуться Бароном Келдом, Капітаном Мірою, Архіваріусом Ворном та Ковалем Торіном?',
			requestedMode: 'AUTO',
			nodes: fixture.nodes,
			edges: fixture.edges,
			events: fixture.events,
			settings: makeSettings(),
			// Competing high-scoring non-mentioned note from vector search:
			anchorMatches: [
				{
					nodeId: 'World/Locations/Rusty Anchor Tavern.md',
					score: 1,
					lexicalScore: 0,
					vectorScore: 1,
				},
			],
		});

		expect(fourNpcRes.trace.resolvedMode).toBe('PLOT_DEEP');
		expect(fourNpcRes.trace.anchorIds).toContain('World/NPC/Baron Keld.md');
		expect(fourNpcRes.trace.anchorIds).toContain('World/NPC/Captain Mira.md');
		expect(fourNpcRes.trace.anchorIds).toContain('World/NPC/Archivist Vorn.md');
		expect(fourNpcRes.trace.anchorIds).toContain('World/NPC/Blacksmith Torin.md');

		const includedIds = new Set(
			fourNpcRes.trace.candidates.filter((c) => c.included).map((c) => c.nodeId),
		);
		expect(includedIds.has('World/NPC/Baron Keld.md')).toBe(true);
		expect(includedIds.has('World/NPC/Captain Mira.md')).toBe(true);
		expect(includedIds.has('World/NPC/Archivist Vorn.md')).toBe(true);
		expect(includedIds.has('World/NPC/Blacksmith Torin.md')).toBe(true);

		// Also verify 1-word capitalized inflected aliases ("Келдом", "Мірою") + [[wikilink]]
		const singleWordAliasMentions = detectEntityMentionsInText(
			'Куда ушли Келдом с [[Archivist Vorn]] и Мірою?',
			fixture.nodes,
		);
		expect(singleWordAliasMentions).toEqual([
			'World/NPC/Archivist Vorn.md',
			'World/NPC/Baron Keld.md',
			'World/NPC/Captain Mira.md',
		]);

		// False-positive protection: lowercase verbs/nouns and stopword quest/city titles must NOT trigger
		const trapNodes: GraphNode[] = [
			...fixture.nodes,
			{
				...fixture.nodes[0]!,
				id: 'World/Quests/Вернулись.md',
				title: 'Вернулись',
				aliases: [],
				type: 'QUEST',
				content: 'Квест со случайным названием.',
			},
			{
				...fixture.nodes[0]!,
				id: 'World/Quests/Когда герои вернулись.md',
				title: 'Когда герои вернулись',
				aliases: [],
				type: 'QUEST',
				content: 'Длинный заголовок квеста.',
			},
			{
				...fixture.nodes[0]!,
				id: 'World/Locations/Город.md',
				title: 'Город',
				aliases: [],
				type: 'LOCATION',
				content: 'Общая локация.',
			},
		];

		expect(
			detectEntityMentionsInText(
				'Игроки вернулись с задания в город',
				trapNodes,
			),
		).toEqual([]);
		expect(
			detectEntityMentionsInText(
				'Вернулись с задания без упомянутых имён',
				trapNodes,
			),
		).toEqual([]);
		// Fuzzy typo should NOT match in strict free-text query scanning
		expect(
			detectEntityMentionsInText('Что делал Барон Кедл в таверне?', trapNodes),
		).toEqual([]);
	});
});
