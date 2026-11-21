import { normalizePath, TFile, type App } from 'obsidian';
import { MECHANICS_SYSTEM_PROMPT_DND5E } from '../llm/prompts';
import type { AssembledContext, PluginSettings } from '../types';

function hashTextFnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/**
 * Resolves the rules system prompt for MECHANICS mode by reading the optional
 * `mechanicsPromptPath` note from the vault or falling back to D&D 5e rules.
 */
export async function loadMechanicsRulesText(
	app: App,
	settings: PluginSettings,
): Promise<string> {
	const rawPath = settings.mechanicsPromptPath.trim();
	if (rawPath) {
		const normalized = normalizePath(rawPath);
		const file = app.vault.getAbstractFileByPath(normalized);
		if (file instanceof TFile && file.extension === 'md') {
			const content = await app.vault.cachedRead(file);
			if (content.trim().length > 0) {
				return content.trim();
			}
		}
	}
	return MECHANICS_SYSTEM_PROMPT_DND5E;
}

/**
 * Appends one JSONL retrieval trace record to `<pluginDir>/traces.jsonl`
 * when `settings.experiment.logRetrievalTraces` is enabled.
 */
export async function appendRetrievalTraceLog(
	app: App,
	pluginDir: string,
	entry: {
		query: string;
		settings: PluginSettings;
		result: AssembledContext;
	},
): Promise<void> {
	if (!entry.settings.experiment.logRetrievalTraces) {
		return;
	}

	const adapter = app.vault.adapter;
	const cleanDir = normalizePath(pluginDir);
	const tracePath = normalizePath(`${cleanDir}/traces.jsonl`);

	const payload = {
		timestamp: entry.result.trace.timestamp,
		query: entry.query,
		requestedMode: entry.result.trace.requestedMode,
		resolvedMode: entry.result.trace.resolvedMode,
		settingsSnapshot: {
			tokenBudgetDeep: entry.settings.tokenBudgetDeep,
			tokenBudgetLight: entry.settings.tokenBudgetLight,
			eventsBudgetShare: entry.settings.eventsBudgetShare,
			firstHopMaxCandidates: entry.settings.firstHopMaxCandidates,
			scoringWeights: entry.settings.scoringWeights,
			experiment: entry.settings.experiment,
		},
		contextHash: hashTextFnv1a(entry.result.contextText),
		trace: entry.result.trace,
	};

	const line = `${JSON.stringify(payload)}\n`;
	const existing = (await adapter.exists(tracePath))
		? await adapter.read(tracePath)
		: '';
	await adapter.write(tracePath, `${existing}${line}`);
}
