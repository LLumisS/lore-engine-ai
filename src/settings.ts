import type {
	ExperimentFlags,
	LlmProviderId,
	PluginSettings,
	ScoringWeights,
	StatusMappings,
	TypeMapping,
} from './types';

export const DEFAULT_CHAT_MODELS: Partial<Record<LlmProviderId, string>> = {
	ollama: '',
	openai: '',
	anthropic: '',
	gemini: '',
};

export const DEFAULT_EMBEDDING_MODELS: Partial<Record<LlmProviderId, string>> =
{
	ollama: '',
	openai: '',
	gemini: '',
};

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
	semantic: 0.35,
	proximity: 0.25,
	typeBoost: 0.2,
	degree: 0.1,
	recency: 0.1,
};

export const DEFAULT_STATUS_MAPPINGS: StatusMappings = {
	activeTags: [],
	inactiveTags: [],
	terminatedTags: [],
};

export const DEFAULT_TYPE_MAPPINGS: TypeMapping[] = [
	{ kind: 'folder', pattern: 'NPC/', type: 'NPC' },
	{ kind: 'folder', pattern: 'Locations/', type: 'LOCATION' },
	{ kind: 'folder', pattern: 'Quests/', type: 'QUEST' },
	{ kind: 'folder', pattern: 'Factions/', type: 'FACTION' },
	{ kind: 'folder', pattern: 'Items/', type: 'ITEM' },
	{ kind: 'folder', pattern: 'Lore/', type: 'LORE' },
	{ kind: 'tag', pattern: '#npc', type: 'NPC' },
	{ kind: 'tag', pattern: '#location', type: 'LOCATION' },
	{ kind: 'tag', pattern: '#локація', type: 'LOCATION' },
	{ kind: 'tag', pattern: '#локация', type: 'LOCATION' },
	{ kind: 'tag', pattern: '#quest', type: 'QUEST' },
	{ kind: 'tag', pattern: '#квест', type: 'QUEST' },
	{ kind: 'tag', pattern: '#faction', type: 'FACTION' },
	{ kind: 'tag', pattern: '#фракція', type: 'FACTION' },
	{ kind: 'tag', pattern: '#фракция', type: 'FACTION' },
	{ kind: 'tag', pattern: '#item', type: 'ITEM' },
	{ kind: 'tag', pattern: '#предмет', type: 'ITEM' },
	{ kind: 'tag', pattern: '#lore', type: 'LORE' },
	{ kind: 'tag', pattern: '#лор', type: 'LORE' },
	{ kind: 'tag', pattern: '#meta', type: 'META' },
];

export const DEFAULT_EXPERIMENT_FLAGS: ExperimentFlags = {
	disableGraphTraversal: false,
	disableTemporalStratification: false,
	disableTypePriority: false,
	logRetrievalTraces: false,
};

export const DEFAULT_SETTINGS: PluginSettings = {
	uiLanguage: 'uk',
	llmProvider: 'ollama',
	cloudConsentGiven: false,
	apiKeys: {},
	modelName: 'llama3.1:8b',
	chatModels: { ...DEFAULT_CHAT_MODELS },
	embeddingProvider: 'ollama',
	embeddingModel: 'nomic-embed-text',
	embeddingModels: { ...DEFAULT_EMBEDDING_MODELS },
	ollamaUrl: 'http://localhost:11434',
	sessionFolder: 'Sessions',
	sessionNumberPattern: '(?:Сесія|Session|Сессия)\\s*#?(\\d+)',
	typeMappings: DEFAULT_TYPE_MAPPINGS,
	statusMappings: DEFAULT_STATUS_MAPPINGS,
	tokenBudgetDeep: 10000,
	tokenBudgetLight: 3500,
	historyTurns: 5,
	entityPoolSize: 3,
	scoringWeights: DEFAULT_SCORING_WEIGHTS,
	mechanicsPromptPath: '',
	experiment: DEFAULT_EXPERIMENT_FLAGS,
	onboardingDone: false,
	showNoteBar: false,
};

function cloneTypeMappings(mappings: TypeMapping[]): TypeMapping[] {
	return mappings.map((mapping) => ({ ...mapping }));
}

/**
 * Deeply merges saved settings with defaults so partial nested objects
 * (scoringWeights, experiment, statusMappings, apiKeys) never lose default keys
 * and DEFAULT_SETTINGS is never mutated.
 */
export function deepMergeSettings(
	defaults: PluginSettings,
	saved?: Partial<PluginSettings> | null,
): PluginSettings {
	const source = saved ?? {};

	const typeMappings = Array.isArray(source.typeMappings)
		? cloneTypeMappings(source.typeMappings)
		: cloneTypeMappings(defaults.typeMappings);

	const activeTags = Array.isArray(source.statusMappings?.activeTags)
		? [...source.statusMappings.activeTags]
		: [...defaults.statusMappings.activeTags];

	const terminatedTags = Array.isArray(source.statusMappings?.terminatedTags)
		? [...source.statusMappings.terminatedTags]
		: [...defaults.statusMappings.terminatedTags];

	const inactiveTags = Array.isArray(source.statusMappings?.inactiveTags)
		? [...source.statusMappings.inactiveTags]
		: [...defaults.statusMappings.inactiveTags];

	return {
		...defaults,
		...source,
		apiKeys: {
			...defaults.apiKeys,
			...(source.apiKeys ?? {}),
		},
		chatModels: {
			...defaults.chatModels,
			...(source.chatModels ?? {}),
		},
		embeddingModels: {
			...defaults.embeddingModels,
			...(source.embeddingModels ?? {}),
		},
		typeMappings,
		statusMappings: {
			activeTags,
			terminatedTags,
			inactiveTags,
		},
		scoringWeights: {
			...defaults.scoringWeights,
			...(source.scoringWeights ?? {}),
		},
		experiment: {
			...defaults.experiment,
			...(source.experiment ?? {}),
		},
	};
}
