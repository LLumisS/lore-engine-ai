import { Notice, Plugin } from 'obsidian';
import {
	GraphStatsModal,
	OnboardingWizardModal,
} from './config/onboardingWizard';
import { GraphIndex } from './engine/graphIndex';
import { GraphStorage } from './engine/storage';
import { formatMessage, t } from './i18n';
import { DEFAULT_SETTINGS, deepMergeSettings } from './settings';
import type { PluginSettings } from './types';

export default class LoreEngineAIPlugin extends Plugin {
	settings: PluginSettings = deepMergeSettings(DEFAULT_SETTINGS);
	private graphStorage: GraphStorage | null = null;
	private graphIndex: GraphIndex | null = null;
	private statusBarEl: HTMLElement | null = null;
	private unsubscribeDirty: (() => void) | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.graphStorage = new GraphStorage(this.app.vault.getName());
		this.graphIndex = new GraphIndex(
			this.app,
			this.graphStorage,
			() => this.settings,
		);

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('lore-status-bar-item');
		this.statusBarEl.setAttribute(
			'aria-label',
			t(this.settings.uiLanguage, 'statusBarTooltip'),
		);
		this.registerDomEvent(this.statusBarEl, 'click', () => {
			void this.runSync(false);
		});

		this.unsubscribeDirty = this.graphIndex.onDirtyChange((count) => {
			this.updateStatusBar(count);
		});
		this.updateStatusBar(0);

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

		this.addCommand({
			id: 'sync-graph',
			name: t(this.settings.uiLanguage, 'commandSyncGraphName'),
			callback: () => {
				void this.runSync(false);
			},
		});

		this.addCommand({
			id: 'show-graph-stats',
			name: t(this.settings.uiLanguage, 'commandGraphStatsName'),
			callback: () => {
				if (!this.graphIndex) {
					return;
				}
				const index = this.graphIndex;
				new GraphStatsModal(
					this.app,
					() => this.settings.uiLanguage,
					() => index.getStats(),
					() => this.runSync(false),
				).open();
			},
		});

		this.addCommand({
			id: 'open-onboarding',
			name: t(this.settings.uiLanguage, 'commandOnboardingName'),
			callback: () => {
				this.openOnboardingModal();
			},
		});

		this.app.workspace.onLayoutReady(() => {
			void this.onWorkspaceReady();
		});
	}

	private async onWorkspaceReady(): Promise<void> {
		if (!this.graphIndex) {
			return;
		}

		await this.graphIndex.initialize();
		const index = this.graphIndex;

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				index.markFileDirty(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				index.handleFileCreate(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				index.handleFileDelete(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				index.handleFileRename(file, oldPath);
			}),
		);

		if (!this.settings.onboardingDone) {
			this.openOnboardingModal();
		}
	}

	private openOnboardingModal(): void {
		new OnboardingWizardModal(
			this.app,
			this.settings,
			async (updatedSettings) => {
				this.settings = updatedSettings;
				await this.saveSettings();
				await this.runSync(true);
			},
		).open();
	}

	private async runSync(forceFull: boolean): Promise<void> {
		if (!this.graphIndex) {
			return;
		}
		const lang = this.settings.uiLanguage;

		try {
			const result = await this.graphIndex.sync(forceFull);
			new Notice(
				formatMessage(t(lang, 'syncCompletedNotice'), {
					nodes: result.totalNodes,
					edges: result.totalEdges,
					updated: result.updatedCount,
				}),
			);
		} catch (error) {
			const msg =
				error instanceof Error ? error.message : String(error);
			new Notice(
				formatMessage(t(lang, 'syncErrorNotice'), { error: msg }),
			);
		}
	}

	private updateStatusBar(dirtyCount: number): void {
		if (!this.statusBarEl) {
			return;
		}
		const lang = this.settings.uiLanguage;
		if (dirtyCount > 0) {
			this.statusBarEl.setText(
				formatMessage(t(lang, 'statusBarDirty'), { count: dirtyCount }),
			);
			this.statusBarEl.addClass('lore-status-bar-dirty');
		} else {
			this.statusBarEl.setText(t(lang, 'statusBarSynced'));
			this.statusBarEl.removeClass('lore-status-bar-dirty');
		}
	}

	onunload(): void {
		this.unsubscribeDirty?.();
		this.unsubscribeDirty = null;
		this.graphStorage?.close();
		this.graphStorage = null;
		this.graphIndex = null;
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<PluginSettings> | null;
		this.settings = deepMergeSettings(DEFAULT_SETTINGS, saved);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
