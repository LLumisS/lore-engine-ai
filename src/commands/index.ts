import { MarkdownView, Notice, type Plugin } from 'obsidian';
import type { LoreEngineApp } from '../app';
import { t } from '../i18n';
import type { PluginSettings } from '../types';

export interface CommandPluginContext extends Plugin {
	settings: PluginSettings;
}

export function registerCommands(
	plugin: CommandPluginContext,
	loreApp: LoreEngineApp,
): void {
	const lang = plugin.settings.uiLanguage;

	plugin.addCommand({
		id: 'hello',
		name: t(lang, 'commandHelloName'),
		callback: () => {
			new Notice(t(plugin.settings.uiLanguage, 'helloNotice'));
		},
	});

	plugin.addCommand({
		id: 'sync-graph',
		name: t(lang, 'commandSyncGraphName'),
		callback: () => {
			void loreApp.runSync(false);
		},
	});

	plugin.addCommand({
		id: 'show-graph-stats',
		name: t(lang, 'commandGraphStatsName'),
		callback: () => {
			loreApp.openStatsModal();
		},
	});

	plugin.addCommand({
		id: 'open-onboarding',
		name: t(lang, 'commandOnboardingName'),
		callback: () => {
			loreApp.openOnboardingModal();
		},
	});

	plugin.addCommand({
		id: 'ping-llm',
		name: t(lang, 'commandPingLlmName'),
		callback: () => {
			loreApp.openPingModal();
		},
	});

	plugin.addCommand({
		id: 'parse-session',
		name: t(lang, 'commandParseSessionName'),
		checkCallback: (checking) => {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.file && loreApp.isSessionNote(view.file)) {
				if (!checking) {
					void loreApp.parseSessionFile(view.file);
				}
				return true;
			}
			return false;
		},
	});

	plugin.addCommand({
		id: 'find-anchors',
		name: t(lang, 'commandFindAnchorsName'),
		callback: () => {
			loreApp.openAnchorSearchModal();
		},
	});

	plugin.addCommand({
		id: 'edit-note-metadata',
		name: t(lang, 'commandEditNoteMetadataName'),
		checkCallback: (checking) => {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.file) {
				if (!checking) {
					loreApp.openNoteMetadataModal(view.file);
				}
				return true;
			}
			return false;
		},
	});
}
