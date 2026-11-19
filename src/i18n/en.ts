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
		'Choose the plugin interface language.',
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
	commandPingLlmName: 'Test LLM connection',
	pingModalTitle: 'Test LLM connection',
	pingProviderInfo: 'Provider: {provider} | Model: {model}',
	pingEmbeddingInfo: 'Embeddings: {provider} | Model: {model}',
	pingPromptLabel: 'Test prompt',
	pingDefaultPrompt:
		'Hello! Reply with one short sentence to verify the LoreEngine AI connection.',
	pingStartButton: 'Send',
	pingEmbeddingButton: 'Test embeddings',
	pingAbortButton: 'Stop',
	pingStatusIdle: 'Ready to test.',
	pingStatusStreaming: 'Streaming response...',
	pingStatusEmbedding: 'Testing embeddings model...',
	pingStatusEmbeddingDone:
		'Embeddings ready: vector dimension {dim} ({ms} ms).',
	pingEmbeddingUnsupported:
		'The selected embeddings provider does not support embeddings.',
	pingStatusDone: 'Completed. Tokens (input/output): {input} / {output}',
	pingStatusAborted: 'Generation stopped by user.',
	settingsHeadingLlm: 'LLM and embeddings settings',
	settingsHeadingPrivacy: 'Privacy and cloud providers',
	settingsHeadingVault: 'Vault structure',
	settingsPrivacyNotice:
		'By default the plugin runs locally via Ollama. API keys are stored in plain text in the local vault data.json file. Local trace logs (traces.jsonl) may contain note excerpts.',
	settingsCloudConsentName: 'Consent to send context to cloud LLMs',
	settingsCloudConsentDesc:
		'Allow sending assembled note excerpts and queries to the selected cloud API (OpenAI, Anthropic, Gemini).',
	settingsOllamaUrlName: 'Local Ollama server URL',
	settingsOllamaUrlDesc: 'Default: http://localhost:11434',
	settingsRefreshModelsBtn: 'Refresh Ollama models',
	settingsModelsLoadedNotice: 'Found Ollama models: {count}',
	settingsModelName: 'Chat model',
	settingsModelDesc:
		'Model identifier for chat and event extraction (e.g. llama3.1:8b, gpt-4o-mini, claude-3-5-sonnet-latest, gemini-2.5-flash).',
	settingsEmbeddingProviderName: 'Embeddings provider',
	settingsEmbeddingProviderDesc:
		'Select vector embeddings provider.',
	settingsEmbeddingModelName: 'Embeddings model',
	settingsEmbeddingModelDesc:
		'For example: nomic-embed-text, text-embedding-3-small, text-embedding-004.',
	settingsApiKeyName: 'API key',
	settingsApiKeyDesc:
		'Access key for the selected cloud provider ({provider}).',
	settingsApiKeyOpenAiName: 'OpenAI API key',
	settingsApiKeyAnthropicName: 'Anthropic API key',
	settingsApiKeyGeminiName: 'Google Gemini API key',
	settingsApiKeyPlaceholder: 'Enter API key...',
	settingsTestLlmName: 'Test LLM connectivity',
	settingsTestLlmDesc:
		'Open streaming test modal for the current provider.',
	settingsOpenOnboardingName: 'Vault setup wizard',
	settingsOpenOnboardingDesc:
		'Re-run auto-detection of session folders, entity classes, and status tags.',
	consentModalTitle: 'Consent to use cloud LLM provider',
	consentModalBody:
		'You are selecting a cloud provider ({provider}). When querying, the plugin will send assembled excerpts of relevant vault notes and your prompt to this provider. There is no hidden telemetry. You can revoke consent at any time in settings.',
	consentAcceptButton: 'Grant consent',
	consentDeclineButton: 'Keep local Ollama',
	llmErrorCloudConsent:
		'Cloud calls are blocked: grant explicit consent in LoreEngine AI settings.',
	llmErrorAuth:
		'Authentication failed ({provider}, HTTP {status}): check your API key in settings.',
	llmErrorModelNotFound:
		'Model "{model}" was not found on provider {provider} (HTTP 404). Check the model name.',
	llmErrorRateLimit:
		'Rate limit exceeded ({provider}, HTTP 429). {retryHint}',
	llmErrorRetryAfter: 'Retry after {seconds} s.',
	llmErrorOllamaCors:
		'Could not connect to Ollama ({url}). Ensure Ollama is running, and if blocked by CORS set OLLAMA_ORIGINS=app://obsidian.md* before starting Ollama.',
	llmErrorNetwork:
		'Network or CORS error while calling {provider}: {details}',
	llmErrorContextLength:
		'Model context length exceeded ({provider}): {details}',
	llmErrorInvalidJson:
		'Provider {provider} returned invalid JSON: {details}',
	llmErrorGeneric: 'Provider {provider} error: {details}',
};
