import type {
	AssembledContext,
	CandidateExclusionReason,
	CandidateInclusionReason,
	EntityState,
	GraphEdge,
	GraphNode,
	IntentClassification,
	PluginSettings,
	RetrievalMode,
	SessionEvent,
	TracedCandidate,
	UiLanguage,
} from '../types';
import {
	DEFAULT_ANCHOR_EXCLUDED_TYPES,
	fuseHybridRankings,
	normalizeBm25Scores,
	rankSectionsByBm25,
	searchBm25,
	type HybridAnchorMatch,
} from './bm25';
import { detectEntityMentionsInText } from './entityMatcher';
import { filterIgnoredGraph, traverseGraph, type TraversalVisit } from './graphAlgo';
import { classifyIntent } from './intentRouter';
import { scoreCandidate } from './scoring';
import { resolveEffectiveState } from './stateResolver';
import { normalizeText } from './statusRules';
import { estimateTokens } from './tokenizer';

const TOKEN_SAFETY_FACTOR = 0.9;
const LIGHT_ANCHOR_LIMIT = 1;
const DEEP_ANCHOR_LIMIT = 3;
const DIRECT_MENTION_MIN_SEMANTIC = 1.0;

interface ContextLabels {
	baseLore: string;
	recentEvents: string;
	status: string;
	override: string;
	sessionPrefix: string;
	subjects: string;
	stateLabel: string;
}

const CONTEXT_LABELS: Record<UiLanguage, ContextLabels> = {
	uk: {
		baseLore: '[БАЗОВИЙ ЛОР]',
		recentEvents: '[АКТУАЛЬНІ ПОДІЇ]',
		status: 'стан',
		override: 'Станом на сесію',
		sessionPrefix: 'Сесія',
		subjects: "суб'єкти",
		stateLabel: 'Стан',
	},
	ru: {
		baseLore: '[БАЗОВЫЙ ЛОР]',
		recentEvents: '[АКТУАЛЬНЫЕ СОБЫТИЯ]',
		status: 'состояние',
		override: 'По состоянию на сессию',
		sessionPrefix: 'Сессия',
		subjects: 'субъекты',
		stateLabel: 'Состояние',
	},
	en: {
		baseLore: '[BASE LORE]',
		recentEvents: '[RECENT EVENTS]',
		status: 'status',
		override: 'As of session',
		sessionPrefix: 'Session',
		subjects: 'subjects',
		stateLabel: 'State',
	},
};

export interface AssembleContextParams {
	query: string;
	requestedMode: RetrievalMode;
	nodes: GraphNode[];
	edges: GraphEdge[];
	events: SessionEvent[];
	settings: PluginSettings;
	anchorMatches?: HybridAnchorMatch[];
	activePoolIds?: string[];
	customNodeIds?: string[];
	mechanicsRulesText?: string;
	intentOverride?: IntentClassification;
	now?: number;
}

function isNodeIgnored(node: GraphNode): boolean {
	return node.metadata?.ai_ignore === true;
}

function formatStateNoteSuffix(statusNote: string): string {
	const clean = statusNote.trim();
	return clean ? ` — ${clean}` : '';
}

function formatNodeHeader(
	node: GraphNode,
	effectiveState: EntityState,
	labels: ContextLabels,
	disableTemporalStratification: boolean,
): string {
	const hasEventOverride =
		!disableTemporalStratification &&
		effectiveState.source === 'EVENT' &&
		effectiveState.sessionUpdated !== null &&
		(effectiveState.statusType !== node.staticState.statusType ||
			effectiveState.statusNote !== node.staticState.statusNote);

	const noteSuffix = formatStateNoteSuffix(effectiveState.statusNote);
	const baseHeader = `### [[${node.title}]] (${node.type}; ${labels.status}: ${effectiveState.statusType}${noteSuffix})`;

	if (!hasEventOverride || effectiveState.sessionUpdated === null) {
		return baseHeader;
	}

	return `${baseHeader} ⚠ ${labels.override} #${effectiveState.sessionUpdated}`;
}

function formatEventLine(
	event: SessionEvent,
	nodeById: Map<string, GraphNode>,
	labels: ContextLabels,
): string {
	const resolvedNames =
		event.subjectIds.length > 0
			? event.subjectIds.map((id) => nodeById.get(id)?.title ?? id)
			: event.subjects;

	const uniqueNames = Array.from(
		new Set(resolvedNames.map((n) => n.trim()).filter((n) => n.length > 0)),
	);
	const subjectsText =
		uniqueNames.length > 0
			? ` (${labels.subjects}: ${uniqueNames.map((n) => `[[${n}]]`).join(', ')})`
			: '';

	const stateChangeText =
		event.stateChanges.length > 0
			? ' ' +
				event.stateChanges
					.map((sc) => {
						const noteSuffix = formatStateNoteSuffix(
							sc.newStatusNote,
						);
						return `⚠ ${labels.stateLabel} [[${sc.subject}]]: ${sc.newStatusType}${noteSuffix}`;
					})
					.join('; ')
			: '';

	const summaryParts = [event.action.trim(), event.details.trim()].filter(
		(part) => part.length > 0,
	);
	const summary = summaryParts.join(': ');

	return `- ${labels.sessionPrefix} ${event.sessionId}: ${summary}${subjectsText}${stateChangeText}`;
}

function eventTouchesCandidate(
	event: SessionEvent,
	relevantIds: Set<string>,
	candidateNodes: GraphNode[],
	nodeNormalizedNames: Map<string, Set<string>>,
): boolean {
	for (const id of event.subjectIds) {
		if (relevantIds.has(id)) {
			return true;
		}
	}
	if (event.stateChanges.length === 0) {
		return false;
	}
	for (const node of candidateNodes) {
		const names = nodeNormalizedNames.get(node.id);
		if (!names) {
			continue;
		}
		for (const sc of event.stateChanges) {
			const clean = normalizeText(sc.subject);
			if (clean && names.has(clean)) {
				return true;
			}
		}
	}
	return false;
}

function buildSectionFitBlock(
	node: GraphNode,
	header: string,
	query: string,
	remainingBudget: number,
): { text: string; tokens: number; includedSections: string[] } | null {
	const fullBlock = `${header}\n${node.content}`.trim();
	const fullTokens = estimateTokens(`${fullBlock}\n\n`);
	if (fullTokens <= remainingBudget) {
		return {
			text: fullBlock,
			tokens: fullTokens,
			includedSections: node.sections.map((s) => s.heading),
		};
	}

	if (node.sections.length > 1) {
		const rankedSections = rankSectionsByBm25(node.sections, query);
		const pickedIndices: number[] = [];
		let headerAndGapTokens = estimateTokens(`${header}\n`);

		const buildTextFromIndices = (indices: number[]): string => {
			const ordered = [...indices].sort((a, b) => a - b);
			const body = ordered
				.map((idx) => {
					const sec = node.sections[idx]!;
					return sec.heading
						? `#### ${sec.heading}\n${sec.content}`
						: sec.content;
				})
				.join('\n\n');
			return `${header}\n${body}`.trim();
		};

		for (const ranked of rankedSections) {
			const nextIndices = [...pickedIndices, ranked.index];
			const candidateText = buildTextFromIndices(nextIndices);
			const candidateTokens = estimateTokens(`${candidateText}\n\n`);
			if (candidateTokens <= remainingBudget) {
				pickedIndices.push(ranked.index);
				headerAndGapTokens = candidateTokens;
			}
		}

		if (pickedIndices.length > 0 && headerAndGapTokens <= remainingBudget) {
			const finalOrdered = [...pickedIndices].sort((a, b) => a - b);
			return {
				text: buildTextFromIndices(finalOrdered),
				tokens: headerAndGapTokens,
				includedSections: finalOrdered.map(
					(idx) => node.sections[idx]!.heading,
				),
			};
		}
	}

	const firstParagraph = node.content
		.split(/\r?\n\r?\n/)
		.map((p) => p.trim())
		.find((p) => p.length > 0);
	if (firstParagraph) {
		const truncatedBlock = `${header}\n${firstParagraph}…`.trim();
		const truncatedTokens = estimateTokens(`${truncatedBlock}\n\n`);
		if (truncatedTokens <= remainingBudget) {
			return {
				text: truncatedBlock,
				tokens: truncatedTokens,
				includedSections: node.sections[0]
					? [node.sections[0].heading]
					: [],
			};
		}
	}

	return null;
}

/**
 * Pure, deterministic GraphRAG context assembler.
 * Performs intent routing, anchor selection, depth-limited graph traversal,
 * multi-factor scoring with hub damping, temporal event stratification,
 * single-pass token budget packing, and full `RetrievalTrace` emission.
 */
export function assembleContext(params: AssembleContextParams): AssembledContext {
	const now = params.now ?? Date.now();
	const settings = params.settings;
	const labels = CONTEXT_LABELS[settings.uiLanguage] ?? CONTEXT_LABELS.uk;
	const excludedTypeSet = new Set(DEFAULT_ANCHOR_EXCLUDED_TYPES);

	const ignoredNodes = params.nodes.filter(isNodeIgnored);
	const ignoredIdSet = new Set(ignoredNodes.map((n) => n.id));
	const { nodes: activeNodes, edges: activeEdges } = filterIgnoredGraph(
		params.nodes,
		params.edges,
		ignoredIdSet,
	);
	const nodeById = new Map(activeNodes.map((node) => [node.id, node]));
	const eligibleAnchorNodes = activeNodes.filter(
		(node) => !excludedTypeSet.has(node.type),
	);

	// 1. Intent classification (or explicit mode override)
	const inferredIntent =
		params.intentOverride ?? classifyIntent(params.query, eligibleAnchorNodes);
	const resolvedMode: Exclude<RetrievalMode, 'AUTO'> =
		params.requestedMode === 'AUTO'
			? inferredIntent.mode
			: params.requestedMode;
	const intentConfidence =
		params.requestedMode === 'AUTO' ? inferredIntent.confidence : 1;
	const preferredTypes =
		resolvedMode === 'MECHANICS' ? [] : inferredIntent.preferredTypes;

	// 2. MECHANICS mode: 0 vault tokens, rules prompt only
	if (resolvedMode === 'MECHANICS') {
		return {
			contextText: (params.mechanicsRulesText ?? '').trim(),
			trace: {
				query: params.query,
				requestedMode: params.requestedMode,
				resolvedMode: 'MECHANICS',
				intentConfidence,
				preferredTypes: [],
				anchorIds: [],
				activeEntityPoolIds: [],
				candidates: [],
				includedEventIds: [],
				eventsTokens: 0,
				baseLoreTokens: 0,
				totalTokensUsed: 0,
				tokenBudget: 0,
				timestamp: now,
			},
		};
	}

	const verifiedEvents = params.events
		.filter((event) => event.userVerified === true)
		.sort((a, b) => {
			if (b.sessionId !== a.sessionId) {
				return b.sessionId - a.sessionId;
			}
			if (b.createdAt !== a.createdAt) {
				return b.createdAt - a.createdAt;
			}
			return a.id.localeCompare(b.id);
		});

	// 3. CUSTOM mode: selected notes verbatim, no traversal, no budget truncation
	if (resolvedMode === 'CUSTOM') {
		const selectedIds = Array.from(
			new Set(
				(params.customNodeIds ?? []).filter((id) => nodeById.has(id)),
			),
		).sort((a, b) => a.localeCompare(b));

		const customCandidates: TracedCandidate[] = [];
		const loreBlocks: string[] = [];

		for (const id of selectedIds) {
			const node = nodeById.get(id)!;
			const effectiveState = settings.experiment
				.disableTemporalStratification
				? { ...node.staticState }
				: resolveEffectiveState(node, verifiedEvents);
			const header = formatNodeHeader(
				node,
				effectiveState,
				labels,
				settings.experiment.disableTemporalStratification,
			);
			const block = `${header}\n${node.content}`.trim();
			const blockTokens = estimateTokens(`${block}\n\n`);
			loreBlocks.push(block);

			customCandidates.push({
				nodeId: node.id,
				title: node.title,
				type: node.type,
				effectiveState,
				hopDistance: 0,
				path: [node.id],
				scoreBreakdown: {
					semantic: 1,
					proximity: 1,
					typeBoost: 0,
					degree: 0,
					recency: 0,
					total: 1,
				},
				included: true,
				inclusionReason: 'custom_selection',
				includedSections: node.sections.map((s) => s.heading),
				tokenCount: blockTokens,
			});
		}

		const selectedSet = new Set(selectedIds);
		const eventLines: string[] = [];
		const includedEventIds: string[] = [];
		if (!settings.experiment.disableTemporalStratification) {
			for (const evt of verifiedEvents) {
				if (evt.subjectIds.some((id) => selectedSet.has(id))) {
					eventLines.push(formatEventLine(evt, nodeById, labels));
					includedEventIds.push(evt.id);
				}
			}
		}

		const sectionsOut: string[] = [];
		const baseLoreText =
			loreBlocks.length > 0
				? `${labels.baseLore}\n\n${loreBlocks.join('\n\n')}`
				: '';
		const eventsText =
			eventLines.length > 0
				? `${labels.recentEvents}\n${eventLines.join('\n')}`
				: '';

		if (baseLoreText) {
			sectionsOut.push(baseLoreText);
		}
		if (eventsText) {
			sectionsOut.push(eventsText);
		}

		const baseLoreTokens = baseLoreText ? estimateTokens(baseLoreText) : 0;
		const eventsTokens = eventsText ? estimateTokens(eventsText) : 0;
		const contextText = sectionsOut.join('\n\n');

		return {
			contextText,
			trace: {
				query: params.query,
				requestedMode: params.requestedMode,
				resolvedMode: 'CUSTOM',
				intentConfidence: 1,
				preferredTypes: [],
				anchorIds: [],
				activeEntityPoolIds: [],
				candidates: customCandidates,
				includedEventIds,
				eventsTokens,
				baseLoreTokens,
				totalTokensUsed: baseLoreTokens + eventsTokens,
				tokenBudget: settings.tokenBudgetDeep,
				timestamp: now,
			},
		};
	}

	// 4. PLOT_LIGHT / PLOT_DEEP setup & single safety-margin calculation
	const rawTokenBudget =
		resolvedMode === 'PLOT_LIGHT'
			? settings.tokenBudgetLight
			: settings.tokenBudgetDeep;
	const effectiveBudget = Math.max(
		0,
		Math.floor(rawTokenBudget * TOKEN_SAFETY_FACTOR),
	);

	const activePoolIds = Array.from(
		new Set((params.activePoolIds ?? []).filter((id) => nodeById.has(id))),
	);
	const activePoolSet = new Set(activePoolIds);

	// Empty graph quick return
	if (activeNodes.length === 0) {
		return {
			contextText: '',
			trace: {
				query: params.query,
				requestedMode: params.requestedMode,
				resolvedMode,
				intentConfidence,
				preferredTypes,
				anchorIds: [],
				activeEntityPoolIds: [],
				candidates: [],
				includedEventIds: [],
				eventsTokens: 0,
				baseLoreTokens: 0,
				totalTokensUsed: 0,
				tokenBudget: effectiveBudget,
				timestamp: now,
			},
		};
	}

	// Semantic & lexical scores across eligible nodes
	const rawBm25All = searchBm25(
		eligibleAnchorNodes,
		params.query,
		Math.max(50, eligibleAnchorNodes.length),
	);
	const normBm25All = normalizeBm25Scores(rawBm25All);
	const bm25NormMap = new Map(normBm25All.map((r) => [r.nodeId, r.score]));

	const baseHybridMatches =
		params.anchorMatches ??
		fuseHybridRankings(
			rawBm25All,
			[],
			Math.max(50, eligibleAnchorNodes.length),
		);

	const semanticByNodeId = new Map<string, number>();
	for (const match of baseHybridMatches) {
		const node = nodeById.get(match.nodeId);
		if (!node || excludedTypeSet.has(node.type)) {
			continue;
		}
		const prev = semanticByNodeId.get(match.nodeId) ?? 0;
		if (match.score > prev) {
			semanticByNodeId.set(match.nodeId, match.score);
		}
	}
	for (const [nodeId, score] of bm25NormMap.entries()) {
		if (!semanticByNodeId.has(nodeId)) {
			semanticByNodeId.set(nodeId, score);
		}
	}

	const mentionedIds = detectEntityMentionsInText(
		params.query,
		eligibleAnchorNodes,
	);
	const mentionedSet = new Set(mentionedIds);
	for (const id of mentionedIds) {
		const prev = semanticByNodeId.get(id) ?? 0;
		semanticByNodeId.set(id, Math.max(prev, DIRECT_MENTION_MIN_SEMANTIC));
	}

	const rankedSemanticIds = Array.from(semanticByNodeId.entries())
		.filter(([, score]) => score > 0)
		.sort((a, b) => {
			if (b[1] !== a[1]) {
				return b[1] - a[1];
			}
			return a[0].localeCompare(b[0]);
		})
		.map(([id]) => id);

	// 5. Anchor selection & traversal (or vector-RAG baseline)
	const disableGraphTraversal = settings.experiment.disableGraphTraversal;
	const anchorLimit =
		resolvedMode === 'PLOT_LIGHT' ? LIGHT_ANCHOR_LIMIT : DEEP_ANCHOR_LIMIT;

	// Include ALL explicitly mentioned entities as anchors without cutting off at 1 or 3,
	// then fill any remaining anchor slots up to `anchorLimit` from hybrid ranking.
	const anchorIds: string[] = [...mentionedIds];
	const anchorSeen = new Set(anchorIds);
	for (const id of rankedSemanticIds) {
		if (anchorIds.length >= anchorLimit) {
			break;
		}
		if (!anchorSeen.has(id)) {
			anchorSeen.add(id);
			anchorIds.push(id);
		}
	}

	const visitById = new Map<string, TraversalVisit>();

	if (disableGraphTraversal) {
		// Fair vector-RAG baseline: active pool, explicit mentions, and ranked semantic matches fill the budget
		for (const id of activePoolIds) {
			visitById.set(id, { nodeId: id, hopDistance: 0, path: [id] });
		}
		for (const id of anchorIds) {
			if (!visitById.has(id)) {
				visitById.set(id, { nodeId: id, hopDistance: 0, path: [id] });
			}
		}
		for (const id of rankedSemanticIds) {
			if (!visitById.has(id)) {
				visitById.set(id, { nodeId: id, hopDistance: 0, path: [id] });
			}
		}
	} else {
		const seedIds = Array.from(new Set([...activePoolIds, ...anchorIds]));

		// Traverse only non-SESSION_LOG, non-META nodes so hub indexes never bridge unrelated subgraphs
		const traversalNodes = eligibleAnchorNodes;
		const traversalEdges = activeEdges.filter((edge) => {
			const src = nodeById.get(edge.sourceId);
			const dst = nodeById.get(edge.targetId);
			return (
				src !== undefined &&
				dst !== undefined &&
				!excludedTypeSet.has(src.type) &&
				!excludedTypeSet.has(dst.type)
			);
		});

		const firstHopVisits = traverseGraph(
			traversalNodes,
			traversalEdges,
			seedIds,
			1,
		);
		for (const visit of firstHopVisits) {
			visitById.set(visit.nodeId, visit);
		}

		// Compute degree / session normalization constants for scoring before 2-hop pruning
		let maxTotalDegree = 0;
		for (const node of eligibleAnchorNodes) {
			const deg = Math.max(0, node.inDegree) + Math.max(0, node.outDegree);
			if (deg > maxTotalDegree) {
				maxTotalDegree = deg;
			}
		}
		const maxSessionId = verifiedEvents.reduce(
			(max, evt) => (evt.sessionId > max ? evt.sessionId : max),
			0,
		);

		if (resolvedMode === 'PLOT_DEEP' && firstHopVisits.length > 0) {
			const hop1Scored = firstHopVisits
				.filter((visit) => visit.hopDistance === 1)
				.map((visit) => {
					const node = nodeById.get(visit.nodeId)!;
					const score = scoreCandidate({
						node,
						semanticScore: semanticByNodeId.get(visit.nodeId) ?? 0,
						hopDistance: 1,
						preferredTypes,
						maxTotalDegree,
						maxSessionId,
						verifiedEvents,
						weights: settings.scoringWeights,
						disableTypePriority:
							settings.experiment.disableTypePriority,
					});
					return { visit, score: score.total };
				})
				.sort((a, b) => {
					if (b.score !== a.score) {
						return b.score - a.score;
					}
					return a.visit.nodeId.localeCompare(b.visit.nodeId);
				});

			const topHop1Limit = Math.max(
				0,
				settings.firstHopMaxCandidates ?? 8,
			);
			const topHop1 = hop1Scored.slice(0, topHop1Limit);
			const topHop1Ids = topHop1.map((item) => item.visit.nodeId);
			const hop1ParentById = new Map(
				topHop1.map((item) => [item.visit.nodeId, item.visit]),
			);

			if (topHop1Ids.length > 0) {
				const secondStepVisits = traverseGraph(
					traversalNodes,
					traversalEdges,
					topHop1Ids,
					1,
				);
				for (const subVisit of secondStepVisits) {
					if (subVisit.hopDistance !== 1) {
						continue;
					}
					if (visitById.has(subVisit.nodeId)) {
						continue;
					}
					const hop1SourceId = subVisit.path[0]!;
					const parentVisit = hop1ParentById.get(hop1SourceId);
					visitById.set(subVisit.nodeId, {
						nodeId: subVisit.nodeId,
						hopDistance: 2,
						path: parentVisit
							? [...parentVisit.path, subVisit.nodeId]
							: [hop1SourceId, subVisit.nodeId],
					});
				}
			}
		}
	}

	// 6. Score all reached candidates (plus record ignored nodes that matched query/pool)
	const anchorSet = new Set(anchorIds);
	let maxTotalDegree = 0;
	for (const node of eligibleAnchorNodes) {
		const deg = Math.max(0, node.inDegree) + Math.max(0, node.outDegree);
		if (deg > maxTotalDegree) {
			maxTotalDegree = deg;
		}
	}
	const maxSessionId = verifiedEvents.reduce(
		(max, evt) => (evt.sessionId > max ? evt.sessionId : max),
		0,
	);

	interface ScoredEntry {
		node: GraphNode;
		visit: TraversalVisit;
		candidate: TracedCandidate;
		priorityGroup: number; // 0 = activePool, 1 = mentioned, 2 = anchor, 3 = neighbor/other
	}

	const scoredEntries: ScoredEntry[] = [];
	for (const visit of visitById.values()) {
		const node = nodeById.get(visit.nodeId);
		if (!node) {
			continue;
		}
		const semanticScore = semanticByNodeId.get(node.id) ?? 0;
		const breakdown = scoreCandidate({
			node,
			semanticScore,
			hopDistance: visit.hopDistance,
			preferredTypes,
			maxTotalDegree,
			maxSessionId,
			verifiedEvents,
			weights: settings.scoringWeights,
			disableTypePriority: settings.experiment.disableTypePriority,
		});

		const effectiveState = settings.experiment.disableTemporalStratification
			? { ...node.staticState }
			: resolveEffectiveState(node, verifiedEvents);

		const isPool = activePoolSet.has(node.id);
		const isMentioned = mentionedSet.has(node.id);
		const isAnchor = anchorSet.has(node.id);
		const priorityGroup = isPool
			? 0
			: isMentioned
				? 1
				: isAnchor
					? 2
					: 3;

		scoredEntries.push({
			node,
			visit,
			priorityGroup,
			candidate: {
				nodeId: node.id,
				title: node.title,
				type: node.type,
				effectiveState,
				hopDistance: visit.hopDistance,
				path: visit.path,
				scoreBreakdown: breakdown,
				included: false,
				tokenCount: 0,
			},
		});
	}

	// Sort deterministically: in baseline (disableGraphTraversal), pack activePool -> mentioned -> ranked semantic;
	// in GraphRAG mode, pack activePool -> mentioned -> anchors -> scored neighbors.
	scoredEntries.sort((a, b) => {
		if (disableGraphTraversal) {
			const groupA = a.priorityGroup <= 1 ? a.priorityGroup : 2;
			const groupB = b.priorityGroup <= 1 ? b.priorityGroup : 2;
			if (groupA !== groupB) {
				return groupA - groupB;
			}
		} else if (a.priorityGroup !== b.priorityGroup) {
			return a.priorityGroup - b.priorityGroup;
		}

		if (b.candidate.scoreBreakdown.total !== a.candidate.scoreBreakdown.total) {
			return b.candidate.scoreBreakdown.total - a.candidate.scoreBreakdown.total;
		}
		if (a.visit.hopDistance !== b.visit.hopDistance) {
			return a.visit.hopDistance - b.visit.hopDistance;
		}
		return a.node.id.localeCompare(b.node.id);
	});

	// 7. Reserve events budget first (only userVerified=true, newest sessions first)
	const maxEventsShare = Math.min(
		0.8,
		Math.max(0, settings.eventsBudgetShare ?? 0.4),
	);
	const maxEventsTokens = settings.experiment.disableTemporalStratification
		? 0
		: Math.floor(effectiveBudget * maxEventsShare);

	const eventCandidatePool = scoredEntries
		.filter(
			(entry) =>
				entry.priorityGroup <= 2 ||
				entry.visit.hopDistance === 1 ||
				entry.candidate.scoreBreakdown.total > 0,
		)
		.slice(0, Math.max(8, (settings.firstHopMaxCandidates ?? 8) * 2));
	const relevantEntityIdSet = new Set(
		eventCandidatePool.map((entry) => entry.node.id),
	);
	const eventCandidateNodes = eventCandidatePool.map((entry) => entry.node);
	const normalizedNamesByNode = new Map<string, Set<string>>();
	for (const node of eventCandidateNodes) {
		normalizedNamesByNode.set(
			node.id,
			new Set(
				[node.title, ...node.aliases]
					.map((name) => normalizeText(name))
					.filter((name) => name.length > 0),
			),
		);
	}

	const eventLines: string[] = [];
	const includedEventIds: string[] = [];
	let eventsTokens = 0;

	if (!settings.experiment.disableTemporalStratification && maxEventsTokens > 0 && relevantEntityIdSet.size > 0) {
		const matchingEvents = verifiedEvents.filter((evt) =>
			eventTouchesCandidate(
				evt,
				relevantEntityIdSet,
				eventCandidateNodes,
				normalizedNamesByNode,
			),
		);

		const eventsHeaderOverhead = estimateTokens(`${labels.recentEvents}\n`);
		for (const evt of matchingEvents) {
			const line = formatEventLine(evt, nodeById, labels);
			const nextJoined =
				eventLines.length === 0
					? `${labels.recentEvents}\n${line}`
					: `${labels.recentEvents}\n${eventLines.join('\n')}\n${line}`;
			const nextTokens = estimateTokens(nextJoined);
			if (
				nextTokens <= maxEventsTokens &&
				(eventLines.length > 0 || eventsHeaderOverhead <= maxEventsTokens)
			) {
				eventLines.push(line);
				includedEventIds.push(evt.id);
				eventsTokens = nextTokens;
			}
		}
	}

	// 8. Greedy base lore packing within remaining budget
	let remainingLoreBudget = Math.max(0, effectiveBudget - eventsTokens);
	const baseLoreHeaderCost = estimateTokens(`${labels.baseLore}\n\n`);
	let headerPaid = false;
	const loreBlocks: string[] = [];

	for (const entry of scoredEntries) {
		const effectiveHeaderCost = headerPaid ? 0 : baseLoreHeaderCost;
		const availableForBlock = remainingLoreBudget - effectiveHeaderCost;
		if (availableForBlock <= 0) {
			entry.candidate.included = false;
			entry.candidate.exclusionReason = 'over_budget';
			entry.candidate.tokenCount = 0;
			continue;
		}

		const header = formatNodeHeader(
			entry.node,
			entry.candidate.effectiveState,
			labels,
			settings.experiment.disableTemporalStratification,
		);
		const fit = buildSectionFitBlock(
			entry.node,
			header,
			params.query,
			availableForBlock,
		);

		if (!fit) {
			entry.candidate.included = false;
			entry.candidate.exclusionReason = 'over_budget';
			entry.candidate.tokenCount = 0;
			continue;
		}

		const reason: CandidateInclusionReason =
			entry.priorityGroup === 0
				? 'entity_pool'
				: anchorSet.has(entry.node.id)
					? 'anchor'
					: 'graph_neighbor';

		loreBlocks.push(fit.text);
		const spent = effectiveHeaderCost + fit.tokens;
		remainingLoreBudget = Math.max(0, remainingLoreBudget - spent);
		headerPaid = true;

		entry.candidate.included = true;
		entry.candidate.inclusionReason = reason;
		entry.candidate.includedSections = fit.includedSections;
		entry.candidate.tokenCount = fit.tokens;
	}

	// Record any ai_ignore nodes that came in via activePoolIds in trace for full explainability
	const poolIgnoredTraces: TracedCandidate[] = [];
	const requestedPoolSet = new Set(params.activePoolIds ?? []);
	for (const ign of ignoredNodes) {
		if (!requestedPoolSet.has(ign.id)) {
			continue;
		}
		const reason: CandidateExclusionReason = 'ignored';
		poolIgnoredTraces.push({
			nodeId: ign.id,
			title: ign.title,
			type: ign.type,
			effectiveState: ign.staticState,
			hopDistance: 0,
			path: [ign.id],
			scoreBreakdown: {
				semantic: 0,
				proximity: 0,
				typeBoost: 0,
				degree: 0,
				recency: 0,
				total: 0,
			},
			included: false,
			exclusionReason: reason,
			tokenCount: 0,
		});
	}

	const baseLoreText =
		loreBlocks.length > 0
			? `${labels.baseLore}\n\n${loreBlocks.join('\n\n')}`
			: '';
	const eventsText =
		eventLines.length > 0
			? `${labels.recentEvents}\n${eventLines.join('\n')}`
			: '';

	const finalBaseLoreTokens = baseLoreText ? estimateTokens(baseLoreText) : 0;
	const finalEventsTokens = eventsText ? estimateTokens(eventsText) : 0;
	const contextText = [baseLoreText, eventsText]
		.filter((part) => part.length > 0)
		.join('\n\n');

	return {
		contextText,
		trace: {
			query: params.query,
			requestedMode: params.requestedMode,
			resolvedMode,
			intentConfidence,
			preferredTypes,
			anchorIds,
			activeEntityPoolIds: activePoolIds,
			candidates: [
				...scoredEntries.map((e) => e.candidate),
				...poolIgnoredTraces,
			],
			includedEventIds,
			eventsTokens: finalEventsTokens,
			baseLoreTokens: finalBaseLoreTokens,
			totalTokensUsed: finalBaseLoreTokens + finalEventsTokens,
			tokenBudget: effectiveBudget,
			timestamp: now,
		},
	};
}
