import type { GraphNode } from '../types';
import { normalizeText } from './statusRules';

export interface EntityMatchCandidate {
	id: string;
	title: string;
	matchedText: string;
	score: number;
	matchKind: 'exact' | 'prefix' | 'fuzzy';
}

export interface EntityMatchResult {
	id: string | null;
	candidates: EntityMatchCandidate[];
	confidence: number;
	ambiguous: boolean;
}

const MIN_MATCH_SCORE = 0.68;
const AMBIGUITY_MARGIN = 0.06;

function splitWords(normalized: string): string[] {
	return normalized
		.split(/[^a-zа-яіїєґ0-9']+/)
		.filter((word) => word.length > 0);
}

function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) {
		i += 1;
	}
	return i;
}

/**
 * Optimal string alignment (restricted Damerau-Levenshtein) distance.
 */
export function damerauLevenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) {
		return n;
	}
	if (n === 0) {
		return m;
	}

	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array<number>(n + 1).fill(0),
	);

	for (let i = 0; i <= m; i++) {
		dp[i]![0] = i;
	}
	for (let j = 0; j <= n; j++) {
		dp[0]![j] = j;
	}

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let val = Math.min(
				dp[i - 1]![j]! + 1,
				dp[i]![j - 1]! + 1,
				dp[i - 1]![j - 1]! + cost,
			);

			if (
				i > 1 &&
				j > 1 &&
				a[i - 1] === b[j - 2] &&
				a[i - 2] === b[j - 1]
			) {
				val = Math.min(val, dp[i - 2]![j - 2]! + cost);
			}
			dp[i]![j] = val;
		}
	}

	return dp[m]![n]!;
}

function scorePair(
	normQuery: string,
	normTarget: string,
): { score: number; matchKind: 'exact' | 'prefix' | 'fuzzy' } | null {
	if (!normQuery || !normTarget) {
		return null;
	}

	if (normQuery === normTarget) {
		return { score: 1.0, matchKind: 'exact' };
	}

	const qWords = splitWords(normQuery);
	const tWords = splitWords(normTarget);

	if (qWords.length > 0 && qWords.length === tWords.length) {
		let ratioSum = 0;
		let allPrefixMatched = true;

		for (let i = 0; i < qWords.length; i++) {
			const qw = qWords[i]!;
			const tw = tWords[i]!;
			if (qw === tw) {
				ratioSum += 1;
				continue;
			}

			const minLen = Math.min(qw.length, tw.length);
			const maxLen = Math.max(qw.length, tw.length);
			if (minLen < 3 || maxLen - minLen > 3) {
				allPrefixMatched = false;
				break;
			}

			const cp = commonPrefixLength(qw, tw);
			const threshold =
				maxLen <= 5
					? 3
					: minLen >= 4
						? Math.min(minLen, Math.max(4, Math.ceil(0.7 * maxLen)))
						: Math.ceil(0.7 * maxLen);
			if (cp < threshold) {
				allPrefixMatched = false;
				break;
			}

			ratioSum += cp / maxLen;
		}

		if (allPrefixMatched) {
			const avgRatio = ratioSum / qWords.length;
			return {
				score: Number((0.8 + 0.15 * avgRatio).toFixed(4)),
				matchKind: 'prefix',
			};
		}
	}

	// Conservative fuzzy matching: never fuzzy-match short names (<= 3 chars)
	if (normQuery.length <= 3 || normTarget.length <= 3) {
		return null;
	}

	const maxLen = Math.max(normQuery.length, normTarget.length);
	const maxDist = maxLen >= 10 ? 2 : maxLen >= 6 ? 1 : 0;
	if (maxDist > 0) {
		const dist = damerauLevenshtein(normQuery, normTarget);
		if (dist <= maxDist) {
			return {
				score: Number((0.78 - dist * 0.05).toFixed(4)),
				matchKind: 'fuzzy',
			};
		}
	}

	if (qWords.length > 1 && qWords.length === tWords.length) {
		let totalDist = 0;
		let allFuzzyOk = true;
		for (let i = 0; i < qWords.length; i++) {
			const qw = qWords[i]!;
			const tw = tWords[i]!;
			if (qw === tw) {
				continue;
			}
			if (qw.length <= 3 || tw.length <= 3) {
				allFuzzyOk = false;
				break;
			}
			const wordMax = Math.max(qw.length, tw.length);
			const dist = damerauLevenshtein(qw, tw);
			if (wordMax < 5 || dist > 1) {
				allFuzzyOk = false;
				break;
			}
			totalDist += dist;
		}
		if (allFuzzyOk && totalDist > 0 && totalDist <= qWords.length) {
			return {
				score: Number((0.76 - totalDist * 0.03).toFixed(4)),
				matchKind: 'fuzzy',
			};
		}
	}

	return null;
}

/**
 * Resolves a free-form entity mention (possibly inflected in uk/ru) against
 * graph node titles and aliases. Ambiguous ties are NOT picked automatically:
 * `id` is set to `null` and `ambiguous: true` with ranked `candidates`.
 */
export function matchEntityName(
	rawName: string,
	nodes: GraphNode[],
): EntityMatchResult {
	const normQuery = normalizeText(rawName);
	if (!normQuery || nodes.length === 0) {
		return { id: null, candidates: [], confidence: 0, ambiguous: false };
	}

	const candidates: EntityMatchCandidate[] = [];

	for (const node of nodes) {
		const forms = [node.title, ...node.aliases];
		let bestForNode: EntityMatchCandidate | null = null;

		for (const form of forms) {
			const normForm = normalizeText(form);
			const scored = scorePair(normQuery, normForm);
			if (!scored || scored.score < MIN_MATCH_SCORE) {
				continue;
			}
			if (!bestForNode || scored.score > bestForNode.score) {
				bestForNode = {
					id: node.id,
					title: node.title,
					matchedText: form,
					score: scored.score,
					matchKind: scored.matchKind,
				};
			}
		}

		if (bestForNode) {
			candidates.push(bestForNode);
		}
	}

	if (candidates.length === 0) {
		return { id: null, candidates: [], confidence: 0, ambiguous: false };
	}

	candidates.sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		return a.id.localeCompare(b.id);
	});

	const top = candidates[0]!;
	const second = candidates[1];

	if (
		second &&
		(top.score - second.score < AMBIGUITY_MARGIN ||
			(top.matchKind === 'exact' && second.matchKind === 'exact'))
	) {
		return {
			id: null,
			candidates: candidates.slice(0, 5),
			confidence: top.score,
			ambiguous: true,
		};
	}

	return {
		id: top.id,
		candidates: candidates.slice(0, 5),
		confidence: top.score,
		ambiguous: false,
	};
}

export function resolveSubjects(
	subjects: string[],
	nodes: GraphNode[],
): {
	subjectIds: string[];
	matchesBySubject: Record<string, EntityMatchResult>;
	unresolvedSubjects: string[];
} {
	const subjectIds: string[] = [];
	const seenIds = new Set<string>();
	const matchesBySubject: Record<string, EntityMatchResult> = {};
	const unresolvedSubjects: string[] = [];

	for (const subject of subjects) {
		const trimmed = subject.trim();
		if (!trimmed) {
			continue;
		}
		const match = matchEntityName(trimmed, nodes);
		matchesBySubject[trimmed] = match;
		if (match.id !== null) {
			if (!seenIds.has(match.id)) {
				seenIds.add(match.id);
				subjectIds.push(match.id);
			}
		} else {
			unresolvedSubjects.push(trimmed);
		}
	}

	return {
		subjectIds,
		matchesBySubject,
		unresolvedSubjects,
	};
}

const MENTION_MIN_CONFIDENCE = 0.85;

// Common uk/ru/en query words & stems that should never trigger single-word entity mentions
const COMMON_STOPWORD_EXACT = new Set<string>([
	'що',
	'что',
	'кто',
	'хто',
	'где',
	'де',
	'как',
	'як',
	'бо',
	'бой',
	'бій',
	'між',
	'меж',
	'для',
	'про',
	'при',
	'без',
	'над',
	'під',
	'под',
	'who',
	'what',
	'where',
	'when',
	'why',
	'how',
	'the',
	'and',
	'with',
	'from',
	'into',
	'about',
	'between',
	'after',
	'before',
	'city',
	'town',
	'loot',
]);

const COMMON_STOPWORD_STEMS: readonly string[] = [
	'вернул',
	'поверну',
	'пошл',
	'пішл',
	'пришл',
	'прийш',
	'ушл',
	'вишл',
	'вышл',
	'задан',
	'завдан',
	'квест',
	'игрок',
	'гравц',
	'город',
	'міст',
	'таверн',
	'дорог',
	'шлях',
	'битв',
	'встреч',
	'зустріч',
	'сесс',
	'сесі',
	'парт',
	'геро',
	'персонаж',
	'монстр',
	'враг',
	'ворог',
	'предмет',
	'артефакт',
	'локац',
	'фракц',
	'истор',
	'істор',
	'правил',
	'мастер',
	'майст',
	'вопрос',
	'питан',
	'когд',
	'коли',
	'если',
	'якщо',
	'посл',
	'післ',
	'перед',
	'между',
	'сюжет',
	'лини',
	'ліні',
	'наслід',
	'послед',
	'баланс',
	'стат',
	'возврат',
	'поверн',
	'return',
	'quest',
	'player',
	'party',
	'character',
	'location',
	'faction',
	'monster',
	'session',
	'battle',
	'fight',
	'meeting',
	'tavern',
];

const CAPITALIZED_START_REGEX = /^[A-ZА-ЯІЇЄҐЁ]/;
const WIKILINK_REGEX = /\[\[([^\]\r\n]+)\]\]/g;

function isCommonQueryStopword(normalizedWord: string): boolean {
	if (COMMON_STOPWORD_EXACT.has(normalizedWord)) {
		return true;
	}
	return COMMON_STOPWORD_STEMS.some(
		(stem) =>
			normalizedWord.startsWith(stem) &&
			normalizedWord.length - stem.length <= 3,
	);
}

function tokenizeRawWordsWithCase(
	text: string,
): Array<{ normalized: string; isCapitalized: boolean }> {
	const cleaned = text.replace(/[’ʼ`´]/g, "'");
	const rawParts = cleaned
		.split(/[^A-Za-zА-Яа-яІіЇїЄєҐґЁё0-9']+/)
		.filter((part) => part.length > 0);

	const result: Array<{ normalized: string; isCapitalized: boolean }> = [];
	for (const part of rawParts) {
		const normalized = normalizeText(part);
		if (!normalized) {
			continue;
		}
		result.push({
			normalized,
			isCapitalized: CAPITALIZED_START_REGEX.test(part),
		});
	}
	return result;
}

function isStrictMentionMatch(match: EntityMatchResult): boolean {
	const top = match.candidates[0];
	return (
		match.id !== null &&
		!match.ambiguous &&
		match.confidence >= MENTION_MIN_CONFIDENCE &&
		top !== undefined &&
		top.matchKind !== 'fuzzy'
	);
}

/**
 * Scans a free-form user query for unambiguous, strict mentions of campaign entity
 * notes (excluding SESSION_LOG and META), reusing `matchEntityName`.
 * Prefers precision over recall: requires explicit `[[wikilinks]]`, exact/prefix
 * multi-word matches, or capitalized non-stopword single-word proper names.
 */
export function detectEntityMentionsInText(
	text: string,
	nodes: GraphNode[],
): string[] {
	const eligibleNodes = nodes.filter(
		(node) => node.type !== 'SESSION_LOG' && node.type !== 'META',
	);
	if (!text.trim() || eligibleNodes.length === 0) {
		return [];
	}

	const detectedIds: string[] = [];
	const seenIds = new Set<string>();
	const eligibleById = new Map(eligibleNodes.map((n) => [n.id, n]));

	const recordMatch = (id: string): void => {
		if (!seenIds.has(id)) {
			seenIds.add(id);
			detectedIds.push(id);
		}
	};

	// 1. Resolve explicit [[wikilink]] / [[path|alias]] mentions first
	const textWithoutBrackets = text.replace(
		WIKILINK_REGEX,
		(_full, inner: string) => {
			const [rawTarget = '', rawAlias = ''] = inner.split('|');
			const cleanTarget = rawTarget.trim();
			const targetTitle = cleanTarget
				.split('/')
				.pop()
				?.replace(/\.md$/i, '')
				.trim();

			if (cleanTarget) {
				if (eligibleById.has(cleanTarget)) {
					recordMatch(cleanTarget);
				} else if (eligibleById.has(`${cleanTarget}.md`)) {
					recordMatch(`${cleanTarget}.md`);
				}
			}

			for (const probe of [targetTitle ?? '', rawAlias.trim()]) {
				if (!probe) {
					continue;
				}
				const match = matchEntityName(probe, eligibleNodes);
				if (isStrictMentionMatch(match)) {
					recordMatch(match.id!);
				}
			}

			return rawAlias.trim() || targetTitle || cleanTarget;
		},
	);

	// 2. Strict n-gram scan over remaining query words preserving original capitalization
	const tokens = tokenizeRawWordsWithCase(textWithoutBrackets);
	if (tokens.length === 0) {
		return detectedIds;
	}

	const maxNgram = 4;
	for (let i = 0; i < tokens.length; i++) {
		let matchedLen = 0;
		const upperLen = Math.min(maxNgram, tokens.length - i);

		for (let len = upperLen; len >= 1; len--) {
			const slice = tokens.slice(i, i + len);
			if (len === 1) {
				const single = slice[0]!;
				if (
					!single.isCapitalized ||
					single.normalized.length < 3 ||
					isCommonQueryStopword(single.normalized)
				) {
					continue;
				}
			}

			const phrase = slice.map((tok) => tok.normalized).join(' ');
			const match = matchEntityName(phrase, eligibleNodes);
			if (isStrictMentionMatch(match)) {
				recordMatch(match.id!);
				matchedLen = len;
				break;
			}
		}

		if (matchedLen > 1) {
			i += matchedLen - 1;
		}
	}

	return detectedIds;
}
