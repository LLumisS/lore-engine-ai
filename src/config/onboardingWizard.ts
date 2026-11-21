import {
	AbstractInputSuggest,
	getAllTags,
	Modal,
	Notice,
	setIcon,
	Setting,
	TFolder,
	type App,
} from 'obsidian';
import { matchStatusFromTagOrText } from '../core/statusRules';
import { t } from '../i18n';
import type {
	EntityType,
	GraphEdge,
	GraphStats,
	PluginSettings,
	StatusType,
	TypeMapping,
} from '../types';

const VALID_ENTITY_TYPES: readonly EntityType[] = [
	'NPC',
	'LOCATION',
	'FACTION',
	'QUEST',
	'ITEM',
	'MONSTER',
	'SESSION_LOG',
	'LORE',
	'META',
	'UNTYPED',
];

const ASSIGNABLE_RULE_TYPES: readonly EntityType[] = [
	'NPC',
	'LOCATION',
	'FACTION',
	'QUEST',
	'ITEM',
	'MONSTER',
	'SESSION_LOG',
	'LORE',
	'META',
];

const VALID_STATUS_TYPES: readonly StatusType[] = [
	'ACTIVE',
	'INACTIVE',
	'TERMINATED',
	'UNKNOWN',
];

const EDGE_KINDS: readonly GraphEdge['kind'][] = [
	'LINK',
	'EMBED',
	'FRONTMATTER',
];

export interface DetectedVaultStructure {
	sessionFolder: string;
	typeMappings: TypeMapping[];
	activeTags: string[];
	inactiveTags: string[];
	terminatedTags: string[];
}

export function collectVaultFolders(app: App): string[] {
	const folders: string[] = [];
	for (const item of app.vault.getAllLoadedFiles()) {
		if (!(item instanceof TFolder) || item.path === '/') {
			continue;
		}
		if (item.path.startsWith('.')) {
			continue;
		}
		folders.push(item.path);
	}
	return folders.sort((a, b) => a.localeCompare(b));
}

export function collectVaultTagsAndSegments(app: App): {
	fullTags: string[];
	segments: string[];
} {
	const fullCounts = new Map<string, number>();
	const segmentCounts = new Map<string, number>();

	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		if (!cache) {
			continue;
		}
		for (const rawTag of getAllTags(cache) ?? []) {
			const normTag = rawTag.trim().toLowerCase();
			if (!normTag) {
				continue;
			}
			fullCounts.set(normTag, (fullCounts.get(normTag) ?? 0) + 1);

			const parts = normTag
				.replace(/^#+/, '')
				.split('/')
				.filter((part) => part.length > 0);
			const leaf = parts[parts.length - 1];
			if (leaf) {
				segmentCounts.set(leaf, (segmentCounts.get(leaf) ?? 0) + 1);
			}
		}
	}

	const sortByFreq = (map: Map<string, number>): string[] =>
		Array.from(map.entries())
			.sort((a, b) => {
				if (b[1] !== a[1]) {
					return b[1] - a[1];
				}
				return a[0].localeCompare(b[0]);
			})
			.map(([key]) => key);

	return {
		fullTags: sortByFreq(fullCounts),
		segments: sortByFreq(segmentCounts),
	};
}

class StringListSuggest extends AbstractInputSuggest<string> {
	private readonly getItems: () => string[];
	private readonly onPick: (value: string) => void;

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		getItems: () => string[],
		onPick: (value: string) => void,
	) {
		super(app, inputEl);
		this.getItems = getItems;
		this.onPick = onPick;
		this.limit = 40;
	}

	protected getSuggestions(query: string): string[] {
		const items = this.getItems();
		const q = query.trim().toLowerCase();
		if (!q) {
			return items.slice(0, 40);
		}

		const prefixMatches: string[] = [];
		const substringMatches: string[] = [];

		for (const item of items) {
			const lower = item.toLowerCase();
			if (lower.startsWith(q)) {
				prefixMatches.push(item);
			} else if (lower.includes(q)) {
				substringMatches.push(item);
			}
		}

		return [...prefixMatches, ...substringMatches].slice(0, 40);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string, _evt: MouseEvent | KeyboardEvent): void {
		this.setValue(value);
		this.onPick(value);
		this.close();
	}
}

export class FolderExplorerModal extends Modal {
	private readonly lang: PluginSettings['uiLanguage'];
	private readonly folders: string[];
	private readonly onPick: (folderPath: string) => void;
	private filterQuery = '';
	private listEl: HTMLElement | null = null;

	constructor(
		app: App,
		lang: PluginSettings['uiLanguage'],
		onPick: (folderPath: string) => void,
	) {
		super(app);
		this.lang = lang;
		this.folders = collectVaultFolders(app);
		this.onPick = onPick;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lore-modal');

		new Setting(contentEl)
			.setName(t(this.lang, 'folderPickerModalTitle'))
			.setHeading();

		const searchInput = contentEl.createEl('input', {
			cls: 'lore-folder-search',
			type: 'text',
			placeholder: t(this.lang, 'folderPickerSearchPlaceholder'),
		});
		searchInput.addEventListener('input', () => {
			this.filterQuery = searchInput.value.trim().toLowerCase();
			this.renderFolders();
		});

		this.listEl = contentEl.createDiv({ cls: 'lore-folder-tree' });
		this.renderFolders();
		searchInput.focus();
	}

	private renderFolders(): void {
		if (!this.listEl) {
			return;
		}
		this.listEl.empty();

		const visible = this.filterQuery
			? this.folders.filter((folder) =>
					folder.toLowerCase().includes(this.filterQuery),
				)
			: this.folders;

		if (visible.length === 0) {
			this.listEl.createDiv({
				cls: 'lore-muted',
				text: t(this.lang, 'folderPickerEmpty'),
			});
			return;
		}

		for (const folderPath of visible) {
			const parts = folderPath.split('/');
			const depth = Math.max(0, parts.length - 1);
			const rowBtn = this.listEl.createEl('button', {
				cls: 'lore-folder-item',
				type: 'button',
			});
			rowBtn.style.paddingLeft = `${10 + depth * 18}px`;

			const displayName = parts[parts.length - 1] ?? folderPath;
			rowBtn.createSpan({ text: `📁 ${displayName}` });
			if (depth > 0) {
				rowBtn.createSpan({
					cls: 'lore-muted lore-folder-fullpath',
					text: folderPath,
				});
			}

			rowBtn.addEventListener('click', () => {
				this.onPick(folderPath);
				this.close();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function matchFolderToEntityType(folderNameLower: string): EntityType | null {
	if (
		folderNameLower.includes('npc') ||
		folderNameLower.includes('персонаж') ||
		folderNameLower.includes('ніп') ||
		folderNameLower.includes('нип') ||
		folderNameLower.includes('character')
	) {
		return 'NPC';
	}
	if (
		folderNameLower.includes('location') ||
		folderNameLower.includes('локац') ||
		folderNameLower.includes('місц') ||
		folderNameLower.includes('мест') ||
		folderNameLower.includes('world')
	) {
		return 'LOCATION';
	}
	if (
		folderNameLower.includes('quest') ||
		folderNameLower.includes('квест') ||
		folderNameLower.includes('завдан') ||
		folderNameLower.includes('задан')
	) {
		return 'QUEST';
	}
	if (
		folderNameLower.includes('faction') ||
		folderNameLower.includes('фракц') ||
		folderNameLower.includes('орган') ||
		folderNameLower.includes('guild') ||
		folderNameLower.includes('гільд') ||
		folderNameLower.includes('гильд')
	) {
		return 'FACTION';
	}
	if (
		folderNameLower.includes('item') ||
		folderNameLower.includes('предмет') ||
		folderNameLower.includes('артефакт') ||
		folderNameLower.includes('artifact')
	) {
		return 'ITEM';
	}
	if (
		folderNameLower.includes('monster') ||
		folderNameLower.includes('монстр') ||
		folderNameLower.includes('bestiar') ||
		folderNameLower.includes('бестіар') ||
		folderNameLower.includes('бестиар') ||
		folderNameLower.includes('statblock') ||
		folderNameLower.includes('статблок') ||
		folderNameLower.includes('creature') ||
		folderNameLower.includes('істот') ||
		folderNameLower.includes('существ')
	) {
		return 'MONSTER';
	}
	if (
		folderNameLower.includes('lore') ||
		folderNameLower.includes('лор') ||
		folderNameLower.includes('істор') ||
		folderNameLower.includes('истор')
	) {
		return 'LORE';
	}
	if (
		folderNameLower.includes('meta') ||
		folderNameLower.includes('індекс') ||
		folderNameLower.includes('индекс')
	) {
		return 'META';
	}
	return null;
}

function matchTagToEntityType(tagLower: string): EntityType | null {
	const root = tagLower.replace(/^#+/, '').split('/')[0] ?? '';
	return matchFolderToEntityType(root);
}

/**
 * Inspects vault folders and most frequent tags to suggest session folder,
 * entity type rules, and short status tag segments.
 */
export function detectVaultStructure(
	app: App,
	baseSettings: PluginSettings,
): DetectedVaultStructure {
	let detectedSessionFolder = baseSettings.sessionFolder;
	const mappingsMap = new Map<string, TypeMapping>();

	for (const existing of baseSettings.typeMappings) {
		const key = `${existing.kind}:${existing.pattern.toLowerCase()}`;
		mappingsMap.set(key, { ...existing });
	}

	for (const item of app.vault.getAllLoadedFiles()) {
		if (!(item instanceof TFolder) || item.path === '/') {
			continue;
		}
		if (item.path.startsWith('.')) {
			continue;
		}

		const lowerName = item.name.toLowerCase();
		if (
			lowerName.includes('session') ||
			lowerName.includes('сесі') ||
			lowerName.includes('сесси') ||
			lowerName.includes('хронік') ||
			lowerName.includes('хроник')
		) {
			detectedSessionFolder = item.path;
			const pattern = item.path.endsWith('/') ? item.path : `${item.path}/`;
			mappingsMap.set(`folder:${pattern.toLowerCase()}`, {
				kind: 'folder',
				pattern,
				type: 'SESSION_LOG',
			});
			continue;
		}

		const entityType = matchFolderToEntityType(lowerName);
		if (entityType) {
			const pattern = item.path.endsWith('/') ? item.path : `${item.path}/`;
			mappingsMap.set(`folder:${pattern.toLowerCase()}`, {
				kind: 'folder',
				pattern,
				type: entityType,
			});
		}
	}

	const { fullTags } = collectVaultTagsAndSegments(app);
	const activeSet = new Set(baseSettings.statusMappings.activeTags);
	const inactiveSet = new Set(baseSettings.statusMappings.inactiveTags);
	const terminatedSet = new Set(baseSettings.statusMappings.terminatedTags);

	for (const tag of fullTags.slice(0, 80)) {
		const entityType = matchTagToEntityType(tag);
		if (entityType) {
			mappingsMap.set(`tag:${tag}`, {
				kind: 'tag',
				pattern: tag,
				type: entityType,
			});
		}

		const status = matchStatusFromTagOrText(tag);
		const parts = tag
			.replace(/^#+/, '')
			.split('/')
			.filter((part) => part.length > 0);
		const leaf = parts[parts.length - 1];
		if (!leaf) {
			continue;
		}

		if (status === 'TERMINATED') {
			terminatedSet.add(leaf);
		} else if (status === 'INACTIVE') {
			inactiveSet.add(leaf);
		} else if (status === 'ACTIVE') {
			activeSet.add(leaf);
		}
	}

	return {
		sessionFolder: detectedSessionFolder,
		typeMappings: Array.from(mappingsMap.values()),
		activeTags: Array.from(activeSet),
		inactiveTags: Array.from(inactiveSet),
		terminatedTags: Array.from(terminatedSet),
	};
}

function addInfoIcon(setting: Setting, tooltipText: string): void {
	const iconEl = setting.nameEl.createSpan({
		cls: 'lore-info-icon',
		attr: {
			'aria-label': tooltipText,
		},
	});
	setIcon(iconEl, 'info');
}

export class OnboardingWizardModal extends Modal {
	private settings: PluginSettings;
	private onConfirm: (updated: PluginSettings) => Promise<void>;

	private sessionFolderValue: string;
	private rules: TypeMapping[];
	private activeTags: string[];
	private inactiveTags: string[];
	private terminatedTags: string[];

	private vaultFolders: string[] = [];
	private vaultFullTags: string[] = [];
	private vaultTagSegments: string[] = [];

	private rulesContainerEl: HTMLElement | null = null;
	private sessionInputEl: HTMLInputElement | null = null;

	constructor(
		app: App,
		settings: PluginSettings,
		onConfirm: (updated: PluginSettings) => Promise<void>,
	) {
		super(app);
		this.settings = settings;
		this.onConfirm = onConfirm;
		this.sessionFolderValue = settings.sessionFolder;
		this.rules = settings.typeMappings.map((m) => ({ ...m }));
		this.activeTags = [...settings.statusMappings.activeTags];
		this.inactiveTags = [...settings.statusMappings.inactiveTags];
		this.terminatedTags = [...settings.statusMappings.terminatedTags];
	}

	onOpen(): void {
		this.modalEl.addClass('lore-modal-wide');
		this.refreshSuggestionsCache();
		this.render();
	}

	private refreshSuggestionsCache(): void {
		this.vaultFolders = collectVaultFolders(this.app);
		const tagData = collectVaultTagsAndSegments(this.app);
		this.vaultFullTags = tagData.fullTags;
		this.vaultTagSegments = tagData.segments;
	}

	private render(): void {
		const { contentEl } = this;
		const lang = this.settings.uiLanguage;

		contentEl.empty();
		contentEl.addClass('lore-modal');

		const titleSetting = new Setting(contentEl)
			.setName(t(lang, 'onboardingTitle'))
			.setHeading();
		addInfoIcon(titleSetting, t(lang, 'onboardingSubtitle'));

		new Setting(contentEl).addButton((btn) => {
			btn.setButtonText(t(lang, 'onboardingAutoDetectBtn')).onClick(() => {
				this.refreshSuggestionsCache();
				const detected = detectVaultStructure(this.app, this.settings);
				this.sessionFolderValue = detected.sessionFolder;
				this.rules = detected.typeMappings.map((m) => ({ ...m }));
				this.activeTags = detected.activeTags;
				this.inactiveTags = detected.inactiveTags;
				this.terminatedTags = detected.terminatedTags;
				new Notice(t(lang, 'onboardingAutoDetectedNotice'));
				this.render();
			});
		});

		const sessionSetting = new Setting(contentEl)
			.setName(t(lang, 'onboardingSessionFolderName'))
			.addText((text) => {
				this.sessionInputEl = text.inputEl;
				text.inputEl.addClass('lore-input-wide');
				text.setValue(this.sessionFolderValue).onChange((val) => {
					this.sessionFolderValue = val;
				});
				new StringListSuggest(
					this.app,
					text.inputEl,
					() => this.vaultFolders,
					(picked) => {
						this.sessionFolderValue = picked;
					},
				);
			})
			.addButton((btn) => {
				btn.setButtonText(t(lang, 'onboardingBrowseFolderBtn')).onClick(
					() => {
						new FolderExplorerModal(this.app, lang, (picked) => {
							this.sessionFolderValue = picked;
							if (this.sessionInputEl) {
								this.sessionInputEl.value = picked;
							}
						}).open();
					},
				);
			});
		addInfoIcon(sessionSetting, t(lang, 'onboardingSessionFolderDesc'));

		const rulesSetting = new Setting(contentEl)
			.setName(t(lang, 'onboardingTypeMappingsName'))
			.addButton((btn) => {
				btn.setButtonText(t(lang, 'onboardingAddRuleBtn')).onClick(
					() => {
						this.rules.push({
							kind: 'folder',
							pattern: '',
							type: 'NPC',
						});
						this.renderRulesList();
					},
				);
			});
		addInfoIcon(rulesSetting, t(lang, 'onboardingTypeMappingsDesc'));

		this.rulesContainerEl = contentEl.createDiv({
			cls: 'lore-rules-list',
		});
		this.renderRulesList();

		this.renderStatusTagEditor(
			contentEl,
			t(lang, 'onboardingActiveTagsName'),
			t(lang, 'onboardingActiveTagsDesc'),
			() => this.activeTags,
			(next) => {
				this.activeTags = next;
			},
		);

		this.renderStatusTagEditor(
			contentEl,
			t(lang, 'onboardingInactiveTagsName'),
			t(lang, 'onboardingInactiveTagsDesc'),
			() => this.inactiveTags,
			(next) => {
				this.inactiveTags = next;
			},
		);

		this.renderStatusTagEditor(
			contentEl,
			t(lang, 'onboardingTerminatedTagsName'),
			t(lang, 'onboardingTerminatedTagsDesc'),
			() => this.terminatedTags,
			(next) => {
				this.terminatedTags = next;
			},
		);

		new Setting(contentEl)
			.addButton((btn) => {
				btn.setButtonText(t(lang, 'onboardingCancelButton')).onClick(
					() => {
						this.close();
					},
				);
			})
			.addButton((btn) => {
				btn.setButtonText(t(lang, 'onboardingSaveButton'))
					.setCta()
					.onClick(() => {
						void this.handleSave();
					});
			});
	}

	private renderRulesList(): void {
		if (!this.rulesContainerEl) {
			return;
		}
		const container = this.rulesContainerEl;
		const lang = this.settings.uiLanguage;
		container.empty();

		this.rules.forEach((rule, index) => {
			const row = container.createDiv({ cls: 'lore-rule-row' });

			const kindSelect = row.createEl('select', {
				cls: 'dropdown lore-rule-kind',
			});
			kindSelect.createEl('option', {
				value: 'folder',
				text: t(lang, 'onboardingRuleKindFolder'),
			});
			kindSelect.createEl('option', {
				value: 'tag',
				text: t(lang, 'onboardingRuleKindTag'),
			});
			kindSelect.value = rule.kind;

			const patternInput = row.createEl('input', {
				cls: 'lore-rule-pattern-input',
				type: 'text',
				value: rule.pattern,
				placeholder:
					rule.kind === 'folder'
						? t(lang, 'onboardingRuleFolderPlaceholder')
						: t(lang, 'onboardingRuleTagPlaceholder'),
			});

			new StringListSuggest(
				this.app,
				patternInput,
				() =>
					rule.kind === 'folder'
						? this.vaultFolders.map((folder) =>
								folder.endsWith('/') ? folder : `${folder}/`,
							)
						: this.vaultFullTags,
				(picked) => {
					rule.pattern = picked;
				},
			);

			patternInput.addEventListener('input', () => {
				rule.pattern = patternInput.value;
			});

			if (rule.kind === 'folder') {
				const browseBtn = row.createEl('button', {
					cls: 'lore-rule-browse-btn',
					type: 'button',
					text: '📁',
				});
				browseBtn.setAttribute(
					'aria-label',
					t(lang, 'onboardingBrowseFolderBtn'),
				);
				browseBtn.addEventListener('click', () => {
					new FolderExplorerModal(this.app, lang, (picked) => {
						const folderPattern = picked.endsWith('/')
							? picked
							: `${picked}/`;
						rule.pattern = folderPattern;
						patternInput.value = folderPattern;
					}).open();
				});
			}

			kindSelect.addEventListener('change', () => {
				rule.kind = kindSelect.value === 'tag' ? 'tag' : 'folder';
				rule.pattern = '';
				this.renderRulesList();
			});

			const typeSelect = row.createEl('select', {
				cls: 'dropdown lore-rule-type',
			});
			for (const entityType of ASSIGNABLE_RULE_TYPES) {
				typeSelect.createEl('option', {
					value: entityType,
					text: entityType,
				});
			}
			typeSelect.value = rule.type;
			typeSelect.addEventListener('change', () => {
				rule.type = typeSelect.value as EntityType;
			});

			const deleteBtn = row.createEl('button', {
				cls: 'lore-rule-delete-btn',
				type: 'button',
				text: '✕',
			});
			deleteBtn.setAttribute(
				'aria-label',
				t(lang, 'onboardingRuleDeleteBtn'),
			);
			deleteBtn.addEventListener('click', () => {
				this.rules.splice(index, 1);
				this.renderRulesList();
			});
		});
	}

	private getAvailableTagSegments(): string[] {
		const used = new Set(
			[
				...this.activeTags,
				...this.inactiveTags,
				...this.terminatedTags,
			].map((tag) => tag.toLowerCase()),
		);
		return this.vaultTagSegments.filter(
			(seg) => !used.has(seg.toLowerCase()),
		);
	}

	private renderStatusTagEditor(
		parent: HTMLElement,
		name: string,
		desc: string,
		getTags: () => string[],
		setTags: (next: string[]) => void,
	): void {
		const lang = this.settings.uiLanguage;
		const sectionEl = parent.createDiv({ cls: 'lore-status-editor' });

		const headerSetting = new Setting(sectionEl).setName(name);
		addInfoIcon(headerSetting, desc);

		const bodyEl = sectionEl.createDiv({ cls: 'lore-status-editor-body' });

		const renderBody = (): void => {
			bodyEl.empty();
			const tags = getTags();

			const chipsEl = bodyEl.createDiv({ cls: 'lore-chip-list' });
			tags.forEach((tag, idx) => {
				const chip = chipsEl.createSpan({ cls: 'lore-badge lore-chip' });
				chip.createSpan({ text: tag });
				const removeBtn = chip.createEl('button', {
					cls: 'lore-chip-remove',
					type: 'button',
					text: '✕',
				});
				removeBtn.addEventListener('click', () => {
					const updated = [...getTags()];
					updated.splice(idx, 1);
					setTags(updated);
					renderBody();
				});
			});

			const addRow = bodyEl.createDiv({ cls: 'lore-tag-add-row' });
			const input = addRow.createEl('input', {
				cls: 'lore-tag-add-input',
				type: 'text',
				placeholder: t(lang, 'onboardingTagInputPlaceholder'),
			});

			const addCurrentValue = (rawVal?: string): void => {
				const val = (rawVal ?? input.value).trim();
				if (!val) {
					return;
				}
				const current = getTags();
				if (!current.includes(val)) {
					setTags([...current, val]);
				}
				input.value = '';
				renderBody();
			};

			new StringListSuggest(
				this.app,
				input,
				() => this.getAvailableTagSegments(),
				(picked) => {
					addCurrentValue(picked);
				},
			);

			input.addEventListener('keydown', (evt) => {
				if (evt.key === 'Enter') {
					evt.preventDefault();
					addCurrentValue();
				}
			});

			const addBtn = addRow.createEl('button', {
				type: 'button',
				text: t(lang, 'onboardingAddTagBtn'),
			});
			addBtn.addEventListener('click', () => {
				addCurrentValue();
			});
		};

		renderBody();
	}

	private async handleSave(): Promise<void> {
		const cleanedRules = this.rules
			.map((r) => ({
				...r,
				pattern: r.pattern.trim(),
			}))
			.filter((r) => r.pattern.length > 0);

		const updated: PluginSettings = {
			...this.settings,
			sessionFolder: this.sessionFolderValue.trim(),
			typeMappings: cleanedRules,
			statusMappings: {
				activeTags: [...this.activeTags],
				inactiveTags: [...this.inactiveTags],
				terminatedTags: [...this.terminatedTags],
			},
			onboardingDone: true,
		};

		await this.onConfirm(updated);
		new Notice(t(this.settings.uiLanguage, 'onboardingSavedNotice'));
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class GraphStatsModal extends Modal {
	private getStats: () => GraphStats;
	private getLang: () => PluginSettings['uiLanguage'];
	private onSync: () => Promise<void>;

	constructor(
		app: App,
		getLang: () => PluginSettings['uiLanguage'],
		getStats: () => GraphStats,
		onSync: () => Promise<void>,
	) {
		super(app);
		this.getLang = getLang;
		this.getStats = getStats;
		this.onSync = onSync;
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		const lang = this.getLang();
		const stats = this.getStats();

		contentEl.empty();
		contentEl.addClass('lore-modal');

		new Setting(contentEl)
			.setName(t(lang, 'statsModalTitle'))
			.setHeading()
			.addButton((btn) => {
				btn.setButtonText(t(lang, 'statsSyncNowButton'))
					.setCta()
					.onClick(() => {
						void this.onSync().then(() => {
							this.render();
						});
					});
			});

		const grid = contentEl.createDiv({ cls: 'lore-stats-grid' });
		this.renderStatCard(
			grid,
			t(lang, 'statsTotalNodes'),
			String(stats.totalNodes),
		);
		this.renderStatCard(
			grid,
			t(lang, 'statsTotalEdges'),
			String(stats.totalEdges),
		);
		this.renderStatCard(
			grid,
			t(lang, 'statsDirtyNodes'),
			String(stats.dirtyNodes),
		);

		this.renderTableSection(
			contentEl,
			t(lang, 'statsByTypeHeading'),
			VALID_ENTITY_TYPES.map((type) => [type, stats.byType[type]]),
		);

		this.renderTableSection(
			contentEl,
			t(lang, 'statsByStatusHeading'),
			VALID_STATUS_TYPES.map((status) => [status, stats.byStatus[status]]),
		);

		this.renderTableSection(
			contentEl,
			t(lang, 'statsByEdgeKindHeading'),
			EDGE_KINDS.map((kind) => [kind, stats.edgesByKind[kind]]),
		);
	}

	private renderStatCard(
		parent: HTMLElement,
		label: string,
		value: string,
	): void {
		const card = parent.createDiv({ cls: 'lore-stat-card' });
		card.createDiv({ cls: 'lore-stat-value', text: value });
		card.createDiv({ cls: 'lore-muted', text: label });
	}

	private renderTableSection(
		parent: HTMLElement,
		heading: string,
		rows: Array<[string, number]>,
	): void {
		new Setting(parent).setName(heading).setHeading();
		const table = parent.createEl('table', { cls: 'lore-stats-table' });
		const tbody = table.createEl('tbody');

		for (const [label, count] of rows) {
			const tr = tbody.createEl('tr');
			tr.createEl('td', { text: label });
			tr.createEl('td', { cls: 'lore-stats-count', text: String(count) });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
