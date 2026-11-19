import type {
	ExperimentFlags,
	PluginSettings,
	ScoringWeights,
	StatusMappings,
	TypeMapping,
} from './types';

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
	semantic: 0.35,
	proximity: 0.25,
	typeBoost: 0.2,
	degree: 0.1,
	recency: 0.1,
};

export const DEFAULT_STATUS_MAPPINGS: StatusMappings = {
	terminatedTags: ['#статус/мертвий', '#status/dead'],
	inactiveTags: ['#статус/зник', '#status/missing'],
};

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
	embeddingProvider: 'ollama',
	embeddingModel: 'nomic-embed-text',
	ollamaUrl: 'http://localhost:11434',
	sessionFolder: 'Sessions',
	sessionNumberPattern: '(?:Сесія|Session|Сессия)\\s*#?(\\d+)',
	typeMappings: [],
	statusMappings: DEFAULT_STATUS_MAPPINGS,
	tokenBudgetDeep: 10000,
	tokenBudgetLight: 3500,
	historyTurns: 5,
	entityPoolSize: 3,
	scoringWeights: DEFAULT_SCORING_WEIGHTS,
	mechanicsPromptPath: '',
	experiment: DEFAULT_EXPERIMENT_FLAGS,
	onboardingDone: false,
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
		typeMappings,
		statusMappings: {
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
