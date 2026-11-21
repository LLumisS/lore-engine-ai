import type { EntityType, GraphNode, NoteSection } from '../types';
import { normalizeText } from './statusRules';

export const DEFAULT_ANCHOR_EXCLUDED_TYPES: readonly EntityType[] = [
	'SESSION_LOG',
	'META',
];

export interface Bm25SearchResult {
	nodeId: string;
	score: number;
}

export interface HybridAnchorMatch {
	nodeId: string;
	score: number;
	lexicalScore: number;
	vectorScore: number;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

const TITLE_WEIGHT = 3;
const ALIAS_WEIGHT = 2.5;
const TAG_WEIGHT = 1.5;
const CONTENT_WEIGHT = 1;

const CYRILLIC_CHECK = /[\u0400-\u04FF]/;

// Ordered longest-first for deterministic inflectional suffix stripping in uk/ru
const CYRILLIC_INFLECTION_SUFFIXES: readonly string[] = [
	'ями',
	'ами',
	'ові',
	'еві',
	'ого',
	'ому',
	'ими',
	'іми',
	'ією',
	'єю',
	'ою',
	'ею',
	'ях',
	'ах',
	'ий',
	'ій',
	'ої',
	'єї',
	'ая',
	'яя',
	'ое',
	'ее',
	'ів',
	'їв',
	'ам',
	'ям',
	'ом',
	'ем',
	'им',
	'ім',
	'ей',
	'ія',
	'ия',
	'ії',
	'ии',
	'ію',
	'ию',
	'а',
	'я',
	'у',
	'ю',
	'і',
	'ї',
	'и',
	'ы',
	'е',
	'о',
	'ь',
];

function stripDeterministicCyrillicSuffix(token: string): string | null {
	if (token.length < 4 || !CYRILLIC_CHECK.test(token)) {
		return null;
	}
	for (const suffix of CYRILLIC_INFLECTION_SUFFIXES) {
		if (
			token.endsWith(suffix) &&
			token.length - suffix.length >= 3
		) {
			return token.slice(0, token.length - suffix.length);
		}
	}
	return null;
}

/**
 * Deterministic multilingual tokenizer for BM25: emits normalized exact tokens
 * plus deterministic Cyrillic inflectional stems without external stemmer libraries.
 */
export function tokenizeForBm25(text: string): string[] {
	const normalized = normalizeText(text);
	if (!normalized) {
		return [];
	}

	const rawTokens = normalized
		.split(/[^a-zа-яіїєґ0-9']+/)
		.filter((token) => token.length >= 2);

	const terms: string[] = [];
	for (const token of rawTokens) {
		const stem = stripDeterministicCyrillicSuffix(token);
		terms.push(stem ?? token);
	}

	return terms;
}

function addWeightedTerms(
	termCounts: Map<string, number>,
	text: string,
	weight: number,
): number {
	const tokens = tokenizeForBm25(text);
	for (const token of tokens) {
		termCounts.set(token, (termCounts.get(token) ?? 0) + weight);
	}
	return tokens.length * weight;
}

interface IndexedDocument {
	nodeId: string;
	termCounts: Map<string, number>;
	weightedLength: number;
}

function scoreBm25Documents(
	docs: IndexedDocument[],
	docFreq: Map<string, number>,
	queryTerms: string[],
	totalLength: number,
): Bm25SearchResult[] {
	const totalDocs = docs.length;
	if (totalDocs === 0 || queryTerms.length === 0) {
		return [];
	}

	const avgDocLength = totalLength / Math.max(1, totalDocs);
	const scored: Bm25SearchResult[] = [];

	for (const doc of docs) {
		let score = 0;
		for (const term of queryTerms) {
			const tf = doc.termCounts.get(term) ?? 0;
			if (tf <= 0) {
				continue;
			}
			const df = docFreq.get(term) ?? 0;
			const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
			const normFactor =
				1 - BM25_B + BM25_B * (doc.weightedLength / Math.max(1, avgDocLength));
			const tfComponent =
				(tf * (BM25_K1 + 1)) / (tf + BM25_K1 * normFactor);
			score += idf * tfComponent;
		}

		if (score > 0) {
			scored.push({
				nodeId: doc.nodeId,
				score: Number(score.toFixed(6)),
			});
		}
	}

	scored.sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		return a.nodeId.localeCompare(b.nodeId);
	});

	return scored;
}

/**
 * Min-max normalizes positive BM25 scores within a single query into [0, 1].
 * Positive matches stay > 0 (minimum 0.05 when max > min) so weak lexical matches remain distinguishable from 0.
 */
export function normalizeBm25Scores(
	results: Bm25SearchResult[],
): Bm25SearchResult[] {
	if (results.length === 0) {
		return [];
	}

	let minScore = Number.POSITIVE_INFINITY;
	let maxScore = Number.NEGATIVE_INFINITY;
	for (const entry of results) {
		if (entry.score < minScore) {
			minScore = entry.score;
		}
		if (entry.score > maxScore) {
			maxScore = entry.score;
		}
	}

	if (maxScore <= 0) {
		return results.map((entry) => ({ ...entry, score: 0 }));
	}

	if (maxScore === minScore) {
		return results.map((entry) => ({ ...entry, score: 1 }));
	}

	const range = maxScore - minScore;
	return results.map((entry) => ({
		...entry,
		score:
			entry.score <= 0
				? 0
				: Number(
						(0.05 + 0.95 * ((entry.score - minScore) / range)).toFixed(6),
					),
	}));
}

/**
 * Ranks markdown sections of a long note by BM25 relevance to `query`
 * (weighting section heading at 2.5x and body content at 1x).
 */
export function rankSectionsByBm25(
	sections: NoteSection[],
	query: string,
): Array<{ section: NoteSection; index: number; score: number }> {
	if (sections.length === 0) {
		return [];
	}

	const queryTerms = Array.from(new Set(tokenizeForBm25(query)));
	if (queryTerms.length === 0) {
		return sections.map((section, index) => ({
			section,
			index,
			score: 0,
		}));
	}

	const docs: IndexedDocument[] = [];
	const docFreq = new Map<string, number>();
	let totalLength = 0;

	sections.forEach((section, index) => {
		const termCounts = new Map<string, number>();
		let weightedLength = 0;
		weightedLength += addWeightedTerms(termCounts, section.heading, ALIAS_WEIGHT);
		weightedLength += addWeightedTerms(termCounts, section.content, CONTENT_WEIGHT);
		totalLength += weightedLength;

		docs.push({
			nodeId: String(index),
			termCounts,
			weightedLength,
		});

		for (const term of queryTerms) {
			if ((termCounts.get(term) ?? 0) > 0) {
				docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
			}
		}
	});

	const normalized = normalizeBm25Scores(
		scoreBm25Documents(docs, docFreq, queryTerms, totalLength),
	);
	const scoreByIndex = new Map<number, number>();
	for (const entry of normalized) {
		scoreByIndex.set(Number.parseInt(entry.nodeId, 10), entry.score);
	}

	return sections
		.map((section, index) => ({
			section,
			index,
			score: scoreByIndex.get(index) ?? 0,
		}))
		.sort((a, b) => {
			if (b.score !== a.score) {
				return b.score - a.score;
			}
			return a.index - b.index;
		});
}

/**
 * Runs deterministic field-weighted Okapi BM25 search over GraphNode[]
 * (`title`, `aliases`, `tags`, `content`).
 */
export function searchBm25(
	nodes: GraphNode[],
	query: string,
	topK = 10,
	options?: { excludeTypes?: readonly EntityType[] },
): Bm25SearchResult[] {
	const excluded = new Set<EntityType>(
		options?.excludeTypes ?? DEFAULT_ANCHOR_EXCLUDED_TYPES,
	);
	const eligibleNodes = nodes.filter((n) => !excluded.has(n.type));
	if (eligibleNodes.length === 0 || topK <= 0) {
		return [];
	}

	const queryTerms = Array.from(new Set(tokenizeForBm25(query)));
	if (queryTerms.length === 0) {
		return [];
	}

	const docs: IndexedDocument[] = [];
	const docFreq = new Map<string, number>();
	let totalLength = 0;

	for (const node of eligibleNodes) {
		const termCounts = new Map<string, number>();
		let weightedLength = 0;

		weightedLength += addWeightedTerms(termCounts, node.title, TITLE_WEIGHT);
		for (const alias of node.aliases) {
			weightedLength += addWeightedTerms(termCounts, alias, ALIAS_WEIGHT);
		}
		for (const tag of node.tags) {
			weightedLength += addWeightedTerms(termCounts, tag, TAG_WEIGHT);
		}
		weightedLength += addWeightedTerms(
			termCounts,
			node.content,
			CONTENT_WEIGHT,
		);

		totalLength += weightedLength;
		docs.push({
			nodeId: node.id,
			termCounts,
			weightedLength,
		});

		for (const term of queryTerms) {
			if ((termCounts.get(term) ?? 0) > 0) {
				docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
			}
		}
	}

	return scoreBm25Documents(docs, docFreq, queryTerms, totalLength).slice(
		0,
		topK,
	);
}

/**
 * Computes cosine similarity between two numeric vectors (`Float32Array` or `number[]`).
 */
export function cosineSimilarity(
	a: ArrayLike<number>,
	b: ArrayLike<number>,
): number {
	const len = Math.min(a.length, b.length);
	if (len === 0) {
		return 0;
	}

	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < len; i++) {
		const va = a[i] ?? 0;
		const vb = b[i] ?? 0;
		dot += va * vb;
		normA += va * va;
		normB += vb * vb;
	}

	if (normA <= 0 || normB <= 0) {
		return 0;
	}

	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Fuses BM25 lexical rankings and vector cosine similarity rankings.
 * Gracefully degrades to normalized BM25-only ranking when `vector` is empty.
 */
export function fuseHybridRankings(
	lexical: Bm25SearchResult[],
	vector: Array<{ nodeId: string; score: number }>,
	topK = 5,
): HybridAnchorMatch[] {
	if (topK <= 0) {
		return [];
	}

	const sortedLexical = [...lexical].sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		return a.nodeId.localeCompare(b.nodeId);
	});

	const maxLexical = sortedLexical[0]?.score ?? 0;

	if (vector.length === 0) {
		return sortedLexical.slice(0, topK).map((entry) => ({
			nodeId: entry.nodeId,
			score:
				maxLexical > 0
					? Number((entry.score / maxLexical).toFixed(6))
					: 0,
			lexicalScore: entry.score,
			vectorScore: 0,
		}));
	}

	const sortedVector = [...vector]
		.filter((entry) => entry.score > 0)
		.sort((a, b) => {
			if (b.score !== a.score) {
				return b.score - a.score;
			}
			return a.nodeId.localeCompare(b.nodeId);
		});

	const normalizedLexical = normalizeBm25Scores(sortedLexical);
	const maxVector = sortedVector[0]?.score ?? 0;
	const lexMap = new Map<string, { raw: number; norm: number; rank: number }>();
	const vecMap = new Map<string, { raw: number; rank: number }>();

	normalizedLexical.forEach((entry, idx) => {
		const rawEntry = sortedLexical[idx];
		lexMap.set(entry.nodeId, {
			raw: rawEntry?.score ?? entry.score,
			norm: entry.score,
			rank: idx + 1,
		});
	});
	sortedVector.forEach((entry, idx) => {
		vecMap.set(entry.nodeId, { raw: entry.score, rank: idx + 1 });
	});

	const allIds = new Set<string>([
		...sortedLexical.map((e) => e.nodeId),
		...sortedVector.map((e) => e.nodeId),
	]);

	const RRF_K = 60;
	const MAX_RRF = 2 / (RRF_K + 1);
	const fused: HybridAnchorMatch[] = [];

	for (const nodeId of allIds) {
		const lex = lexMap.get(nodeId);
		const vec = vecMap.get(nodeId);

		const normLex = lex ? lex.norm : 0;
		const normVec = vec && maxVector > 0 ? vec.raw / maxVector : 0;
		const rrfRaw =
			(lex ? 1 / (RRF_K + lex.rank) : 0) +
			(vec ? 1 / (RRF_K + vec.rank) : 0);
		const normRrf = MAX_RRF > 0 ? rrfRaw / MAX_RRF : 0;

		const combined = 0.45 * normLex + 0.45 * normVec + 0.1 * normRrf;
		if (combined > 0) {
			fused.push({
				nodeId,
				score: Number(combined.toFixed(6)),
				lexicalScore: lex?.raw ?? 0,
				vectorScore: vec?.raw ?? 0,
			});
		}
	}

	fused.sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		return a.nodeId.localeCompare(b.nodeId);
	});

	return fused.slice(0, topK);
}
