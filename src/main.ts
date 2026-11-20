import { getAllTags, MarkdownView, Notice, Plugin, type TFile } from 'obsidian';
import {
	GraphStatsModal,
	OnboardingWizardModal,
} from './config/onboardingWizard';
import {
	LoreEngineSettingTab,
	PingLlmModal,
	type LoreEnginePluginHost,
} from './config/settingsTab';
import { resolveStaticState } from './core/statusRules';
import { GraphIndex } from './engine/graphIndex';
import { GraphStorage } from './engine/storage';
import {
	parseFrontmatterEntityType,
	resolveEntityType,
} from './engine/vaultParser';
import { formatMessage, t } from './i18n';
import { DEFAULT_SETTINGS, deepMergeSettings } from './settings';
import type { EntityType, PluginSettings, StatusType } from './types';

const NOTE_ENTITY_TYPES: readonly EntityType[] = [
	'NPC',
	'LOCATION',
	'FACTION',
	'QUEST',
	'ITEM',
	'SESSION_LOG',
	'LORE',
	'META',
	'UNTYPED',
];

const NOTE_STATUS_TYPES: readonly StatusType[] = [
	'ACTIVE',
	'INACTIVE',
	'TERMINATED',
	'UNKNOWN',
];

const AUTO_OPTION_VALUE = '__AUTO__';

export default class LoreEngineAIPlugin
	extends Plugin
	implements LoreEnginePluginHost
{
	settings: PluginSettings = deepMergeSettings(DEFAULT_SETTINGS);
	private graphStorage: GraphStorage | null = null;
	private graphIndex: GraphIndex | null = null;
	private statusBarEl: HTMLElement | null = null;
	private unsubscribeDirty: (() => void) | null = null;
	private activeAbortControllers = new Set<AbortController>();
	private pendingSelfBarUpdates = new Set<string>();

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

		this.addRibbonIcon(
			'tags',
			t(this.settings.uiLanguage, 'ribbonToggleNoteBarTooltip'),
			() => {
				void this.toggleNoteBarVisibility(!this.settings.showNoteBar);
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

		this.addCommand({
			id: 'ping-llm',
			name: t(this.settings.uiLanguage, 'commandPingLlmName'),
			callback: () => {
				this.openPingModal();
			},
		});

		this.addCommand({
			id: 'toggle-note-bar',
			name: t(this.settings.uiLanguage, 'commandToggleNoteBarName'),
			callback: () => {
				void this.toggleNoteBarVisibility(!this.settings.showNoteBar);
			},
		});

		this.addSettingTab(new LoreEngineSettingTab(this.app, this));

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
				if (this.pendingSelfBarUpdates.delete(file.path)) {
					void index.refreshSingleFile(file).then(() => {
						this.syncAllNoteBars(true);
					});
					return;
				}
				index.markFileDirty(file);
				this.syncAllNoteBars(true);
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
				this.syncAllNoteBars(true);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.syncAllNoteBars(false);
			}),
		);
		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				this.syncAllNoteBars(true);
			}),
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.syncAllNoteBars(false);
			}),
		);

		this.syncAllNoteBars(true);

		if (!this.settings.onboardingDone) {
			this.openOnboardingModal();
		}
	}

	private syncAllNoteBars(forceRefresh: boolean): void {
		if (!this.settings.showNoteBar) {
			this.removeAllNoteBars();
			return;
		}
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (leaf.view instanceof MarkdownView) {
				this.renderNoteBarForView(leaf.view, forceRefresh);
			}
		}
	}

	async toggleNoteBarVisibility(visible: boolean): Promise<void> {
		this.settings.showNoteBar = visible;
		await this.saveSettings();
		this.syncAllNoteBars(true);
	}

	private removeAllNoteBars(): void {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (leaf.view instanceof MarkdownView) {
				const existing = leaf.view.containerEl.querySelector(
					':scope > .lore-note-bar',
				);
				existing?.remove();
			}
		}
	}

	private renderNoteBarForView(
		view: MarkdownView,
		forceRefresh: boolean,
	): void {
		const containerEl = view.containerEl;
		const existingBar = containerEl.querySelector<HTMLElement>(
			':scope > .lore-note-bar',
		);
		const file = view.file;

		if (!file || file.extension !== 'md') {
			existingBar?.remove();
			return;
		}

		if (
			existingBar &&
			existingBar.dataset.loreFile === file.path &&
			!forceRefresh
		) {
			return;
		}

		if (
			existingBar &&
			existingBar.contains(activeDocument.activeElement)
		) {
			return;
		}

		const barEl = existingBar ?? containerEl.createDiv({ cls: 'lore-note-bar' });
		barEl.className = 'lore-note-bar';
		barEl.dataset.loreFile = file.path;
		barEl.empty();

		if (!existingBar) {
			containerEl.insertBefore(barEl, view.contentEl);
		}

		const lang = this.settings.uiLanguage;
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter: Record<string, unknown> | undefined =
			cache?.frontmatter;
		const tags = cache ? getAllTags(cache) ?? [] : [];

		const autoType = resolveEntityType(
			file.path,
			tags,
			undefined,
			this.settings,
		);
		const explicitType = parseFrontmatterEntityType(frontmatter);

		const autoState = resolveStaticState(
			tags,
			null,
			this.settings.statusMappings,
		);
		const resolvedState = resolveStaticState(
			tags,
			frontmatter ?? null,
			this.settings.statusMappings,
		);
		const rawExplicitStatus =
			typeof frontmatter?.status === 'string'
				? (frontmatter.status.trim().toUpperCase() as StatusType)
				: null;
		const explicitStatus =
			rawExplicitStatus && NOTE_STATUS_TYPES.includes(rawExplicitStatus)
				? rawExplicitStatus
				: null;

		const rawNote =
			typeof frontmatter?.status_note === 'string'
				? frontmatter.status_note
				: typeof frontmatter?.statusNote === 'string'
					? frontmatter.statusNote
					: resolvedState.statusNote;

		barEl.createSpan({
			cls: 'lore-badge lore-badge-accent',
			text: t(lang, 'noteBarTitle'),
		});

		const classGroup = barEl.createDiv({ cls: 'lore-note-bar-group' });
		classGroup.createSpan({
			cls: 'lore-muted',
			text: t(lang, 'noteBarClassLabel'),
		});
		const typeSelect = classGroup.createEl('select', {
			cls: 'dropdown lore-note-bar-select',
		});
		typeSelect.createEl('option', {
			value: AUTO_OPTION_VALUE,
			text: `${t(lang, 'noteBarAutoPrefix')} (${autoType})`,
		});
		for (const entityType of NOTE_ENTITY_TYPES) {
			typeSelect.createEl('option', {
				value: entityType,
				text: entityType,
			});
		}
		typeSelect.value = explicitType ?? AUTO_OPTION_VALUE;

		const statusGroup = barEl.createDiv({ cls: 'lore-note-bar-group' });
		statusGroup.createSpan({
			cls: 'lore-muted',
			text: t(lang, 'noteBarStatusLabel'),
		});
		const statusSelect = statusGroup.createEl('select', {
			cls: 'dropdown lore-note-bar-select',
		});
		statusSelect.createEl('option', {
			value: AUTO_OPTION_VALUE,
			text: `${t(lang, 'noteBarAutoPrefix')} (${autoState.statusType})`,
		});
		for (const statusType of NOTE_STATUS_TYPES) {
			statusSelect.createEl('option', {
				value: statusType,
				text: statusType,
			});
		}
		statusSelect.value = explicitStatus ?? AUTO_OPTION_VALUE;

		const noteInput = barEl.createEl('input', {
			cls: 'lore-note-bar-input',
			type: 'text',
			value: rawNote,
			placeholder: t(lang, 'noteBarNotePlaceholder'),
		});

		const commitChanges = (): void => {
			void this.applyInNoteMetadataChange(
				file,
				typeSelect.value,
				statusSelect.value,
				noteInput.value,
			);
		};

		typeSelect.addEventListener('change', commitChanges);
		statusSelect.addEventListener('change', commitChanges);
		noteInput.addEventListener('change', commitChanges);
		noteInput.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter') {
				evt.preventDefault();
				noteInput.blur();
			}
		});
	}

	private async applyInNoteMetadataChange(
		file: TFile,
		selectedType: string,
		selectedStatus: string,
		rawNote: string,
	): Promise<void> {
		const trimmedNote = rawNote.trim();
		const nextType =
			selectedType === AUTO_OPTION_VALUE ? undefined : selectedType;
		const nextStatus =
			selectedStatus === AUTO_OPTION_VALUE ? undefined : selectedStatus;
		const nextNote = trimmedNote.length > 0 ? trimmedNote : undefined;

		this.pendingSelfBarUpdates.add(file.path);
		window.setTimeout(() => {
			this.pendingSelfBarUpdates.delete(file.path);
		}, 2000);

		try {
			await this.app.fileManager.processFrontMatter(
				file,
				(frontmatter: Record<string, unknown>) => {
					if (nextType === undefined) {
						delete frontmatter.type;
					} else {
						frontmatter.type = nextType;
					}

					if (nextStatus === undefined) {
						delete frontmatter.status;
					} else {
						frontmatter.status = nextStatus;
					}

					if (nextNote === undefined) {
						delete frontmatter.status_note;
						delete frontmatter.statusNote;
					} else {
						frontmatter.status_note = nextNote;
					}
				},
			);

			const updatedNode = await this.graphIndex?.refreshSingleFile(file, {
				type: nextType,
				status: nextStatus,
				status_note: nextNote,
			});

			const effectiveType = updatedNode?.type ?? nextType ?? 'UNTYPED';
			const effectiveStatus =
				updatedNode?.staticState.statusType ?? nextStatus ?? 'UNKNOWN';

			new Notice(
				formatMessage(
					t(this.settings.uiLanguage, 'noteBarSavedNotice'),
					{
						title: file.basename,
						type: effectiveType,
						status: effectiveStatus,
					},
				),
			);
		} catch (error) {
			this.pendingSelfBarUpdates.delete(file.path);
			const msg =
				error instanceof Error ? error.message : String(error);
			new Notice(
				formatMessage(t(this.settings.uiLanguage, 'syncErrorNotice'), {
					error: msg,
				}),
			);
		}
	}

	trackAbortController(controller: AbortController): () => void {
		this.activeAbortControllers.add(controller);
		return () => {
			this.activeAbortControllers.delete(controller);
		};
	}

	openPingModal(): void {
		new PingLlmModal(this.app, this).open();
	}

	openOnboardingModal(): void {
		new OnboardingWizardModal(
			this.app,
			this.settings,
			async (updatedSettings) => {
				this.settings = updatedSettings;
				await this.saveSettings();
				await this.runSync(true);
				this.syncAllNoteBars(true);
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
			this.syncAllNoteBars(true);
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
		for (const controller of this.activeAbortControllers) {
			controller.abort();
		}
		this.activeAbortControllers.clear();
		this.pendingSelfBarUpdates.clear();
		this.removeAllNoteBars();

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
