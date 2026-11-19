import {
	getAllTags,
	Modal,
	Notice,
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
	'SESSION_LOG',
	'LORE',
	'META',
	'UNTYPED',
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
	terminatedTags: string[];
	inactiveTags: string[];
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
 * entity type rules, and status tags.
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

	const tagCounts = new Map<string, number>();
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
			tagCounts.set(normTag, (tagCounts.get(normTag) ?? 0) + 1);
		}
	}

	const terminatedSet = new Set(baseSettings.statusMappings.terminatedTags);
	const inactiveSet = new Set(baseSettings.statusMappings.inactiveTags);

	const sortedTags = Array.from(tagCounts.entries()).sort(
		(a, b) => b[1] - a[1],
	);

	for (const [tag] of sortedTags.slice(0, 60)) {
		const entityType = matchTagToEntityType(tag);
		if (entityType) {
			mappingsMap.set(`tag:${tag}`, {
				kind: 'tag',
				pattern: tag,
				type: entityType,
			});
		}

		const status = matchStatusFromTagOrText(tag);
		if (status === 'TERMINATED') {
			terminatedSet.add(tag);
		} else if (status === 'INACTIVE') {
			inactiveSet.add(tag);
		}
	}

	return {
		sessionFolder: detectedSessionFolder,
		typeMappings: Array.from(mappingsMap.values()),
		terminatedTags: Array.from(terminatedSet),
		inactiveTags: Array.from(inactiveSet),
	};
}

function serializeTypeMappings(mappings: TypeMapping[]): string {
	return mappings
		.map((m) => `${m.kind}:${m.pattern}=${m.type}`)
		.join('\n');
}

function parseTypeMappingsText(raw: string): TypeMapping[] {
	const results: TypeMapping[] = [];
	for (const rawLine of raw.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}

		const colonIdx = line.indexOf(':');
		const eqIdx = line.lastIndexOf('=');
		if (colonIdx <= 0 || eqIdx <= colonIdx + 1) {
			continue;
		}

		const rawKind = line.slice(0, colonIdx).trim().toLowerCase();
		const pattern = line.slice(colonIdx + 1, eqIdx).trim();
		const rawType = line.slice(eqIdx + 1).trim().toUpperCase();

		if (rawKind !== 'folder' && rawKind !== 'tag') {
			continue;
		}
		if (!pattern) {
			continue;
		}
		if (!VALID_ENTITY_TYPES.includes(rawType as EntityType)) {
			continue;
		}

		results.push({
			kind: rawKind,
			pattern,
			type: rawType as EntityType,
		});
	}
	return results;
}

function parseTagCsv(raw: string): string[] {
	return Array.from(
		new Set(
			raw
				.split(',')
				.map((part) => part.trim())
				.filter((part) => part.length > 0),
		),
	);
}

export class OnboardingWizardModal extends Modal {
	private settings: PluginSettings;
	private onConfirm: (updated: PluginSettings) => Promise<void>;

	private sessionFolderValue: string;
	private typeMappingsText: string;
	private terminatedTagsText: string;
	private inactiveTagsText: string;

	constructor(
		app: App,
		settings: PluginSettings,
		onConfirm: (updated: PluginSettings) => Promise<void>,
	) {
		super(app);
		this.settings = settings;
		this.onConfirm = onConfirm;
		this.sessionFolderValue = settings.sessionFolder;
		this.typeMappingsText = serializeTypeMappings(settings.typeMappings);
		this.terminatedTagsText =
			settings.statusMappings.terminatedTags.join(', ');
		this.inactiveTagsText = settings.statusMappings.inactiveTags.join(', ');
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		const lang = this.settings.uiLanguage;

		contentEl.empty();
		contentEl.addClass('lore-modal');

		new Setting(contentEl)
			.setName(t(lang, 'onboardingTitle'))
			.setDesc(t(lang, 'onboardingSubtitle'))
			.setHeading();

		new Setting(contentEl).addButton((btn) => {
			btn.setButtonText(t(lang, 'onboardingAutoDetectBtn')).onClick(() => {
				const detected = detectVaultStructure(this.app, this.settings);
				this.sessionFolderValue = detected.sessionFolder;
				this.typeMappingsText = serializeTypeMappings(
					detected.typeMappings,
				);
				this.terminatedTagsText = detected.terminatedTags.join(', ');
				this.inactiveTagsText = detected.inactiveTags.join(', ');
				new Notice(t(lang, 'onboardingAutoDetectedNotice'));
				this.render();
			});
		});

		new Setting(contentEl)
			.setName(t(lang, 'onboardingSessionFolderName'))
			.setDesc(t(lang, 'onboardingSessionFolderDesc'))
			.addText((text) => {
				text.setValue(this.sessionFolderValue).onChange((val) => {
					this.sessionFolderValue = val;
				});
			});

		new Setting(contentEl)
			.setName(t(lang, 'onboardingTypeMappingsName'))
			.setDesc(t(lang, 'onboardingTypeMappingsDesc'))
			.addTextArea((area) => {
				area.inputEl.addClass('lore-textarea');
				area.inputEl.rows = 7;
				area.setValue(this.typeMappingsText).onChange((val) => {
					this.typeMappingsText = val;
				});
			});

		new Setting(contentEl)
			.setName(t(lang, 'onboardingTerminatedTagsName'))
			.setDesc(t(lang, 'onboardingTerminatedTagsDesc'))
			.addText((text) => {
				text.setValue(this.terminatedTagsText).onChange((val) => {
					this.terminatedTagsText = val;
				});
			});

		new Setting(contentEl)
			.setName(t(lang, 'onboardingInactiveTagsName'))
			.setDesc(t(lang, 'onboardingInactiveTagsDesc'))
			.addText((text) => {
				text.setValue(this.inactiveTagsText).onChange((val) => {
					this.inactiveTagsText = val;
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
				btn.setButtonText(t(lang, 'onboardingSaveButton'))
					.setCta()
					.onClick(() => {
						void this.handleSave();
					});
			});
	}

	private async handleSave(): Promise<void> {
		const updated: PluginSettings = {
			...this.settings,
			sessionFolder: this.sessionFolderValue.trim(),
			typeMappings: parseTypeMappingsText(this.typeMappingsText),
			statusMappings: {
				terminatedTags: parseTagCsv(this.terminatedTagsText),
				inactiveTags: parseTagCsv(this.inactiveTagsText),
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
