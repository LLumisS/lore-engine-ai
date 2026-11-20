import {
	getAllTags,
	parseFrontMatterAliases,
	type App,
	type CachedMetadata,
	type TFile,
} from 'obsidian';
import { isNoteIgnored, type LoreIgnoreRules } from '../config/loreIgnore';
import { resolveStaticState } from '../core/statusRules';
import { estimateTokens } from '../core/tokenizer';
import type {
	EntityType,
	GraphEdge,
	GraphNode,
	NoteSection,
	PluginSettings,
} from '../types';

const LONG_NOTE_WORD_THRESHOLD = 1000;

const FRONTMATTER_TYPE_ALIASES: Record<string, EntityType> = {
	npc: 'NPC',
	персонаж: 'NPC',
	ніп: 'NPC',
	нип: 'NPC',
	location: 'LOCATION',
	локація: 'LOCATION',
	локация: 'LOCATION',
	місце: 'LOCATION',
	место: 'LOCATION',
	faction: 'FACTION',
	фракція: 'FACTION',
	фракция: 'FACTION',
	організація: 'FACTION',
	организация: 'FACTION',
	quest: 'QUEST',
	квест: 'QUEST',
	завдання: 'QUEST',
	задание: 'QUEST',
	item: 'ITEM',
	предмет: 'ITEM',
	артефакт: 'ITEM',
	artifact: 'ITEM',
	session_log: 'SESSION_LOG',
	session: 'SESSION_LOG',
	сесія: 'SESSION_LOG',
	сессия: 'SESSION_LOG',
	lore: 'LORE',
	лор: 'LORE',
	meta: 'META',
	мета: 'META',
	index: 'META',
	індекс: 'META',
	индекс: 'META',
	untyped: 'UNTYPED',
};

function normalizeTag(rawTag: string): string {
	const cleaned = rawTag
		.trim()
		.replace(/[’ʼ`´]/g, "'")
		.replace(/ё/g, 'е')
		.toLowerCase();
	if (!cleaned) {
		return '';
	}
	return cleaned.startsWith('#') ? cleaned : `#${cleaned}`;
}

function normalizeFolderPrefix(rawPath: string): string {
	const cleaned = rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
	if (!cleaned) {
		return '';
	}
	return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
}

function normalizeFilePath(rawPath: string): string {
	return rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function sanitizeJsonValue(value: unknown): unknown {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => sanitizeJsonValue(item))
			.filter((item) => item !== undefined);
	}
	if (typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const sanitized = sanitizeJsonValue(v);
			if (sanitized !== undefined) {
				out[k] = sanitized;
			}
		}
		return out;
	}
	return undefined;
}

function extractPlainMetadata(
	frontmatter?: Record<string, unknown>,
): Record<string, unknown> {
	if (!frontmatter) {
		return {};
	}

	const metadata: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (key === 'position') {
			continue;
		}
		const sanitized = sanitizeJsonValue(value);
		if (sanitized !== undefined) {
			metadata[key] = sanitized;
		}
	}
	return metadata;
}

export function parseFrontmatterEntityType(
	frontmatter?: Record<string, unknown>,
): EntityType | null {
	const rawType = frontmatter?.type;
	if (typeof rawType === 'string' && rawType.trim().length > 0) {
		return FRONTMATTER_TYPE_ALIASES[rawType.trim().toLowerCase()] ?? null;
	}
	return null;
}

/**
 * Classifies a note's EntityType in order of precedence:
 * frontmatter `type:` -> user `typeMappings` -> `sessionFolder` -> `UNTYPED`.
 */
export function resolveEntityType(
	path: string,
	tags: string[],
	frontmatter: Record<string, unknown> | undefined,
	settings: PluginSettings,
): EntityType {
	const explicitType = parseFrontmatterEntityType(frontmatter);
	if (explicitType) {
		return explicitType;
	}

	const normPath = normalizeFilePath(path);
	const strippedTags = tags.map((tag) => tag.replace(/^#+/, '').toLowerCase());

	for (const mapping of settings.typeMappings) {
		if (mapping.kind === 'folder') {
			const folderPrefix = normalizeFolderPrefix(mapping.pattern);
			if (
				folderPrefix &&
				(normPath.startsWith(folderPrefix) ||
					normPath.includes(`/${folderPrefix}`))
			) {
				return mapping.type;
			}
		} else if (mapping.kind === 'tag') {
			const patternTag = mapping.pattern
				.trim()
				.replace(/^#+/, '')
				.toLowerCase();
			if (!patternTag) {
				continue;
			}
			for (const tag of strippedTags) {
				if (tag === patternTag || tag.startsWith(`${patternTag}/`)) {
					return mapping.type;
				}
			}
		}
	}

	const sessionPrefix = normalizeFolderPrefix(settings.sessionFolder);
	if (
		sessionPrefix &&
		(normPath.startsWith(sessionPrefix) ||
			normPath.includes(`/${sessionPrefix}`))
	) {
		return 'SESSION_LOG';
	}

	return 'UNTYPED';
}

/**
 * Splits notes longer than ~1000 words into `##` sections using Obsidian's
 * heading offsets (which ignore `##` inside fenced code blocks).
 */
export function splitNoteIntoSections(
	bodyText: string,
	rawText: string,
	cache: CachedMetadata | null,
	bodyStartOffset: number,
): NoteSection[] {
	const trimmedBody = bodyText.trim();
	if (!trimmedBody) {
		return [{ heading: '', content: '', tokenCount: 0 }];
	}

	const wordCount = trimmedBody.split(/\s+/).filter(Boolean).length;
	const h2Headings = (cache?.headings ?? [])
		.filter(
			(heading) =>
				heading.level === 2 &&
				heading.position.start.offset >= bodyStartOffset,
		)
		.sort((a, b) => a.position.start.offset - b.position.start.offset);

	if (wordCount <= LONG_NOTE_WORD_THRESHOLD || h2Headings.length === 0) {
		return [
			{
				heading: '',
				content: trimmedBody,
				tokenCount: estimateTokens(trimmedBody),
			},
		];
	}

	const sections: NoteSection[] = [];
	const firstHeading = h2Headings[0];
	if (firstHeading) {
		const intro = rawText
			.slice(bodyStartOffset, firstHeading.position.start.offset)
			.trim();
		if (intro.length > 0) {
			sections.push({
				heading: '',
				content: intro,
				tokenCount: estimateTokens(intro),
			});
		}
	}

	for (let i = 0; i < h2Headings.length; i++) {
		const current = h2Headings[i];
		if (!current) {
			continue;
		}
		const next = h2Headings[i + 1];
		const endOffset = next ? next.position.start.offset : rawText.length;
		const content = rawText
			.slice(current.position.start.offset, endOffset)
			.trim();
		if (content.length > 0) {
			sections.push({
				heading: current.heading.trim(),
				content,
				tokenCount: estimateTokens(content),
			});
		}
	}

	return sections.length > 0
		? sections
		: [
				{
					heading: '',
					content: trimmedBody,
					tokenCount: estimateTokens(trimmedBody),
				},
			];
}

function mergeFrontmatterOverrides(
	base: Record<string, unknown> | undefined,
	overrides?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (!overrides) {
		return base;
	}
	const merged: Record<string, unknown> = { ...(base ?? {}) };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) {
			delete merged[key];
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

/**
 * Parses a single Obsidian Markdown file into a GraphNode, or returns `null`
 * if excluded by `.loreignore` or `ai_ignore: true`.
 */
export async function parseVaultNote(
	app: App,
	file: TFile,
	settings: PluginSettings,
	ignoreRules: LoreIgnoreRules,
	frontmatterOverrides?: Record<string, unknown>,
): Promise<GraphNode | null> {
	const cache = app.metadataCache.getFileCache(file);
	const rawTags = cache ? getAllTags(cache) ?? [] : [];
	const normalizedTags = Array.from(
		new Set(rawTags.map(normalizeTag).filter((tag) => tag.length > 0)),
	);
	const baseFrontmatter: Record<string, unknown> | undefined =
		cache?.frontmatter;
	const frontmatter = mergeFrontmatterOverrides(
		baseFrontmatter,
		frontmatterOverrides,
	);

	if (
		isNoteIgnored(
			{
				path: file.path,
				tags: normalizedTags,
				frontmatter: frontmatter ?? null,
			},
			ignoreRules,
		)
	) {
		return null;
	}

	const rawText = await app.vault.cachedRead(file);
	const bodyStartOffset = cache?.frontmatterPosition?.end.offset ?? 0;
	const bodyText = rawText.slice(bodyStartOffset).trim();

	const aliases = Array.from(
		new Set(
			(parseFrontMatterAliases(frontmatter ?? null) ?? [])
				.map((alias) => alias.trim())
				.filter((alias) => alias.length > 0),
		),
	);

	const type = resolveEntityType(
		file.path,
		normalizedTags,
		frontmatter,
		settings,
	);
	const staticState = resolveStaticState(
		normalizedTags,
		frontmatter ?? null,
		settings.statusMappings,
	);
	const sections = splitNoteIntoSections(
		bodyText,
		rawText,
		cache,
		bodyStartOffset,
	);
	const tokenCount = estimateTokens(bodyText);

	return {
		id: file.path,
		title: file.basename,
		aliases,
		type,
		staticState,
		tags: normalizedTags,
		metadata: extractPlainMetadata(frontmatter),
		content: bodyText,
		sections,
		tokenCount,
		inDegree: 0,
		outDegree: 0,
		mtime: file.stat.mtime,
		isDirty: false,
	};
}

/**
 * Builds deduplicated directed GraphEdge[] across non-ignored nodes in `validNodeIds`.
 */
export function buildVaultEdges(
	app: App,
	validNodeIds: Set<string>,
): GraphEdge[] {
	const edges: GraphEdge[] = [];
	const seen = new Set<string>();

	const addEdge = (
		sourceId: string,
		targetId: string,
		kind: GraphEdge['kind'],
	): void => {
		if (
			sourceId === targetId ||
			!validNodeIds.has(sourceId) ||
			!validNodeIds.has(targetId)
		) {
			return;
		}
		const key = `${sourceId}|${targetId}|${kind}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		edges.push({ sourceId, targetId, kind });
	};

	const files = app.vault.getMarkdownFiles();
	for (const file of files) {
		if (!validNodeIds.has(file.path)) {
			continue;
		}

		const cache = app.metadataCache.getFileCache(file);

		for (const embed of cache?.embeds ?? []) {
			const dest = app.metadataCache.getFirstLinkpathDest(
				embed.link,
				file.path,
			);
			if (dest) {
				addEdge(file.path, dest.path, 'EMBED');
			}
		}

		for (const fmLink of cache?.frontmatterLinks ?? []) {
			const dest = app.metadataCache.getFirstLinkpathDest(
				fmLink.link,
				file.path,
			);
			if (dest) {
				addEdge(file.path, dest.path, 'FRONTMATTER');
			}
		}

		for (const link of cache?.links ?? []) {
			const dest = app.metadataCache.getFirstLinkpathDest(
				link.link,
				file.path,
			);
			if (dest) {
				addEdge(file.path, dest.path, 'LINK');
			}
		}

		const resolved = app.metadataCache.resolvedLinks[file.path];
		if (resolved) {
			for (const targetPath of Object.keys(resolved)) {
				const hasTypedEdge =
					seen.has(`${file.path}|${targetPath}|LINK`) ||
					seen.has(`${file.path}|${targetPath}|EMBED`) ||
					seen.has(`${file.path}|${targetPath}|FRONTMATTER`);
				if (!hasTypedEdge) {
					addEdge(file.path, targetPath, 'LINK');
				}
			}
		}
	}

	return edges;
}
