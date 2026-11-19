import { uk } from './uk';

export type TranslationKey = keyof typeof uk;
export type TranslationDictionary = Record<TranslationKey, string>;

export const en: TranslationDictionary = {
	pluginName: 'LoreEngine AI',
	ribbonGreetTooltip: 'LoreEngine AI greeting',
	commandHelloName: 'Hello: check plugin status',
	helloNotice: 'Hello, world! LoreEngine AI is ready.',
	settingsHeadingGeneral: 'General settings',
	settingsLanguageName: 'Interface language',
	settingsLanguageDesc:
		'Choose the plugin interface language (Ukrainian by default).',
	settingsLanguageUk: 'Українська',
	settingsLanguageRu: 'Русский',
	settingsLanguageEn: 'English',
	settingsProviderName: 'LLM provider',
	settingsProviderDesc: 'Local Ollama is used by default.',
	commandSyncGraphName: 'Sync knowledge graph',
	commandGraphStatsName: 'Show graph statistics',
	commandOnboardingName: 'Open vault setup wizard',
	statusBarSynced: 'LoreEngine: synced',
	statusBarDirty: '⚡ LoreEngine: unsynced ({count})',
	statusBarTooltip: 'Click to sync LoreEngine AI graph',
	syncCompletedNotice:
		'Graph synced: {nodes} nodes, {edges} edges (updated: {updated}).',
	syncErrorNotice: 'Failed to sync graph: {error}',
	statsModalTitle: 'LoreEngine AI graph statistics',
	statsTotalNodes: 'Total nodes (notes)',
	statsTotalEdges: 'Total edges (links)',
	statsDirtyNodes: 'Pending sync (dirty)',
	statsByTypeHeading: 'Distribution by entity type',
	statsByStatusHeading: 'Distribution by static state',
	statsByEdgeKindHeading: 'Edges by link kind',
	statsSyncNowButton: '⚡ Sync knowledge graph',
	onboardingTitle: 'LoreEngine AI setup wizard',
	onboardingSubtitle:
		'Configure session folders, entity type rules, and status tags for your vault.',
	onboardingAutoDetectBtn: 'Auto-detect vault structure',
	onboardingAutoDetectedNotice: 'Vault structure analyzed.',
	onboardingSessionFolderName: 'Session logs folder',
	onboardingSessionFolderDesc:
		'Path to the folder with session logs (e.g. Sessions, Сесії, Сессии).',
	onboardingTypeMappingsName: 'Entity type rules',
	onboardingTypeMappingsDesc:
		'One rule per line: folder:Path=TYPE or tag:#tag=TYPE',
	onboardingTerminatedTagsName:
		'TERMINATED status tags (dead / completed / destroyed)',
	onboardingTerminatedTagsDesc: 'Comma-separated list of tags',
	onboardingInactiveTagsName:
		'INACTIVE status tags (missing / not started)',
	onboardingInactiveTagsDesc: 'Comma-separated list of tags',
	onboardingSaveButton: 'Confirm and sync',
	onboardingCancelButton: 'Cancel',
	onboardingSavedNotice: 'Settings saved and graph synced.',
};
