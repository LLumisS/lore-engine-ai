import { Notice, TFile, type Plugin } from 'obsidian';
import { matchEntityName } from './core/entityMatcher';
import {
	GraphStatsModal,
	OnboardingWizardModal,
} from './config/onboardingWizard';
import {
	CloudConsentModal,
	LoreEngineSettingTab,
	PingLlmModal,
	type LoreEnginePluginHost,
} from './config/settingsTab';
import {
	determineSessionId,
	EventManager,
	type PersistedEntityStateOverride,
} from './engine/eventManager';
import { GraphIndex } from './engine/graphIndex';
import { GraphStorage } from './engine/storage';
import { isPathInSessionFolder } from './engine/vaultParser';
import { VectorIndex } from './engine/vectorIndex';
import { formatMessage, t } from './i18n';
import { createEmbeddingProvider, createLlmProvider } from './llm/llmProvider';
import type { PluginSettings, SessionEvent, StatusType } from './types';
import {
	AnchorSearchModal,
	NoteMetadataModal,
	SessionEventPreviewModal,
} from './ui/eventModal';

export interface PluginBridge extends Plugin, LoreEnginePluginHost {
	settings: PluginSettings;
	saveSettings(): Promise<void>;
}

/**
 * Composition root assembling LoreEngine AI services, event listeners,
 * sync orchestration, and modals. Keeps `src/main.ts` strictly lifecycle-only.
 */
export class LoreEngineApp {
	private readonly plugin: PluginBridge;
	private readonly storage: GraphStorage;
	private readonly graphIndex: GraphIndex;
	private readonly vectorIndex: VectorIndex;
	private readonly eventManager: EventManager;

	private statusBarEl: HTMLElement | null = null;
	private unsubscribeDirty: (() => void) | null = null;
	private activeAbortControllers = new Set<AbortController>();
	private pendingSelfMetadataUpdates = new Set<string>();

	constructor(plugin: PluginBridge) {
		this.plugin = plugin;
		const app = plugin.app;
		const pluginDir =
			plugin.manifest.dir ??
			`${app.vault.configDir}/plugins/${plugin.manifest.id}`;

		this.storage = new GraphStorage(app.vault.getName());
		this.eventManager = new EventManager(app, pluginDir);
		this.graphIndex = new GraphIndex(
			app,
			this.storage,
			() => this.plugin.settings,
			() => this.eventManager.getEntityStateOverrides(),
		);
		this.vectorIndex = new VectorIndex(this.storage);
	}

	initialize(): void {
		const app = this.plugin.app;
		const lang = this.plugin.settings.uiLanguage;

		this.statusBarEl = this.plugin.addStatusBarItem();
		this.statusBarEl.addClass('lore-status-bar-item');
		this.statusBarEl.setAttribute(
			'aria-label',
			t(lang, 'statusBarTooltip'),
		);
		this.plugin.registerDomEvent(this.statusBarEl, 'click', () => {
			void this.runSync(false);
		});

		this.unsubscribeDirty = this.graphIndex.onDirtyChange((count) => {
			this.updateStatusBar(count);
		});
		this.updateStatusBar(0);

		this.plugin.addRibbonIcon(
			'dice',
			t(lang, 'ribbonGreetTooltip'),
			() => {
				new Notice(t(this.plugin.settings.uiLanguage, 'helloNotice'));
			},
		);

		this.plugin.addSettingTab(
			new LoreEngineSettingTab(app, this.plugin),
		);

		app.workspace.onLayoutReady(() => {
			void this.onWorkspaceReady();
		});
	}

	private async onWorkspaceReady(): Promise<void> {
		const app = this.plugin.app;
		await this.graphIndex.initialize();
		await this.vectorIndex.initialize();

		const eventsInit = await this.eventManager.initialize();
		if (eventsInit.corruptedBackupCreated) {
			new Notice(
				t(this.plugin.settings.uiLanguage, 'eventsCorruptedBackupNotice'),
			);
		}

		this.plugin.registerEvent(
			app.metadataCache.on('changed', (file) => {
				if (this.pendingSelfMetadataUpdates.delete(file.path)) {
					void this.graphIndex.refreshSingleFile(file);
					return;
				}
				this.graphIndex.markFileDirty(file);
			}),
		);
		this.plugin.registerEvent(
			app.vault.on('create', (file) => {
				this.graphIndex.handleFileCreate(file);
			}),
		);
		this.plugin.registerEvent(
			app.vault.on('delete', (file) => {
				this.graphIndex.handleFileDelete(file);
				void this.eventManager.handleNoteDelete(file.path);
			}),
		);
		this.plugin.registerEvent(
			app.vault.on('rename', (file, oldPath) => {
				this.graphIndex.handleFileRename(file, oldPath);
				void this.eventManager.handleNoteRename(oldPath, file.path);
			}),
		);

		this.plugin.registerEvent(
			app.workspace.on('file-menu', (menu, abstractFile) => {
				if (
					!(abstractFile instanceof TFile) ||
					abstractFile.extension !== 'md'
				) {
					return;
				}
				const currentLang = this.plugin.settings.uiLanguage;
				menu.addItem((item) => {
					item.setTitle(t(currentLang, 'fileMenuEditMetadata'))
						.setIcon('tag')
						.onClick(() => {
							this.openNoteMetadataModal(abstractFile);
						});
				});
				if (this.isSessionNote(abstractFile)) {
					menu.addItem((item) => {
						item.setTitle(t(currentLang, 'fileMenuParseSession'))
							.setIcon('list-checks')
							.onClick(() => {
								void this.parseSessionFile(abstractFile);
							});
					});
				}
			}),
		);

		if (!this.plugin.settings.onboardingDone) {
			this.openOnboardingModal();
		}
	}

	trackAbortController(controller: AbortController): () => void {
		this.activeAbortControllers.add(controller);
		return () => {
			this.activeAbortControllers.delete(controller);
		};
	}

	async runSync(forceFull: boolean): Promise<void> {
		const lang = this.plugin.settings.uiLanguage;
		const controller = new AbortController();
		const untrack = this.trackAbortController(controller);

		try {
			const graphResult = await this.graphIndex.sync(forceFull);
			const embProvider = createEmbeddingProvider(this.plugin.settings);

			const embResult = await this.vectorIndex.syncEmbeddings({
				nodes: this.graphIndex.getNodes(),
				provider: embProvider,
				signal: controller.signal,
				onProgress: (done, total) => {
					if (this.statusBarEl) {
						this.statusBarEl.setText(
							formatMessage(
								t(lang, 'statusBarEmbeddingProgress'),
								{ done, total },
							),
						);
					}
				},
			});

			this.updateStatusBar(this.graphIndex.getDirtyCount());

			if (embResult.error) {
				new Notice(
					formatMessage(t(lang, 'syncEmbeddingsWarningNotice'), {
						error: embResult.error,
					}),
				);
			} else {
				new Notice(
					formatMessage(t(lang, 'syncCompletedWithVectorsNotice'), {
						nodes: graphResult.totalNodes,
						edges: graphResult.totalEdges,
						vectors: embResult.updated,
					}),
				);
			}
		} catch (error) {
			const msg =
				error instanceof Error ? error.message : String(error);
			new Notice(
				formatMessage(t(lang, 'syncErrorNotice'), { error: msg }),
			);
		} finally {
			untrack();
		}
	}

	openStatsModal(): void {
		new GraphStatsModal(
			this.plugin.app,
			() => this.plugin.settings.uiLanguage,
			() => this.graphIndex.getStats(),
			() => this.runSync(false),
		).open();
	}

	openOnboardingModal(): void {
		new OnboardingWizardModal(
			this.plugin.app,
			this.plugin.settings,
			async (updatedSettings) => {
				this.plugin.settings = updatedSettings;
				await this.plugin.saveSettings();
				await this.runSync(true);
			},
		).open();
	}

	openPingModal(): void {
		new PingLlmModal(this.plugin.app, this.plugin).open();
	}

	openAnchorSearchModal(): void {
		const lang = this.plugin.settings.uiLanguage;
		new AnchorSearchModal({
			app: this.plugin.app,
			lang,
			nodes: this.graphIndex.getNodes(),
			events: this.eventManager.getEvents(),
			onSearch: (query, signal) =>
				this.vectorIndex.searchAnchors({
					query,
					nodes: this.graphIndex.getNodes(),
					topK: 5,
					provider: createEmbeddingProvider(this.plugin.settings),
					signal,
				}),
		}).open();
	}

	openNoteMetadataModal(targetFile?: TFile | null): void {
		const app = this.plugin.app;
		const file = targetFile ?? app.workspace.getActiveFile();
		const lang = this.plugin.settings.uiLanguage;

		if (!file || file.extension !== 'md') {
			new Notice(t(lang, 'parseSessionNoActiveFile'));
			return;
		}

		new NoteMetadataModal({
			app,
			file,
			settings: this.plugin.settings,
			stateOverride: this.eventManager.getEntityStateOverride(file.path),
			onSave: async (patch) => {
				try {
					const existingFm =
						app.metadataCache.getFileCache(file)?.frontmatter;
					const hasFmType = existingFm?.type !== undefined;
					const hasFmStatus =
						existingFm?.status !== undefined ||
						existingFm?.status_note !== undefined ||
						existingFm?.statusNote !== undefined;

					if (patch.status === undefined) {
						await this.eventManager.clearEntityStateOverride(
							file.path,
						);
					} else if (!hasFmStatus) {
						await this.eventManager.setEntityStateOverrides({
							[file.path]: {
								statusType: patch.status as StatusType,
								statusNote: patch.statusNote ?? '',
								updatedAt: Date.now(),
							},
						});
					}

					const shouldTouchFrontmatter =
						patch.type !== undefined ||
						hasFmType ||
						hasFmStatus;

					if (shouldTouchFrontmatter) {
						this.markSelfMetadataUpdate(file.path);
						await app.fileManager.processFrontMatter(
							file,
							(frontmatter: Record<string, unknown>) => {
								if (patch.type === undefined) {
									delete frontmatter.type;
								} else {
									frontmatter.type = patch.type;
								}
								if (hasFmStatus) {
									if (patch.status === undefined) {
										delete frontmatter.status;
									} else {
										frontmatter.status = patch.status;
									}
									if (patch.statusNote === undefined) {
										delete frontmatter.status_note;
										delete frontmatter.statusNote;
									} else {
										frontmatter.status_note =
											patch.statusNote;
									}
								}
							},
						);
					}

					const updatedNode = await this.graphIndex.refreshSingleFile(
						file,
						shouldTouchFrontmatter
							? {
									type: patch.type,
									status: hasFmStatus
										? patch.status
										: undefined,
									status_note: hasFmStatus
										? patch.statusNote
										: undefined,
								}
							: undefined,
					);

					new Notice(
						formatMessage(t(lang, 'noteBarSavedNotice'), {
							title: file.basename,
							type: updatedNode?.type ?? patch.type ?? 'UNTYPED',
							status:
								updatedNode?.staticState.statusType ??
								patch.status ??
								'UNKNOWN',
						}),
					);
				} catch (error) {
					this.pendingSelfMetadataUpdates.delete(file.path);
					const msg =
						error instanceof Error ? error.message : String(error);
					new Notice(
						formatMessage(t(lang, 'syncErrorNotice'), {
							error: msg,
						}),
					);
				}
			},
		}).open();
	}

	private async ensureCloudConsentIfNeeded(): Promise<boolean> {
		const settings = this.plugin.settings;
		if (settings.llmProvider === 'ollama' || settings.cloudConsentGiven) {
			return true;
		}

		return new Promise<boolean>((resolve) => {
			new CloudConsentModal(
				this.plugin.app,
				settings.uiLanguage,
				settings.llmProvider,
				(accepted) => {
					resolve(accepted);
				},
			).open();
		}).then(async (accepted) => {
			if (accepted) {
				this.plugin.settings.cloudConsentGiven = true;
				await this.plugin.saveSettings();
			}
			return accepted;
		});
	}

	private markSelfMetadataUpdate(filePath: string): void {
		this.pendingSelfMetadataUpdates.add(filePath);
		window.setTimeout(() => {
			this.pendingSelfMetadataUpdates.delete(filePath);
		}, 2000);
	}

	private async applyEventStateChangesToNotes(
		drafts: SessionEvent[],
	): Promise<void> {
		const nodes = this.graphIndex.getNodes();
		const updates: Record<string, PersistedEntityStateOverride> = {};
		const now = Date.now();

		for (const draft of drafts) {
			for (const sc of draft.stateChanges) {
				const subjectName = sc.subject.trim();
				if (!subjectName) {
					continue;
				}
				const match = matchEntityName(subjectName, nodes);
				if (match.id === null) {
					continue;
				}
				updates[match.id] = {
					statusType: sc.newStatusType,
					statusNote: sc.newStatusNote.trim(),
					updatedAt: now,
				};
			}
		}

		if (Object.keys(updates).length === 0) {
			return;
		}

		await this.eventManager.setEntityStateOverrides(updates);
		await this.graphIndex.applyEntityStateOverrides(updates);
	}

	isSessionNote(file?: TFile | null): boolean {
		if (!file || file.extension !== 'md') {
			return false;
		}
		return isPathInSessionFolder(
			file.path,
			this.plugin.settings.sessionFolder,
		);
	}

	async parseSessionFile(targetFile?: TFile | null): Promise<void> {
		const app = this.plugin.app;
		const lang = this.plugin.settings.uiLanguage;
		const file = targetFile ?? app.workspace.getActiveFile();

		if (!file || file.extension !== 'md') {
			new Notice(t(lang, 'parseSessionNoActiveFile'));
			return;
		}

		if (!this.isSessionNote(file)) {
			new Notice(t(lang, 'parseSessionNotInSessionFolder'));
			return;
		}

		const consentOk = await this.ensureCloudConsentIfNeeded();
		if (!consentOk) {
			new Notice(t(lang, 'llmErrorCloudConsent'));
			return;
		}

		const cache = app.metadataCache.getFileCache(file);
		const initialSessionId = determineSessionId({
			frontmatter: cache?.frontmatter,
			title: file.basename,
			sessionNumberPattern: this.plugin.settings.sessionNumberPattern,
			existingEvents: this.eventManager.getEvents(),
		});
		const nodes = this.graphIndex.getNodes();

		new SessionEventPreviewModal({
			app,
			lang,
			sourceNoteId: file.path,
			sessionId: initialSessionId,
			initialDrafts: [],
			nodes,
			runExtraction: async (modalSignal) => {
				const pluginController = new AbortController();
				const untrack = this.trackAbortController(pluginController);
				const onModalAbort = (): void => {
					pluginController.abort();
				};
				modalSignal.addEventListener('abort', onModalAbort, {
					once: true,
				});
				if (modalSignal.aborted) {
					pluginController.abort();
				}

				try {
					const currentNodes = this.graphIndex.getNodes();
					const llmProvider = createLlmProvider(this.plugin.settings);
					return await this.eventManager.extractSessionEventsFromFile(
						{
							file,
							nodes: currentNodes,
							llmProvider,
							settings: this.plugin.settings,
							signal: pluginController.signal,
						},
					);
				} finally {
					modalSignal.removeEventListener('abort', onModalAbort);
					untrack();
				}
			},
			onApply: async (sessionId, drafts) => {
				await this.eventManager.applySessionEventsForNote({
					sourceNoteId: file.path,
					sessionId,
					drafts,
					nodes: this.graphIndex.getNodes(),
				});
				await this.applyEventStateChangesToNotes(drafts);
			},
		}).open();
	}

	private updateStatusBar(dirtyCount: number): void {
		if (!this.statusBarEl) {
			return;
		}
		const lang = this.plugin.settings.uiLanguage;
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

	dispose(): void {
		for (const controller of this.activeAbortControllers) {
			controller.abort();
		}
		this.activeAbortControllers.clear();
		this.pendingSelfMetadataUpdates.clear();
		this.unsubscribeDirty?.();
		this.unsubscribeDirty = null;
		this.storage.close();
	}
}
