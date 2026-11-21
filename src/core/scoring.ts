import type {
	CandidateScoreBreakdown,
	EntityType,
	GraphNode,
	ScoringWeights,
	SessionEvent,
} from '../types';

const META_HUB_DAMPING_FACTOR = 0.2;
const HIGH_DEGREE_HUB_THRESHOLD = 8;
const HIGH_DEGREE_HUB_DAMPING_FACTOR = 0.5;

function clamp01(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(1, Math.max(0, value));
}

function round6(value: number): number {
	return Number(value.toFixed(6));
}

/**
 * Computes logarithmic degree score in `[0, 1]` with hub damping so high-degree
 * navigation/index (`META`) notes do not flood GraphRAG context.
 */
export function computeDampedDegree(
	node: GraphNode,
	maxTotalDegree: number,
): number {
	const totalDegree = Math.max(0, node.inDegree) + Math.max(0, node.outDegree);
	if (totalDegree <= 0 || maxTotalDegree <= 0) {
		return 0;
	}

	const denom = Math.log(1 + maxTotalDegree);
	if (denom <= 0) {
		return 0;
	}

	let score = Math.log(1 + totalDegree) / denom;
	if (node.type === 'META') {
		score *= META_HUB_DAMPING_FACTOR;
	} else if (node.outDegree >= HIGH_DEGREE_HUB_THRESHOLD) {
		score *= HIGH_DEGREE_HUB_DAMPING_FACTOR;
	}

	return round6(clamp01(score));
}

/**
 * Computes normalized `[0, 1]` recency from verified session events mentioning `nodeId`.
 */
export function computeNodeRecency(
	nodeId: string,
	verifiedEvents: SessionEvent[],
	maxSessionId: number,
): number {
	if (maxSessionId <= 0 || verifiedEvents.length === 0) {
		return 0;
	}

	let latestSession = 0;
	for (const event of verifiedEvents) {
		if (!event.userVerified) {
			continue;
		}
		if (event.subjectIds.includes(nodeId) && event.sessionId > latestSession) {
			latestSession = event.sessionId;
		}
	}

	if (latestSession <= 0) {
		return 0;
	}

	return round6(clamp01(latestSession / maxSessionId));
}

/**
 * Proximity score from BFS hop distance (`hop=0 -> 1.0`, `hop=1 -> 0.5`, `hop=2 -> 0.25`).
 */
export function computeProximityScore(hopDistance: number): number {
	if (hopDistance <= 0) {
		return 1;
	}
	return round6(clamp01(1 / Math.pow(2, hopDistance)));
}

/**
 * Priority boost when `nodeType` aligns with query `preferredTypes`.
 * Returns `0` when `disableTypePriority` ablation flag is enabled.
 */
export function computeTypeBoost(
	nodeType: EntityType,
	preferredTypes: readonly EntityType[],
	disableTypePriority: boolean,
): number {
	if (disableTypePriority || preferredTypes.length === 0) {
		return 0;
	}
	if (preferredTypes[0] === nodeType) {
		return 1;
	}
	if (preferredTypes.includes(nodeType)) {
		return 0.75;
	}
	return 0;
}

/**
 * Computes normalized `[0, 1]` scoring components and weighted total score.
 */
export function scoreCandidate(params: {
	node: GraphNode;
	semanticScore: number;
	hopDistance: number;
	preferredTypes: readonly EntityType[];
	maxTotalDegree: number;
	maxSessionId: number;
	verifiedEvents: SessionEvent[];
	weights: ScoringWeights;
	disableTypePriority: boolean;
}): CandidateScoreBreakdown {
	const semantic = round6(clamp01(params.semanticScore));
	const proximity = computeProximityScore(params.hopDistance);
	const typeBoost = computeTypeBoost(
		params.node.type,
		params.preferredTypes,
		params.disableTypePriority,
	);
	const degree = computeDampedDegree(params.node, params.maxTotalDegree);
	const recency = computeNodeRecency(
		params.node.id,
		params.verifiedEvents,
		params.maxSessionId,
	);

	const w = params.weights;
	const total = round6(
		w.semantic * semantic +
			w.proximity * proximity +
			w.typeBoost * typeBoost +
			w.degree * degree +
			w.recency * recency,
	);

	return {
		semantic,
		proximity,
		typeBoost,
		degree,
		recency,
		total,
	};
}
