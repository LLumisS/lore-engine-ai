/**
 * All data structures stored in settings, IndexedDB cache, or events.json
 * must remain strictly JSON-serializable (no Set or Map instances).
 */

export type EntityType =
	| 'NPC'
	| 'LOCATION'
	| 'FACTION'
	| 'QUEST'
	| 'ITEM'
	| 'SESSION_LOG'
	| 'LORE'
	| 'META'
	| 'UNTYPED';

export type StatusType = 'ACTIVE' | 'INACTIVE' | 'TERMINATED' | 'UNKNOWN';

export interface EntityState {
	statusType: StatusType;
	statusNote: string;
	sessionUpdated: number | null;
	source: 'TAG' | 'EVENT' | 'DEFAULT';
}

export interface NoteSection {
	heading: string;
	content: string;
	tokenCount: number;
}

export interface GraphNode {
	id: string;
	title: string;
	aliases: string[];
	type: EntityType;
	staticState: EntityState;
	tags: string[];
	metadata: Record<string, unknown>;
	content: string;
	sections: NoteSection[];
	tokenCount: number;
	inDegree: number;
	outDegree: number;
	mtime: number;
	isDirty: boolean;
}

export interface GraphEdge {
	sourceId: string;
	targetId: string;
	kind: 'LINK' | 'EMBED' | 'FRONTMATTER';
}

export interface StateChange {
	subject: string;
	newStatusType: StatusType;
	newStatusNote: string;
}

export interface SessionEvent {
	id: string;
	sessionId: number;
	sourceNoteId: string;
	subjects: string[];
	subjectIds: string[];
	action: string;
	details: string;
	stateChanges: StateChange[];
	userVerified: boolean;
	createdAt: number;
}

export type RetrievalMode =
	| 'AUTO'
	| 'PLOT_DEEP'
	| 'PLOT_LIGHT'
	| 'MECHANICS'
	| 'CUSTOM';

export type LlmProviderId = 'ollama' | 'openai' | 'anthropic' | 'gemini';

export type UiLanguage = 'uk' | 'ru' | 'en';

export interface TypeMapping {
	kind: 'folder' | 'tag';
	pattern: string;
	type: EntityType;
}

export interface ScoringWeights {
	semantic: number;
	proximity: number;
	typeBoost: number;
	degree: number;
	recency: number;
}

export interface StatusMappings {
	terminatedTags: string[];
	inactiveTags: string[];
}

export interface ExperimentFlags {
	disableGraphTraversal: boolean;
	disableTemporalStratification: boolean;
	disableTypePriority: boolean;
	logRetrievalTraces: boolean;
}

export interface PluginSettings {
	uiLanguage: UiLanguage;
	llmProvider: LlmProviderId;
	cloudConsentGiven: boolean;
	apiKeys: Partial<Record<LlmProviderId, string>>;
	modelName: string;
	embeddingProvider: LlmProviderId;
	embeddingModel: string;
	ollamaUrl: string;
	sessionFolder: string;
	sessionNumberPattern: string;
	typeMappings: TypeMapping[];
	statusMappings: StatusMappings;
	tokenBudgetDeep: number;
	tokenBudgetLight: number;
	historyTurns: number;
	entityPoolSize: number;
	scoringWeights: ScoringWeights;
	mechanicsPromptPath: string;
	experiment: ExperimentFlags;
	onboardingDone: boolean;
}

export interface CandidateScoreBreakdown {
	semantic: number;
	proximity: number;
	typeBoost: number;
	degree: number;
	recency: number;
	total: number;
}

export type CandidateInclusionReason =
	| 'anchor'
	| 'entity_pool'
	| 'graph_neighbor'
	| 'custom_selection';

export type CandidateExclusionReason =
	| 'over_budget'
	| 'ignored'
	| 'low_score';

export interface TracedCandidate {
	nodeId: string;
	title: string;
	type: EntityType;
	effectiveState: EntityState;
	hopDistance: number;
	path: string[];
	scoreBreakdown: CandidateScoreBreakdown;
	included: boolean;
	inclusionReason?: CandidateInclusionReason;
	exclusionReason?: CandidateExclusionReason;
	includedSections?: string[];
	tokenCount: number;
}

export interface IntentClassification {
	mode: Exclude<RetrievalMode, 'AUTO'>;
	preferredTypes: EntityType[];
	confidence: number;
	matchedKeywords: string[];
}

export interface RetrievalTrace {
	query: string;
	requestedMode: RetrievalMode;
	resolvedMode: Exclude<RetrievalMode, 'AUTO'>;
	intentConfidence: number;
	preferredTypes: EntityType[];
	anchorIds: string[];
	activeEntityPoolIds: string[];
	candidates: TracedCandidate[];
	includedEventIds: string[];
	eventsTokens: number;
	baseLoreTokens: number;
	totalTokensUsed: number;
	tokenBudget: number;
	timestamp: number;
}

export interface AssembledContext {
	contextText: string;
	trace: RetrievalTrace;
}

export interface GraphStats {
	totalNodes: number;
	totalEdges: number;
	dirtyNodes: number;
	byType: Record<EntityType, number>;
	byStatus: Record<StatusType, number>;
	edgesByKind: Record<GraphEdge['kind'], number>;
}
