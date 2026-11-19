import { Notice, Plugin } from 'obsidian';
import { t } from './i18n';
import { DEFAULT_SETTINGS, deepMergeSettings } from './settings';
import type { PluginSettings } from './types';

export default class LoreEngineAIPlugin extends Plugin {
	settings: PluginSettings = deepMergeSettings(DEFAULT_SETTINGS);

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addRibbonIcon(
			'dice',
			t(this.settings.uiLanguage, 'ribbonGreetTooltip'),
			() => {
				new Notice(t(this.settings.uiLanguage, 'helloNotice'));
			},
		);

		this.addCommand({
			id: 'hello',
			name: t(this.settings.uiLanguage, 'commandHelloName'),
			callback: () => {
				new Notice(t(this.settings.uiLanguage, 'helloNotice'));
			},
		});
	}

	onunload(): void {}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<PluginSettings> | null;
		this.settings = deepMergeSettings(DEFAULT_SETTINGS, saved);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
