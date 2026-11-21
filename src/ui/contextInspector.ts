import { Modal, Notice, Setting, type App } from 'obsidian';
import { formatMessage, t } from '../i18n';
import type {
	AssembledContext,
	GraphNode,
	RetrievalMode,
	UiLanguage,
} from '../types';

const TOP_DISPLAY_CANDIDATES = 50;

const INSPECTOR_MODES: readonly Exclude<RetrievalMode, 'CUSTOM'>[] = [
	'AUTO',
	'PLOT_DEEP',
	'PLOT_LIGHT',
	'MECHANICS',
];

export interface ContextInspectorModalOptions {
	app: App;
	lang: UiLanguage;
	nodes: GraphNode[];
	initialResult?: AssembledContext | null;
	onAssemble: (
		query: string,
		mode: Exclude<RetrievalMode, 'CUSTOM'>,
		signal: AbortSignal,
	) => Promise<AssembledContext>;
}

export class ContextInspectorModal extends Modal {
	private readonly lang: UiLanguage;
	private readonly nodes: GraphNode[];
	private readonly onAssemble: ContextInspectorModalOptions['onAssemble'];

	private queryValue = '';
	private selectedMode: Exclude<RetrievalMode, 'CUSTOM'> = 'AUTO';
	private lastResult: AssembledContext | null = null;
	private showAllCandidates = false;
	private resultsEl: HTMLElement | null = null;
	private abortController: AbortController | null = null;

	constructor(options: ContextInspectorModalOptions) {
		super(options.app);
		this.lang = options.lang;
		this.nodes = options.nodes;
		this.lastResult = options.initialResult ?? null;
		this.queryValue = options.initialResult?.trace.query ?? '';
		this.onAssemble = options.onAssemble;
	}

	onOpen(): void {
		this.modalEl.addClass('lore-modal-wide');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lore-modal');

		new Setting(contentEl)
			.setName(t(this.lang, 'inspectorModalTitle'))
			.setHeading();

		if (this.nodes.length === 0) {
			contentEl.createDiv({
				cls: 'lore-ping-error lore-privacy-note',
				text: t(this.lang, 'inspectorEmptyGraphNotice'),
			});
		}

		new Setting(contentEl)
			.setName(t(this.lang, 'inspectorModeLabel'))
			.addDropdown((dropdown) => {
				for (const mode of INSPECTOR_MODES) {
					dropdown.addOption(mode, mode);
				}
				dropdown.setValue(this.selectedMode).onChange((value) => {
					this.selectedMode = value as Exclude<
						RetrievalMode,
						'CUSTOM'
					>;
				});
			});

		new Setting(contentEl)
			.addText((text) => {
				text.inputEl.addClass('lore-input-wide');
				text.setPlaceholder(t(this.lang, 'inspectorQueryPlaceholder'))
					.setValue(this.queryValue)
					.onChange((val) => {
						this.queryValue = val;
					});
				text.inputEl.addEventListener('keydown', (evt) => {
					if (evt.key === 'Enter') {
						evt.preventDefault();
						void this.runAssemble();
					}
				});
			})
			.addButton((btn) => {
				btn.setButtonText(t(this.lang, 'inspectorRunBtn'))
					.setCta()
					.onClick(() => {
						void this.runAssemble();
					});
			});

		this.resultsEl = contentEl.createDiv({ cls: 'lore-inspector-results' });
		if (this.lastResult) {
			this.renderResult(this.lastResult);
		}
	}

	private async runAssemble(): Promise<void> {
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

		const container = this.resultsEl;
		container.empty();
		container.createDiv({
			cls: 'setting-item-description',
			text: t(this.lang, 'inspectorRunningStatus'),
		});

		try {
			const assembled = await this.onAssemble(
				query,
				this.selectedMode,
				signal,
			);
			if (signal.aborted) {
				return;
			}
			this.lastResult = assembled;
			this.showAllCandidates = false;
			this.renderResult(assembled);
		} catch (error) {
			if (signal.aborted) {
				return;
			}
			container.empty();
			container.createDiv({
				cls: 'lore-ping-error lore-privacy-note',
				text: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private renderResult(result: AssembledContext): void {
		if (!this.resultsEl) {
			return;
		}
		const container = this.resultsEl;
		container.empty();

		const { trace, contextText } = result;

		new Setting(container)
			.setName(t(this.lang, 'inspectorSummaryLabel'))
			.setHeading();

		const summaryCard = container.createDiv({
			cls: 'lore-event-card lore-inspector-summary',
		});
		summaryCard.createDiv({
			text: formatMessage(t(this.lang, 'inspectorSummaryLine'), {
				mode: trace.resolvedMode,
				confidence: trace.intentConfidence.toFixed(2),
				total: trace.totalTokensUsed,
				budget: trace.tokenBudget,
				events: trace.eventsTokens,
				lore: trace.baseLoreTokens,
			}),
		});
		summaryCard.createDiv({
			cls: 'setting-item-description',
			text: formatMessage(t(this.lang, 'inspectorPreferredTypesLine'), {
				types:
					trace.preferredTypes.length > 0
						? trace.preferredTypes.join(', ')
						: '—',
				anchors: trace.anchorIds.length,
			}),
		});

		new Setting(container)
			.setName(
				formatMessage(t(this.lang, 'inspectorCandidatesTitle'), {
					count: trace.candidates.length,
				}),
			)
			.setHeading();

		if (trace.candidates.length === 0) {
			container.createDiv({
				cls: 'setting-item-description',
				text: t(this.lang, 'inspectorNoCandidates'),
			});
		} else {
			const visible = this.showAllCandidates
				? trace.candidates
				: trace.candidates.slice(0, TOP_DISPLAY_CANDIDATES);

			const listEl = container.createDiv({
				cls: 'lore-anchor-results',
			});

			for (const candidate of visible) {
				const card = listEl.createDiv({ cls: 'lore-event-card' });
				const headerRow = card.createDiv({
					cls: 'lore-event-card-header',
				});
				const statusNote = candidate.effectiveState.statusNote
					? ` — ${candidate.effectiveState.statusNote}`
					: '';
				headerRow.createEl('strong', {
					text: `${candidate.title} [${candidate.type}; ${candidate.effectiveState.statusType}${statusNote}]`,
				});
				headerRow.createSpan({
					cls: candidate.included
						? 'lore-badge lore-badge-success'
						: 'lore-badge lore-badge-warning',
					text: candidate.included
						? formatMessage(t(this.lang, 'inspectorIncludedBadge'), {
								reason: candidate.inclusionReason ?? 'anchor',
							})
						: formatMessage(t(this.lang, 'inspectorExcludedBadge'), {
								reason: candidate.exclusionReason ?? 'over_budget',
							}),
				});

				const b = candidate.scoreBreakdown;
				card.createDiv({
					cls: 'setting-item-description',
					text: formatMessage(t(this.lang, 'inspectorScoreLine'), {
						total: b.total.toFixed(3),
						sem: b.semantic.toFixed(2),
						prox: b.proximity.toFixed(2),
						type: b.typeBoost.toFixed(2),
						deg: b.degree.toFixed(2),
						rec: b.recency.toFixed(2),
						hop: candidate.hopDistance,
						tokens: candidate.tokenCount,
					}),
				});

				if (candidate.path.length > 0) {
					card.createDiv({
						cls: 'setting-item-description',
						text: formatMessage(t(this.lang, 'inspectorPathLine'), {
							path: candidate.path.join(' → '),
						}),
					});
				}

				if (
					candidate.includedSections &&
					candidate.includedSections.length > 0
				) {
					const sectionsLabel = candidate.includedSections
						.map((sec) => sec || '(intro)')
						.join(', ');
					card.createDiv({
						cls: 'setting-item-description',
						text: formatMessage(
							t(this.lang, 'inspectorSectionsLine'),
							{
								sections: sectionsLabel,
							},
						),
					});
				}
			}

			if (trace.candidates.length > TOP_DISPLAY_CANDIDATES) {
				const remaining =
					trace.candidates.length - TOP_DISPLAY_CANDIDATES;
				const toggleRow = container.createDiv({
					cls: 'lore-extraction-actions',
				});
				const toggleBtn = toggleRow.createEl('button', {
					type: 'button',
					text: this.showAllCandidates
						? t(this.lang, 'inspectorShowLessBtn')
						: formatMessage(t(this.lang, 'inspectorShowMoreBtn'), {
								count: remaining,
							}),
				});
				toggleBtn.addEventListener('click', () => {
					this.showAllCandidates = !this.showAllCandidates;
					this.renderResult(result);
				});
			}
		}

		new Setting(container)
			.setName(t(this.lang, 'inspectorContextOutputTitle'))
			.addButton((btn) => {
				btn.setButtonText(t(this.lang, 'inspectorCopyBtn')).onClick(
					() => {
						void navigator.clipboard
							.writeText(contextText)
							.then(() => {
								new Notice(
									t(this.lang, 'inspectorCopiedNotice'),
								);
							});
					},
				);
			})
			.setHeading();

		container.createEl('pre', {
			cls: 'lore-ping-output lore-inspector-context',
			text: contextText || t(this.lang, 'inspectorEmptyContext'),
		});
	}

	onClose(): void {
		this.abortController?.abort();
		this.abortController = null;
		this.contentEl.empty();
	}
}
