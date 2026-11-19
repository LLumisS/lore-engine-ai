export interface LoreIgnoreRules {
	folderPrefixes: string[];
	pathPatterns: string[];
	ignoredTags: string[];
}

export interface IgnoreCheckTarget {
	path: string;
	tags?: string[];
	frontmatter?: Record<string, unknown> | null;
}

export interface VaultTextReader {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
}

function normalizePathValue(rawPath: string): string {
	return rawPath
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.toLowerCase();
}

function normalizeIgnoreTag(rawTag: string): string {
	return rawTag.trim().replace(/^#+/, '').toLowerCase();
}

function escapeRegexChars(value: string): string {
	return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function matchesWildcardPattern(normalizedPath: string, pattern: string): boolean {
	if (!pattern.includes('*')) {
		return (
			normalizedPath === pattern ||
			normalizedPath.endsWith(`/${pattern}`)
		);
	}

	const escaped = escapeRegexChars(pattern).replace(/\*/g, '.*');
	const regex = new RegExp(`^${escaped}$`);
	return regex.test(normalizedPath);
}

/**
 * Parses `.loreignore` content into folder prefixes, path patterns, and ignored tags.
 * Empty lines and `# ...` comments (with space or lone `#`) are skipped.
 */
export function parseLoreIgnore(content: string): LoreIgnoreRules {
	const rules: LoreIgnoreRules = {
		folderPrefixes: [],
		pathPatterns: [],
		ignoredTags: [],
	};

	const lines = content.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		if (line === '#' || /^#\s/.test(line)) {
			continue;
		}

		if (line.toLowerCase().startsWith('tag:')) {
			const tag = normalizeIgnoreTag(line.slice(4));
			if (tag) {
				rules.ignoredTags.push(tag);
			}
			continue;
		}

		if (line.startsWith('#')) {
			const tag = normalizeIgnoreTag(line);
			if (tag) {
				rules.ignoredTags.push(tag);
			}
			continue;
		}

		const normalized = normalizePathValue(line);
		if (!normalized) {
			continue;
		}

		if (normalized.endsWith('/')) {
			rules.folderPrefixes.push(normalized);
		} else {
			rules.pathPatterns.push(normalized);
		}
	}

	return rules;
}

function collectCandidateTags(note: IgnoreCheckTarget): string[] {
	const tags: string[] = [];

	if (note.tags) {
		for (const tag of note.tags) {
			const norm = normalizeIgnoreTag(tag);
			if (norm) {
				tags.push(norm);
			}
		}
	}

	const fmTags = note.frontmatter?.tags;
	if (typeof fmTags === 'string') {
		for (const part of fmTags.split(/[,\s]+/)) {
			const norm = normalizeIgnoreTag(part);
			if (norm) {
				tags.push(norm);
			}
		}
	} else if (Array.isArray(fmTags)) {
		for (const item of fmTags) {
			if (typeof item === 'string') {
				const norm = normalizeIgnoreTag(item);
				if (norm) {
					tags.push(norm);
				}
			}
		}
	}

	return tags;
}

/**
 * Determines whether a note should be excluded from the graph via `ai_ignore` or `.loreignore`.
 */
export function isNoteIgnored(
	note: IgnoreCheckTarget,
	rules: LoreIgnoreRules,
): boolean {
	const aiIgnore = note.frontmatter?.ai_ignore;
	if (aiIgnore === true || aiIgnore === 'true') {
		return true;
	}

	const normPath = normalizePathValue(note.path);
	for (const prefix of rules.folderPrefixes) {
		if (
			normPath.startsWith(prefix) ||
			normPath.includes(`/${prefix}`)
		) {
			return true;
		}
	}

	for (const pattern of rules.pathPatterns) {
		if (matchesWildcardPattern(normPath, pattern)) {
			return true;
		}
	}

	if (rules.ignoredTags.length > 0) {
		const noteTags = collectCandidateTags(note);
		for (const noteTag of noteTags) {
			for (const ignoredTag of rules.ignoredTags) {
				if (
					noteTag === ignoredTag ||
					noteTag.startsWith(`${ignoredTag}/`)
				) {
					return true;
				}
			}
		}
	}

	return false;
}

export async function loadLoreIgnoreFromAdapter(
	adapter: VaultTextReader,
	filePath = '.loreignore',
): Promise<{ raw: string; rules: LoreIgnoreRules }> {
	const exists = await adapter.exists(filePath);
	if (!exists) {
		return {
			raw: '',
			rules: {
				folderPrefixes: [],
				pathPatterns: [],
				ignoredTags: [],
			},
		};
	}

	const raw = await adapter.read(filePath);
	return {
		raw,
		rules: parseLoreIgnore(raw),
	};
}
