import type { EntityState, StatusMappings, StatusType } from '../types';

const TERMINATED_STEMS: readonly string[] = [
	'мертв',
	'помер',
	'помир',
	'умер',
	'загин',
	'погиб',
	'вбит',
	'убит',
	'страчен',
	'знищен',
	'уничтож',
	'зруйнов',
	'разруш',
	'спален',
	'завершен',
	'виконан',
	'провален',
	'dead',
	'kill',
	'destroy',
	'complet',
	'defeat',
	'fail',
];

const INACTIVE_STEMS: readonly string[] = [
	'зник',
	'пропал',
	'исчез',
	'втеч',
	"ув'язнен",
	'прихован',
	'нерозпоч',
	'неначат',
	'missing',
	'dormant',
	'imprison',
];

const ACTIVE_STEMS: readonly string[] = [
	'живи',
	'жив',
	'актив',
	'відвідан',
	'посещен',
	'alive',
	'active',
	'visited',
	'ongoing',
];

interface PhraseStemRule {
	words: readonly string[];
	status: StatusType;
}

const PHRASE_RULES: readonly PhraseStemRule[] = [
	{ words: ['не', 'розпоч'], status: 'INACTIVE' },
	{ words: ['не', 'знайден'], status: 'INACTIVE' },
	{ words: ['не', 'начат'], status: 'INACTIVE' },
	{ words: ['не', 'найден'], status: 'INACTIVE' },
	{ words: ['у', 'бігах'], status: 'INACTIVE' },
	{ words: ['в', 'бегах'], status: 'INACTIVE' },
	{ words: ['в', 'процесі'], status: 'ACTIVE' },
	{ words: ['у', 'процесі'], status: 'ACTIVE' },
	{ words: ['в', 'процессе'], status: 'ACTIVE' },
];

const NEGATION_TOKENS = new Set(['не', 'not']);

/**
 * Normalizes a tag, status text, or title segment according to Ukrainian-first NLP rules:
 * lowercase -> strip leading '#' -> '_' and '-' to space -> unify apostrophes -> 'ё' to 'е' -> collapse spaces.
 */
export function normalizeText(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/^#+/, '')
		.replace(/[_-]+/g, ' ')
		.replace(/[’ʼ`´]/g, "'")
		.replace(/ё/g, 'е')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Splits a tag (including nested tags like `#статус/мертвий`) into normalized segments.
 */
export function splitTagSegments(rawTag: string): string[] {
	return rawTag
		.split('/')
		.map((segment) => normalizeText(segment))
		.filter((segment) => segment.length > 0);
}

function tokenizeNormalizedWords(normalizedSegment: string): string[] {
	return normalizedSegment
		.split(/[^a-zа-яіїєґ0-9']+/)
		.filter((token) => token.length > 0);
}

function invertStatus(status: StatusType): StatusType {
	switch (status) {
		case 'TERMINATED':
			return 'ACTIVE';
		case 'ACTIVE':
			return 'INACTIVE';
		case 'INACTIVE':
			return 'ACTIVE';
		case 'UNKNOWN':
			return 'UNKNOWN';
	}
}

function matchesUserPattern(raw: string, pattern: string): boolean {
	const rawSegments = splitTagSegments(raw);
	const patternSegments = splitTagSegments(pattern);
	if (rawSegments.length === 0 || patternSegments.length === 0) {
		return false;
	}

	if (patternSegments.length === 1) {
		const target = patternSegments[0];
		if (!target) {
			return false;
		}
		for (const seg of rawSegments) {
			if (seg === target) {
				return true;
			}
			if (target.includes(' ') && seg.startsWith(target)) {
				return true;
			}
			if (!target.includes(' ') && target.length >= 3) {
				const words = tokenizeNormalizedWords(seg);
				for (let i = 0; i < words.length; i++) {
					const word = words[i];
					if (
						word &&
						(word === target || word.startsWith(target)) &&
						(i === 0 || !NEGATION_TOKENS.has(words[i - 1] ?? ''))
					) {
						return true;
					}
				}
			}
		}
		return false;
	}

	if (rawSegments.length < patternSegments.length) {
		return false;
	}

	for (
		let start = 0;
		start <= rawSegments.length - patternSegments.length;
		start++
	) {
		const matched = patternSegments.every(
			(seg, offset) => rawSegments[start + offset] === seg,
		);
		if (matched) {
			return true;
		}
	}

	return false;
}

function matchUserMapping(
	raw: string,
	statusMappings?: StatusMappings,
): StatusType | null {
	if (!statusMappings) {
		return null;
	}

	for (const tag of statusMappings.terminatedTags) {
		if (matchesUserPattern(raw, tag)) {
			return 'TERMINATED';
		}
	}

	for (const tag of statusMappings.inactiveTags) {
		if (matchesUserPattern(raw, tag)) {
			return 'INACTIVE';
		}
	}

	for (const tag of statusMappings.activeTags) {
		if (matchesUserPattern(raw, tag)) {
			return 'ACTIVE';
		}
	}

	return null;
}

function matchWordStem(token: string): StatusType | null {
	for (const stem of TERMINATED_STEMS) {
		if (token.startsWith(stem)) {
			return 'TERMINATED';
		}
	}
	for (const stem of INACTIVE_STEMS) {
		if (token.startsWith(stem)) {
			return 'INACTIVE';
		}
	}
	for (const stem of ACTIVE_STEMS) {
		if (token.startsWith(stem)) {
			return 'ACTIVE';
		}
	}
	return null;
}

function matchSegmentStems(segment: string): StatusType | null {
	const words = tokenizeNormalizedWords(segment);
	if (words.length === 0) {
		return null;
	}

	for (const rule of PHRASE_RULES) {
		if (words.length < rule.words.length) {
			continue;
		}
		for (let i = 0; i <= words.length - rule.words.length; i++) {
			const matched = rule.words.every((prefix, offset) => {
				const word = words[i + offset];
				if (word === undefined) {
					return false;
				}
				return offset === 0 ? word === prefix : word.startsWith(prefix);
			});
			if (matched) {
				return rule.status;
			}
		}
	}

	let best: StatusType | null = null;
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (!word) {
			continue;
		}
		const stemStatus = matchWordStem(word);
		if (!stemStatus) {
			continue;
		}

		const prevWord = i > 0 ? words[i - 1] : undefined;
		const resolved =
			prevWord !== undefined && NEGATION_TOKENS.has(prevWord)
				? invertStatus(stemStatus)
				: stemStatus;

		if (
			best === null ||
			statusPriority(resolved) > statusPriority(best)
		) {
			best = resolved;
		}
	}

	return best;
}

function statusPriority(status: StatusType): number {
	switch (status) {
		case 'TERMINATED':
			return 3;
		case 'INACTIVE':
			return 2;
		case 'ACTIVE':
			return 1;
		case 'UNKNOWN':
			return 0;
	}
}

/**
 * Matches a tag or short status text against user-configured mappings first,
 * then built-in Ukrainian/Russian/English status stems with negation handling.
 */
export function matchStatusFromTagOrText(
	raw: string,
	statusMappings?: StatusMappings,
): StatusType | null {
	const userMatch = matchUserMapping(raw, statusMappings);
	if (userMatch !== null) {
		return userMatch;
	}

	const segments = splitTagSegments(raw);
	let best: StatusType | null = null;

	for (const segment of segments) {
		const matched = matchSegmentStems(segment);
		if (
			matched !== null &&
			(best === null || statusPriority(matched) > statusPriority(best))
		) {
			best = matched;
		}
	}

	return best;
}

function collectFrontmatterStatusValues(
	frontmatter?: Record<string, unknown> | null,
): string[] {
	if (!frontmatter) {
		return [];
	}

	const values: string[] = [];
	const keys = ['status', 'state', 'статус'];

	for (const key of keys) {
		const raw = frontmatter[key];
		if (typeof raw === 'string' && raw.trim().length > 0) {
			values.push(raw);
		} else if (Array.isArray(raw)) {
			for (const item of raw) {
				if (typeof item === 'string' && item.trim().length > 0) {
					values.push(item);
				}
			}
		}
	}

	return values;
}

const EXPLICIT_STATUS_VALUES = new Set<StatusType>([
	'ACTIVE',
	'INACTIVE',
	'TERMINATED',
	'UNKNOWN',
]);

function extractExplicitFrontmatterNote(
	frontmatter?: Record<string, unknown> | null,
): string {
	if (!frontmatter) {
		return '';
	}
	for (const key of ['status_note', 'statusNote']) {
		const val = frontmatter[key];
		if (typeof val === 'string' && val.trim().length > 0) {
			return val.trim();
		}
	}
	return '';
}

function extractExplicitFrontmatterStatus(
	frontmatter?: Record<string, unknown> | null,
): StatusType | null {
	if (!frontmatter) {
		return null;
	}
	for (const key of ['status', 'state', 'статус']) {
		const raw = frontmatter[key];
		if (typeof raw === 'string') {
			const upper = raw.trim().toUpperCase() as StatusType;
			if (EXPLICIT_STATUS_VALUES.has(upper)) {
				return upper;
			}
		}
	}
	return null;
}

/**
 * Resolves static EntityState from note tags and frontmatter fields.
 * Explicit frontmatter `status` (`ACTIVE|INACTIVE|TERMINATED|UNKNOWN`) and
 * user-configured `statusMappings` override built-in stems.
 */
export function resolveStaticState(
	tags: string[],
	frontmatter?: Record<string, unknown> | null,
	statusMappings?: StatusMappings,
): EntityState {
	const explicitNote = extractExplicitFrontmatterNote(frontmatter);
	const explicitStatus = extractExplicitFrontmatterStatus(frontmatter);
	if (explicitStatus !== null) {
		return {
			statusType: explicitStatus,
			statusNote:
				explicitNote ||
				(explicitStatus === 'UNKNOWN'
					? ''
					: explicitStatus.toLowerCase()),
			sessionUpdated: null,
			source: 'TAG',
		};
	}

	const candidates = [...tags, ...collectFrontmatterStatusValues(frontmatter)];

	let userMatchedStatus: StatusType | null = null;
	let userMatchedNote = '';

	for (const candidate of candidates) {
		const matched = matchUserMapping(candidate, statusMappings);
		if (
			matched !== null &&
			(userMatchedStatus === null ||
				statusPriority(matched) > statusPriority(userMatchedStatus))
		) {
			userMatchedStatus = matched;
			userMatchedNote = normalizeText(candidate);
		}
	}

	if (userMatchedStatus !== null) {
		return {
			statusType: userMatchedStatus,
			statusNote: explicitNote || userMatchedNote,
			sessionUpdated: null,
			source: 'TAG',
		};
	}

	let bestStatus: StatusType | null = null;
	let bestNote = '';

	for (const candidate of candidates) {
		const matched = matchStatusFromTagOrText(candidate);
		if (
			matched !== null &&
			(bestStatus === null ||
				statusPriority(matched) > statusPriority(bestStatus))
		) {
			bestStatus = matched;
			bestNote = normalizeText(candidate);
		}
	}

	if (bestStatus !== null) {
		return {
			statusType: bestStatus,
			statusNote: explicitNote || bestNote,
			sessionUpdated: null,
			source: 'TAG',
		};
	}

	return {
		statusType: 'UNKNOWN',
		statusNote: explicitNote,
		sessionUpdated: null,
		source: 'DEFAULT',
	};
}
