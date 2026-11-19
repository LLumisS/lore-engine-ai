import { describe, expect, it } from 'vitest';
import { isNoteIgnored, parseLoreIgnore } from '../src/config/loreIgnore';

describe('loreIgnore', () => {
	const rules = parseLoreIgnore(`
# Ignore comments and blank lines

archive/
World/Drafts/
*.draft.md
tag:#wip
#secret
`);

	it('parses folder prefixes, wildcard patterns, and tag rules while ignoring comments', () => {
		expect(rules.folderPrefixes).toEqual(['archive/', 'world/drafts/']);
		expect(rules.pathPatterns).toEqual(['*.draft.md']);
		expect(rules.ignoredTags).toEqual(['wip', 'secret']);
	});

	it('ignores notes matching folder prefixes', () => {
		expect(
			isNoteIgnored({ path: 'Archive/Old NPC.md', tags: [] }, rules),
		).toBe(true);
		expect(
			isNoteIgnored(
				{ path: 'World/Drafts/Quest Idea.md', tags: [] },
				rules,
			),
		).toBe(true);
		expect(
			isNoteIgnored({ path: 'World/NPC/Baron Keld.md', tags: [] }, rules),
		).toBe(false);
	});

	it('ignores notes matching wildcard paths and tags (including nested tags)', () => {
		expect(
			isNoteIgnored({ path: 'World/NPC/Boss.draft.md', tags: [] }, rules),
		).toBe(true);
		expect(
			isNoteIgnored(
				{ path: 'World/Lore/Plot.md', tags: ['#wip/chapter2'] },
				rules,
			),
		).toBe(true);
		expect(
			isNoteIgnored(
				{
					path: 'World/Lore/Hidden.md',
					tags: [],
					frontmatter: { tags: ['secret/gm'] },
				},
				rules,
			),
		).toBe(true);
	});

	it('ignores notes with ai_ignore: true in frontmatter', () => {
		expect(
			isNoteIgnored(
				{
					path: 'World/NPC/GM Notes.md',
					tags: [],
					frontmatter: { ai_ignore: true },
				},
				rules,
			),
		).toBe(true);
		expect(
			isNoteIgnored(
				{
					path: 'World/NPC/Visible.md',
					tags: ['#npc'],
					frontmatter: { ai_ignore: false },
				},
				rules,
			),
		).toBe(false);
	});
});
