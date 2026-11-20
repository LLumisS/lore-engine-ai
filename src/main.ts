import { Plugin } from 'obsidian';
import { LoreEngineApp, type PluginBridge } from './app';
import { registerCommands } from './commands';
import { DEFAULT_SETTINGS, deepMergeSettings } from './settings';
import type { PluginSettings } from './types';

export default class LoreEngineAIPlugin extends Plugin implements PluginBridge {
	settings: PluginSettings = deepMergeSettings(DEFAULT_SETTINGS);
	private loreApp: LoreEngineApp | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.loreApp = new LoreEngineApp(this);
		this.loreApp.initialize();
		registerCommands(this, this.loreApp);
	}

	onunload(): void {
		this.loreApp?.dispose();
		this.loreApp = null;
	}

	openPingModal(): void {
		this.loreApp?.openPingModal();
	}

	openOnboardingModal(): void {
		this.loreApp?.openOnboardingModal();
	}

	trackAbortController(controller: AbortController): () => void {
		return this.loreApp
			? this.loreApp.trackAbortController(controller)
			: () => undefined;
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<PluginSettings> | null;
		this.settings = deepMergeSettings(DEFAULT_SETTINGS, saved);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
