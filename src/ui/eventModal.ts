import {
	getAllTags,
	Modal,
	Notice,
	Setting,
	type App,
	type ButtonComponent,
	type TextComponent,
	type TFile,
} from 'obsidian';
import type { HybridAnchorMatch } from '../core/bm25';
import { matchEntityName } from '../core/entityMatcher';
import { resolveEffectiveState } from '../core/stateResolver';
import { resolveStaticState } from '../core/statusRules';
import type { SessionExtractionOutcome } from '../engine/eventManager';
import {
	parseFrontmatterEntityType,
	resolveEntityType,
} from '../engine/vaultParser';
import type { AnchorSearchOutput } from '../engine/vectorIndex';
import { formatMessage, t } from '../i18n';
import type {
	EntityType,
	GraphNode,
	PluginSettings,
	SessionEvent,
	StatusType,
	UiLanguage,
} from '../types';

const STATUS_OPTIONS: readonly StatusType[] = [
	'ACTIVE',
	'INACTIVE',
	'TERMINATED',
	'UNKNOWN',
];

const ENTITY_TYPES: readonly EntityType[] = [
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

const AUTO_VALUE = '__AUTO__';

export interface SessionEventPreviewOptions {
	app: App;
	lang: UiLanguage;
	sourceNoteId: string;
	sessionId: number;
	initialDrafts: SessionEvent[];
	error?: string;
	rawOutput?: string;
	nodes: GraphNode[];
	runExtraction?: (signal: AbortSignal) => Promise<SessionExtractionOutcome>;
	onApply: (sessionId: number, drafts: SessionEvent[]) => Promise<void>;
}

function cloneSessionDrafts(drafts: SessionEvent[]): SessionEvent[] {
	return drafts.map((d) => ({
		...d,
		subjects: [...d.subjects],
		subjectIds: [...d.subjectIds],
		stateChanges: d.stateChanges.map((sc) => ({ ...sc })),
	}));
}

export class SessionEventPreviewModal extends Modal {
	private readonly lang: UiLanguage;
	private readonly sourceNoteId: string;
	private sessionId: number;
	private drafts: SessionEvent[];
	private error?: string;
	private rawOutput?: string;
	private readonly nodes: GraphNode[];
	private readonly runExtraction?: (
		signal: AbortSignal,
	) => Promise<SessionExtractionOutcome>;
	private readonly onApply: (
		sessionId: number,
		drafts: SessionEvent[],
	) => Promise<void>;

	private statusEl: HTMLElement | null = null;
	private feedbackEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private sessionIdInput: TextComponent | null = null;
	private saveBtn: ButtonComponent | null = null;
	private abortController: AbortController | null = null;
	private isExtracting = false;
	private isAborted = false;
	private isClosed = false;

	constructor(options: SessionEventPreviewOptions) {
		super(options.app);
		this.lang = options.lang;
		this.sourceNoteId = options.sourceNoteId;
		this.sessionId = options.sessionId;
		this.drafts = cloneSessionDrafts(options.initialDrafts);
		this.error = options.error;
		this.rawOutput = options.rawOutput;
		this.nodes = options.nodes;
		this.runExtraction = options.runExtraction;
		this.onApply = options.onApply;
	}

	onOpen(): void {
		this.isClosed = false;
		this.modalEl.addClass('lore-modal-wide');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lore-modal');

		new Setting(contentEl)
			.setName(t(this.lang, 'eventModalTitle'))
			.setDesc(this.sourceNoteId)
			.setHeading();

		this.statusEl = contentEl.createDiv({
			cls: 'lore-extraction-status-bar',
		});
		this.feedbackEl = contentEl.createDiv({
			cls: 'lore-extraction-feedback',
		});

		new Setting(contentEl)
			.setName(t(this.lang, 'eventModalSessionIdLabel'))
			.addText((text) => {
				this.sessionIdInput = text;
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.setValue(String(this.sessionId)).onChange((val) => {
					const parsed = Number.parseInt(val, 10);
					if (Number.isFinite(parsed) && parsed > 0) {
						this.sessionId = parsed;
					}
				});
			});

		this.listEl = contentEl.createDiv({ cls: 'lore-events-list' });

		new Setting(contentEl)
			.addButton((btn) => {
				btn.setButtonText(t(this.lang, 'eventModalAddEventBtn')).onClick(
					() => {
						this.drafts.push({
							id: `evt-manual-${Date.now()}-${this.drafts.length}`,
							sessionId: this.sessionId,
							sourceNoteId: this.sourceNoteId,
							subjects: [],
							subjectIds: [],
							action: '',
							details: '',
							stateChanges: [],
							userVerified: true,
							createdAt: Date.now(),
						});
						this.renderDrafts();
					},
				);
			})
			.addButton((btn) => {
				btn.setButtonText(t(this.lang, 'onboardingCancelButton')).onClick(
					() => {
						this.close();
					},
				);
			})
			.addButton((btn) => {
				this.saveBtn = btn;
				btn.setButtonText(t(this.lang, 'eventModalSaveBtn'))
					.setCta()
					.onClick(() => {
						void this.handleApply();
					});
			});

		this.renderStatusAndFeedback();
		this.renderDrafts();
		this.updateActionButtons();

		if (this.runExtraction) {
			void this.startExtraction();
		}
	}

	private updateActionButtons(): void {
		if (this.saveBtn) {
			this.saveBtn.setDisabled(this.isExtracting);
		}
	}

	private renderStatusAndFeedback(): void {
		if (!this.statusEl || !this.feedbackEl) {
			return;
		}
		this.statusEl.empty();
		this.feedbackEl.empty();

		if (this.isExtracting) {
			this.statusEl.show();
			const leftEl = this.statusEl.createDiv({
				cls: 'lore-extraction-status-left',
			});
			leftEl.createSpan({ cls: 'lore-spinner' });
			leftEl.createSpan({
				text: t(this.lang, 'eventModalExtractingStatus'),
			});

			const stopBtn = this.statusEl.createEl('button', {
				type: 'button',
				text: t(this.lang, 'eventModalAbortBtn'),
			});
			stopBtn.addEventListener('click', () => {
				this.abortController?.abort();
			});
			return;
		}

		if (this.isAborted) {
			this.statusEl.show();
			this.statusEl.createSpan({
				cls: 'setting-item-description',
				text: t(this.lang, 'eventModalAbortedStatus'),
			});
			if (this.runExtraction) {
				const retryBtn = this.statusEl.createEl('button', {
					type: 'button',
					text: t(this.lang, 'eventModalRetryBtn'),
				});
				retryBtn.addEventListener('click', () => {
					void this.startExtraction();
				});
			}
			return;
		}

		this.statusEl.hide();

		if (this.error) {
			this.feedbackEl.createDiv({
				cls: 'lore-ping-error lore-privacy-note',
				text: this.error,
			});
			if (this.runExtraction) {
				const actionsEl = this.feedbackEl.createDiv({
					cls: 'lore-extraction-actions',
				});
				const retryBtn = actionsEl.createEl('button', {
					cls: 'mod-cta',
					type: 'button',
					text: t(this.lang, 'eventModalRetryBtn'),
				});
				retryBtn.addEventListener('click', () => {
					void this.startExtraction();
				});
			}
		}

		if (this.rawOutput) {
			new Setting(this.feedbackEl)
				.setName(t(this.lang, 'eventModalRawOutputLabel'))
				.setHeading();
			this.feedbackEl.createEl('pre', {
				cls: 'lore-ping-output',
				text: this.rawOutput,
			});
		}
	}

	private async startExtraction(): Promise<void> {
		if (!this.runExtraction) {
			return;
		}
		this.abortController?.abort();
		const controller = new AbortController();
		this.abortController = controller;

		this.isExtracting = true;
		this.isAborted = false;
		this.error = undefined;
		this.rawOutput = undefined;
		this.renderStatusAndFeedback();
		this.updateActionButtons();

		try {
			const outcome = await this.runExtraction(controller.signal);
			if (this.isClosed || this.abortController !== controller) {
				return;
			}
			if (controller.signal.aborted || (!outcome.ok && outcome.aborted)) {
				this.isAborted = true;
			} else if (outcome.ok) {
				this.sessionId = outcome.sessionId;
				this.sessionIdInput?.setValue(String(this.sessionId));
				this.drafts = cloneSessionDrafts(outcome.drafts);
				this.error = undefined;
				this.rawOutput = undefined;
			} else {
				this.sessionId = outcome.sessionId;
				this.sessionIdInput?.setValue(String(this.sessionId));
				this.error = outcome.error;
				this.rawOutput = outcome.rawOutput;
			}
		} catch (error) {
			if (this.isClosed || this.abortController !== controller) {
				return;
			}
			if (controller.signal.aborted) {
				this.isAborted = true;
			} else {
				this.error =
					error instanceof Error ? error.message : String(error);
			}
		} finally {
			if (this.abortController === controller) {
				this.abortController = null;
				this.isExtracting = false;
				if (!this.isClosed) {
					this.renderStatusAndFeedback();
					this.renderDrafts();
					this.updateActionButtons();
				}
			}
		}
	}

	private renderDrafts(): void {
		if (!this.listEl) {
			return;
		}
		const container = this.listEl;
		container.empty();

		this.drafts.forEach((draft, draftIdx) => {
			const card = container.createDiv({ cls: 'lore-event-card' });

			const topRow = card.createDiv({ cls: 'lore-event-card-header' });
			const verifyLabel = topRow.createEl('label', {
				cls: 'lore-event-verify-label',
			});
			const verifyCheckbox = verifyLabel.createEl('input', {
				type: 'checkbox',
			});
			verifyCheckbox.checked = draft.userVerified;
			verifyCheckbox.addEventListener('change', () => {
				draft.userVerified = verifyCheckbox.checked;
			});
			verifyLabel.createSpan({
				text: t(this.lang, 'eventModalVerifiedLabel'),
			});

			const deleteEventBtn = topRow.createEl('button', {
				cls: 'lore-rule-delete-btn',
				type: 'button',
				text: '✕',
			});
			deleteEventBtn.addEventListener('click', () => {
				this.drafts.splice(draftIdx, 1);
				this.renderDrafts();
			});

			new Setting(card)
				.setName(t(this.lang, 'eventModalActionLabel'))
				.addText((text) => {
					text.setValue(draft.action).onChange((val) => {
						draft.action = val;
					});
				});

			new Setting(card)
				.setName(t(this.lang, 'eventModalDetailsLabel'))
				.addTextArea((area) => {
					area.inputEl.addClass('lore-textarea');
					area.inputEl.rows = 2;
					area.setValue(draft.details).onChange((val) => {
						draft.details = val;
					});
				});

			const badgesEl = card.createDiv({ cls: 'lore-chip-list' });
			const renderResolutionBadges = (): void => {
				badgesEl.empty();
				const names = Array.from(
					new Set(
						[
							...draft.subjects,
							...draft.stateChanges.map((sc) => sc.subject),
						]
							.map((s) => s.trim())
							.filter((s) => s.length > 0),
					),
				);

				for (const name of names) {
					const match = matchEntityName(name, this.nodes);
					if (match.id !== null) {
						const matchedNode = this.nodes.find(
							(n) => n.id === match.id,
						);
						badgesEl.createSpan({
							cls: 'lore-badge lore-badge-success',
							text: formatMessage(
								t(this.lang, 'eventModalResolvedBadge'),
								{ title: matchedNode?.title ?? match.id },
							),
						});
					} else if (match.ambiguous) {
						const candidateList = match.candidates
							.slice(0, 3)
							.map((c) => c.title)
							.join(', ');
						badgesEl.createSpan({
							cls: 'lore-badge lore-badge-warning',
							text: formatMessage(
								t(this.lang, 'eventModalAmbiguousBadge'),
								{ name, candidates: candidateList },
							),
						});
					} else {
						badgesEl.createSpan({
							cls: 'lore-badge lore-badge-warning',
							text: formatMessage(
								t(this.lang, 'eventModalUnresolvedBadge'),
								{ name },
							),
						});
					}
				}
			};

			new Setting(card)
				.setName(t(this.lang, 'eventModalSubjectsLabel'))
				.addText((text) => {
					text.inputEl.addClass('lore-input-wide');
					text.setValue(draft.subjects.join(', ')).onChange((val) => {
						draft.subjects = val
							.split(',')
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						renderResolutionBadges();
					});
				});

			card.appendChild(badgesEl);
			renderResolutionBadges();

			const scSection = card.createDiv({ cls: 'lore-state-changes' });
			new Setting(scSection)
				.setName(t(this.lang, 'eventModalStateChangesLabel'))
				.addButton((btn) => {
					btn.setButtonText(
						t(this.lang, 'eventModalAddStateChangeBtn'),
					).onClick(() => {
						draft.stateChanges.push({
							subject: draft.subjects[0] ?? '',
							newStatusType: 'ACTIVE',
							newStatusNote: '',
						});
						this.renderDrafts();
					});
				});

			draft.stateChanges.forEach((sc, scIdx) => {
				const scRow = scSection.createDiv({ cls: 'lore-rule-row' });

				const subjInput = scRow.createEl('input', {
					cls: 'lore-sc-subject-input',
					type: 'text',
					value: sc.subject,
					placeholder: t(this.lang, 'eventModalSubjectPlaceholder'),
				});
				subjInput.addEventListener('input', () => {
					sc.subject = subjInput.value;
					renderResolutionBadges();
				});

				const statusSelect = scRow.createEl('select', {
					cls: 'dropdown lore-rule-type',
				});
				for (const status of STATUS_OPTIONS) {
					statusSelect.createEl('option', {
						value: status,
						text: status,
					});
				}
				statusSelect.value = sc.newStatusType;
				statusSelect.addEventListener('change', () => {
					sc.newStatusType = statusSelect.value as StatusType;
				});

				const noteInput = scRow.createEl('input', {
					cls: 'lore-rule-pattern-input',
					type: 'text',
					value: sc.newStatusNote,
					placeholder: t(this.lang, 'eventModalStatusNotePlaceholder'),
				});
				noteInput.addEventListener('input', () => {
					sc.newStatusNote = noteInput.value;
				});

				const removeScBtn = scRow.createEl('button', {
					cls: 'lore-rule-delete-btn',
					type: 'button',
					text: '✕',
				});
				removeScBtn.addEventListener('click', () => {
					draft.stateChanges.splice(scIdx, 1);
					this.renderDrafts();
				});
			});
		});
	}

	private async handleApply(): Promise<void> {
		const cleaned = this.drafts
			.map((d) => ({
				...d,
				sessionId: this.sessionId,
				action: d.action.trim(),
				details: d.details.trim(),
				subjects: d.subjects
					.map((s) => s.trim())
					.filter((s) => s.length > 0),
				stateChanges: d.stateChanges
					.map((sc) => ({
						...sc,
						subject: sc.subject.trim(),
						newStatusNote: sc.newStatusNote.trim(),
					}))
					.filter((sc) => sc.subject.length > 0),
			}))
			.filter((d) => d.action.length > 0 || d.details.length > 0);

		await this.onApply(this.sessionId, cleaned);
		new Notice(
			formatMessage(t(this.lang, 'eventModalSavedNotice'), {
				count: cleaned.length,
				session: this.sessionId,
			}),
		);
		this.close();
	}

	onClose(): void {
		this.isClosed = true;
		this.abortController?.abort();
		this.abortController = null;
		this.contentEl.empty();
	}
}

export class AnchorSearchModal extends Modal {
	private readonly lang: UiLanguage;
	private readonly nodes: GraphNode[];
	private readonly events: SessionEvent[];
	private readonly onSearch: (
		query: string,
		signal: AbortSignal,
	) => Promise<AnchorSearchOutput>;
	private queryValue = '';
	private resultsEl: HTMLElement | null = null;
	private abortController: AbortController | null = null;

	constructor(options: {
		app: App;
		lang: UiLanguage;
		nodes: GraphNode[];
		events: SessionEvent[];
		onSearch: (
			query: string,
			signal: AbortSignal,
		) => Promise<AnchorSearchOutput>;
	}) {
		super(options.app);
		this.lang = options.lang;
		this.nodes = options.nodes;
		this.events = options.events;
		this.onSearch = options.onSearch;
	}

	onOpen(): void {
		this.modalEl.addClass('lore-modal-wide');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lore-modal');

		new Setting(contentEl)
			.setName(t(this.lang, 'anchorModalTitle'))
			.setHeading();

		new Setting(contentEl)
			.addText((text) => {
				text.inputEl.addClass('lore-input-wide');
				text.setPlaceholder(
					t(this.lang, 'anchorModalQueryPlaceholder'),
				).onChange((val) => {
					this.queryValue = val;
				});
				text.inputEl.addEventListener('keydown', (evt) => {
					if (evt.key === 'Enter') {
						evt.preventDefault();
						void this.executeSearch();
					}
				});
			})
			.addButton((btn) => {
				btn.setButtonText(t(this.lang, 'anchorModalSearchBtn'))
					.setCta()
					.onClick(() => {
						void this.executeSearch();
					});
			});

		this.resultsEl = contentEl.createDiv({ cls: 'lore-anchor-results' });
	}

	private async executeSearch(): Promise<void> {
		if (!this.resultsEl) {
			return;
		}
		const query = this.queryValue.trim();
		if (!query) {
			return;
		}

		this.abortController?.abort();
		this.abortController = new AbortController();
		const signal = this.abortController.signal;

		this.resultsEl.empty();
		const output = await this.onSearch(query, signal);
		if (signal.aborted || !this.resultsEl) {
			return;
		}

		const modeText = output.usedVectors
			? t(this.lang, 'anchorModalModeHybrid')
			: formatMessage(t(this.lang, 'anchorModalModeBm25'), {
					reason: output.fallbackReason ?? '-',
				});
		this.resultsEl.createDiv({
			cls: 'lore-badge lore-badge-accent',
			text: modeText,
		});

		if (output.results.length === 0) {
			this.resultsEl.createDiv({
				cls: 'lore-muted',
				text: t(this.lang, 'anchorModalEmpty'),
			});
			return;
		}

		const nodeById = new Map(this.nodes.map((n) => [n.id, n]));
		const table = this.resultsEl.createEl('table', {
			cls: 'lore-stats-table',
		});
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		headerRow.createEl('th', { text: '#' });
		headerRow.createEl('th', { text: 'Node' });
		headerRow.createEl('th', { text: 'Hybrid' });
		headerRow.createEl('th', { text: 'BM25' });
		headerRow.createEl('th', { text: 'Vector' });

		const tbody = table.createEl('tbody');
		output.results.forEach((match: HybridAnchorMatch, idx) => {
			const tr = tbody.createEl('tr');
			const node = nodeById.get(match.nodeId);
			const effState = node
				? resolveEffectiveState(node, this.events)
				: null;
			const label = node
				? `${node.title} [${node.type} / ${effState?.statusType ?? 'UNKNOWN'}]`
				: match.nodeId;

			tr.createEl('td', { text: String(idx + 1) });
			tr.createEl('td', { text: label });
			tr.createEl('td', {
				cls: 'lore-stats-count',
				text: match.score.toFixed(4),
			});
			tr.createEl('td', {
				cls: 'lore-stats-count',
				text: match.lexicalScore.toFixed(4),
			});
			tr.createEl('td', {
				cls: 'lore-stats-count',
				text: match.vectorScore.toFixed(4),
			});
		});
	}

	onClose(): void {
		this.abortController?.abort();
		this.abortController = null;
		this.contentEl.empty();
	}
}

export class NoteMetadataModal extends Modal {
	private readonly file: TFile;
	private readonly settings: PluginSettings;
	private readonly stateOverride?: {
		statusType: StatusType;
		statusNote: string;
	};
	private readonly onSave: (patch: {
		type?: string;
		status?: string;
		statusNote?: string;
	}) => Promise<void>;

	private selectedType = AUTO_VALUE;
	private selectedStatus = AUTO_VALUE;
	private statusNoteValue = '';

	constructor(options: {
		app: App;
		file: TFile;
		settings: PluginSettings;
		stateOverride?: { statusType: StatusType; statusNote: string };
		onSave: (patch: {
			type?: string;
			status?: string;
			statusNote?: string;
		}) => Promise<void>;
	}) {
		super(options.app);
		this.file = options.file;
		this.settings = options.settings;
		this.stateOverride = options.stateOverride;
		this.onSave = options.onSave;
	}

	onOpen(): void {
		const { contentEl } = this;
		const lang = this.settings.uiLanguage;
		contentEl.empty();
		contentEl.addClass('lore-modal');

		const cache = this.app.metadataCache.getFileCache(this.file);
		const frontmatter: Record<string, unknown> | undefined =
			cache?.frontmatter;
		const tags = cache ? getAllTags(cache) ?? [] : [];

		const autoType = resolveEntityType(
			this.file.path,
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
		const resolvedStatic = resolveStaticState(
			tags,
			frontmatter ?? null,
			this.settings.statusMappings,
		);
		const rawExplicitStatus =
			typeof frontmatter?.status === 'string'
				? (frontmatter.status.trim().toUpperCase() as StatusType)
				: null;
		const explicitStatus =
			rawExplicitStatus && STATUS_OPTIONS.includes(rawExplicitStatus)
				? rawExplicitStatus
				: null;

		this.selectedType = explicitType ?? AUTO_VALUE;
		if (this.stateOverride) {
			this.selectedStatus = this.stateOverride.statusType;
			this.statusNoteValue = this.stateOverride.statusNote;
		} else {
			this.selectedStatus = explicitStatus ?? AUTO_VALUE;
			this.statusNoteValue =
				typeof frontmatter?.status_note === 'string'
					? frontmatter.status_note
					: typeof frontmatter?.statusNote === 'string'
						? frontmatter.statusNote
						: resolvedStatic.statusNote;
		}

		new Setting(contentEl)
			.setName(
				formatMessage(t(lang, 'noteMetaModalTitle'), {
					title: this.file.basename,
				}),
			)
			.setHeading();

		new Setting(contentEl)
			.setName(t(lang, 'noteBarClassLabel'))
			.addDropdown((dropdown) => {
				dropdown.addOption(
					AUTO_VALUE,
					`${t(lang, 'noteBarAutoPrefix')} (${autoType})`,
				);
				for (const entityType of ENTITY_TYPES) {
					dropdown.addOption(entityType, entityType);
				}
				dropdown.setValue(this.selectedType).onChange((val) => {
					this.selectedType = val;
				});
			});

		new Setting(contentEl)
			.setName(t(lang, 'noteMetaStatusLabel'))
			.addDropdown((dropdown) => {
				dropdown.addOption(
					AUTO_VALUE,
					`${t(lang, 'noteBarAutoPrefix')} (${autoState.statusType})`,
				);
				for (const status of STATUS_OPTIONS) {
					dropdown.addOption(status, status);
				}
				dropdown.setValue(this.selectedStatus).onChange((val) => {
					this.selectedStatus = val;
				});
			});

		new Setting(contentEl)
			.setName(t(lang, 'noteBarNotePlaceholder'))
			.addText((text) => {
				text.setPlaceholder(t(lang, 'noteBarNotePlaceholder'))
					.setValue(this.statusNoteValue)
					.onChange((val) => {
						this.statusNoteValue = val;
					});
			});

		new Setting(contentEl)
			.addButton((btn) => {
				btn.setButtonText(t(lang, 'onboardingCancelButton')).onClick(
					() => {
						this.close();
					},
				);
			})
			.addButton((btn) => {
				btn.setButtonText(t(lang, 'noteMetaSaveBtn'))
					.setCta()
					.onClick(() => {
						void this.handleSave();
					});
			});
	}

	private async handleSave(): Promise<void> {
		await this.onSave({
			type:
				this.selectedType === AUTO_VALUE
					? undefined
					: this.selectedType,
			status:
				this.selectedStatus === AUTO_VALUE
					? undefined
					: this.selectedStatus,
			statusNote: this.statusNoteValue.trim() || undefined,
		});
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
