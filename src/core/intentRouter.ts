import type {
	EntityType,
	GraphNode,
	IntentClassification,
	RetrievalMode,
} from '../types';
import { detectEntityMentionsInText } from './entityMatcher';
import { normalizeText } from './statusRules';

const DEFAULT_LLM_FALLBACK_THRESHOLD = 0.55;

// Exact word/token mechanics triggers (matched on normalized word tokens to prevent substring false positives)
const MECHANICS_EXACT_TOKENS = new Set<string>([
	'cr',
	'ac',
	'dc',
	'hp',
	'xp',
	'кб',
	'кд',
	'хп',
	'опыт',
	'досвід',
	'лут',
	'loot',
	'статблок',
]);

// Multi-word phrases / unambiguous Cyrillic or English mechanics stems
const MECHANICS_SUBSTRINGS: readonly string[] = [
	'стат-блок',
	'стат блок',
	'statblock',
	'stat block',
	'рівень небезпек',
	'уровень опасност',
	'challenge rating',
	'баланс бо',
	'баланс зіткн',
	'баланс столкновен',
	'encounter balance',
	'action economy',
	'економія дій',
	'экономия действий',
	'рятівний кид',
	'спасброс',
	'saving throw',
	'armor class',
	'клас броні',
	'класс брони',
	'hit points',
	'ворог для',
	'враг для',
	'ініціатив',
	'инициатив',
	'initiative',
];

const DICE_NOTATION_REGEX = /\b\d*d(?:4|6|8|10|12|20|100)\b/i;

const PLOT_DEEP_SUBSTRINGS: readonly string[] = [
	'що буде якщо',
	'що буде, якщо',
	'что будет если',
	'что будет, если',
	'what if',
	'як вплин',
	'как повлия',
	'how will it affect',
	'how would',
	'сюжетні ліні',
	'сюжетные лини',
	'plotline',
	'plot lines',
	'наслідк',
	'последств',
	'consequence',
	"зв'язок між",
	'связь между',
	'connection between',
	'relationship between',
	'інтриг',
	'интриг',
	'мотивац',
	'конфлікт між',
	'конфликт между',
	'змов',
	'заговор',
	'політич',
	'политич',
	'план дій',
	'план действий',
	'історія відносин',
	'история отношений',
];

const PLOT_LIGHT_SUBSTRINGS: readonly string[] = [
	'хто так',
	'кто так',
	'who is',
	'who was',
	'де знаход',
	'где наход',
	'where is',
	'що відомо про',
	'что известно о',
	'tell me about',
	'опиши',
	'нагадай про',
	'напомни о',
	'який статус',
	'какой статус',
];

export interface IntentTypeHintRule {
	id: string;
	stems: readonly string[];
	types: readonly EntityType[];
}

/**
 * Configurable mapping from query domain hints (uk/ru/en) to prioritized EntityTypes.
 */
export const INTENT_TYPE_HINTS: readonly IntentTypeHintRule[] = [
	{
		id: 'politics_and_power',
		stems: [
			'політик',
			'политик',
			'влада',
			'власт',
			'переворот',
			'заколот',
			'мятеж',
			'гільді',
			'гильди',
			'фракц',
			'корон',
			'війн',
			'войн',
			'союз',
			'змoв',
			'заговор',
			'politic',
			'faction',
			'guild',
			'war',
		],
		types: ['FACTION', 'NPC'],
	},
	{
		id: 'travel_and_places',
		stems: [
			'подорож',
			'путешеств',
			'маршрут',
			'дорог',
			'міст',
			'город',
			'вежа',
			'башн',
			'таверн',
			'цитадел',
			'локац',
			'порт',
			'північ',
			'север',
			'travel',
			'location',
			'city',
			'tower',
		],
		types: ['LOCATION', 'QUEST'],
	},
	{
		id: 'items_and_relics',
		stems: [
			'артефакт',
			'збро',
			'оружи',
			'меч',
			'клинок',
			'печатк',
			'печат',
			'релікв',
			'реликв',
			'предмет',
			'artifact',
			'weapon',
			'sword',
			'item',
			'relic',
		],
		types: ['ITEM', 'LORE'],
	},
	{
		id: 'monsters_and_creatures',
		stems: [
			'монстр',
			'бестіар',
			'бестиар',
			'чудовиськ',
			'чудовищ',
			'дракон',
			'гоблін',
			'гоблин',
			'monster',
			'beast',
			'creature',
			'dragon',
			'undead',
		],
		types: ['MONSTER', 'LORE'],
	},
	{
		id: 'characters_and_motives',
		stems: [
			'хто',
			'кто',
			'характер',
			'мотивац',
			'персонаж',
			'барон',
			'капітан',
			'капитан',
			'некромант',
			'архіваріус',
			'архивариус',
			'ковал',
			'кузнец',
			'character',
			'npc',
			'motive',
		],
		types: ['NPC', 'FACTION'],
	},
	{
		id: 'quests_and_objectives',
		stems: [
			'квест',
			'завдан',
			'задан',
			'місі',
			'мисси',
			'пошук',
			'поиск',
			'облог',
			'осад',
			'експедиц',
			'экспедиц',
			'quest',
			'mission',
			'siege',
		],
		types: ['QUEST', 'NPC', 'LOCATION'],
	},
	{
		id: 'lore_and_history',
		stems: [
			'лор',
			'міф',
			'миф',
			'легенд',
			'історі',
			'истори',
			'ритуал',
			'магі',
			'маги',
			'древн',
			'lore',
			'myth',
			'legend',
			'history',
		],
		types: ['LORE', 'ITEM'],
	},
];

function tokenizeWords(normalized: string): string[] {
	return normalized
		.split(/[^a-zа-яіїєґ0-9-]+/)
		.map((token) => token.replace(/^-+|-+$/g, ''))
		.filter((token) => token.length > 0);
}

function collectPreferredTypes(
	normalizedQuery: string,
	words: string[],
	mentionedNodeIds: string[],
	nodes: GraphNode[],
): EntityType[] {
	const typeCounts = new Map<EntityType, number>();
	const addType = (entityType: EntityType, weight: number): void => {
		if (
			entityType === 'SESSION_LOG' ||
			entityType === 'META' ||
			entityType === 'UNTYPED'
		) {
			return;
		}
		typeCounts.set(entityType, (typeCounts.get(entityType) ?? 0) + weight);
	};

	for (const rule of INTENT_TYPE_HINTS) {
		const matched = rule.stems.some(
			(stem) =>
				normalizedQuery.includes(stem) ||
				words.some((w) => w.startsWith(stem)),
		);
		if (matched) {
			rule.types.forEach((entityType, idx) => {
				addType(entityType, idx === 0 ? 2 : 1);
			});
		}
	}

	if (mentionedNodeIds.length > 0) {
		const byId = new Map(nodes.map((node) => [node.id, node]));
		for (const nodeId of mentionedNodeIds) {
			const node = byId.get(nodeId);
			if (node) {
				addType(node.type, 2);
			}
		}
	}

	return Array.from(typeCounts.entries())
		.sort((a, b) => {
			if (b[1] !== a[1]) {
				return b[1] - a[1];
			}
			return a[0].localeCompare(b[0]);
		})
		.map(([entityType]) => entityType);
}

/**
 * Deterministic rule-based intent router (`uk`/`ru`/`en`) deciding between
 * `MECHANICS`, `PLOT_LIGHT`, and `PLOT_DEEP` plus preferred entity types.
 * Uses `entityMatcher` to detect multi-entity references in the query.
 */
export function classifyIntent(
	query: string,
	nodes: GraphNode[] = [],
): IntentClassification {
	const normalized = normalizeText(query);
	if (!normalized) {
		return {
			mode: 'PLOT_LIGHT',
			preferredTypes: [],
			confidence: 0.4,
			matchedKeywords: [],
		};
	}

	const words = tokenizeWords(normalized);
	const wordSet = new Set(words);
	const matchedKeywords: string[] = [];

	const mechMatches: string[] = [];
	for (const token of MECHANICS_EXACT_TOKENS) {
		if (wordSet.has(token)) {
			mechMatches.push(token);
		}
	}
	for (const phrase of MECHANICS_SUBSTRINGS) {
		if (normalized.includes(phrase)) {
			mechMatches.push(phrase);
		}
	}
	if (DICE_NOTATION_REGEX.test(query)) {
		mechMatches.push('dice');
	}

	const deepMatches: string[] = [];
	for (const phrase of PLOT_DEEP_SUBSTRINGS) {
		if (normalized.includes(phrase)) {
			deepMatches.push(phrase);
		}
	}

	const lightMatches: string[] = [];
	for (const phrase of PLOT_LIGHT_SUBSTRINGS) {
		if (normalized.includes(phrase)) {
			lightMatches.push(phrase);
		}
	}

	const mentionedIds = detectEntityMentionsInText(query, nodes);
	const preferredTypes = collectPreferredTypes(
		normalized,
		words,
		mentionedIds,
		nodes,
	);

	if (mechMatches.length > 0 && deepMatches.length === 0 && mentionedIds.length < 2) {
		matchedKeywords.push(...mechMatches);
		return {
			mode: 'MECHANICS',
			preferredTypes: [],
			confidence: Number(
				Math.min(0.95, 0.75 + 0.1 * mechMatches.length).toFixed(2),
			),
			matchedKeywords,
		};
	}

	if (deepMatches.length > 0 || mentionedIds.length >= 2) {
		matchedKeywords.push(...deepMatches);
		if (mentionedIds.length >= 2) {
			matchedKeywords.push(`entities:${mentionedIds.length}`);
		}
		return {
			mode: 'PLOT_DEEP',
			preferredTypes,
			confidence: Number(
				Math.min(
					0.95,
					0.7 + 0.08 * (deepMatches.length + mentionedIds.length),
				).toFixed(2),
			),
			matchedKeywords,
		};
	}

	if (lightMatches.length > 0 || mentionedIds.length === 1) {
		matchedKeywords.push(...lightMatches);
		if (mentionedIds.length === 1) {
			matchedKeywords.push('entities:1');
		}
		return {
			mode: 'PLOT_LIGHT',
			preferredTypes,
			confidence: 0.75,
			matchedKeywords,
		};
	}

	return {
		mode: 'PLOT_LIGHT',
		preferredTypes,
		confidence: 0.4,
		matchedKeywords,
	};
}

export type LlmIntentClassifierCallback = (query: string) => Promise<{
	mode?: Exclude<RetrievalMode, 'AUTO'>;
	preferredTypes?: EntityType[];
	confidence?: number;
} | null>;

const VALID_RESOLVED_MODES = new Set<string>([
	'PLOT_DEEP',
	'PLOT_LIGHT',
	'MECHANICS',
]);

/**
 * Runs deterministic `classifyIntent` first and optionally invokes an injected
 * LLM classifier when confidence falls below `confidenceThreshold`.
 */
export async function classifyIntentWithLlmFallback(params: {
	query: string;
	nodes?: GraphNode[];
	confidenceThreshold?: number;
	llmClassifier?: LlmIntentClassifierCallback;
}): Promise<IntentClassification> {
	const threshold = params.confidenceThreshold ?? DEFAULT_LLM_FALLBACK_THRESHOLD;
	const base = classifyIntent(params.query, params.nodes ?? []);

	if (base.confidence >= threshold || !params.llmClassifier) {
		return base;
	}

	try {
		const fallback = await params.llmClassifier(params.query);
		if (!fallback || !fallback.mode || !VALID_RESOLVED_MODES.has(fallback.mode)) {
			return base;
		}
		const resolvedMode = fallback.mode;
		const preferredTypes =
			fallback.preferredTypes && fallback.preferredTypes.length > 0
				? fallback.preferredTypes
				: base.preferredTypes;
		const confidence =
			typeof fallback.confidence === 'number' &&
			Number.isFinite(fallback.confidence)
				? Math.min(1, Math.max(0, Number(fallback.confidence.toFixed(2))))
				: 0.7;

		return {
			mode: resolvedMode,
			preferredTypes: resolvedMode === 'MECHANICS' ? [] : preferredTypes,
			confidence,
			matchedKeywords: [...base.matchedKeywords, 'llm_fallback'],
		};
	} catch {
		return base;
	}
}
