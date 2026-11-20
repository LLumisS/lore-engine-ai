import { describe, expect, it } from 'vitest';
import {
	matchStatusFromTagOrText,
	normalizeText,
	resolveStaticState,
	splitTagSegments,
} from '../src/core/statusRules';
import type { StatusMappings } from '../src/types';

describe('statusRules normalization', () => {
	it('normalizes case, hashtags, underscores, hyphens, apostrophes, and ё', () => {
		expect(normalizeText('#Статус-Мертв_Ёжик’ʼ`')).toBe(
			"статус мертв ежик'''",
		);
		expect(splitTagSegments('#Статус/Мертвий')).toEqual([
			'статус',
			'мертвий',
		]);
	});
});

describe('statusRules stems (uk/ru/en)', () => {
	it('recognizes TERMINATED, INACTIVE, and ACTIVE stems across languages', () => {
		expect(matchStatusFromTagOrText('#статус/мертвий')).toBe('TERMINATED');
		expect(matchStatusFromTagOrText('#погиб')).toBe('TERMINATED');
		expect(matchStatusFromTagOrText('#status/dead')).toBe('TERMINATED');
		expect(matchStatusFromTagOrText('#зруйновано')).toBe('TERMINATED');

		expect(matchStatusFromTagOrText('#статус/зник')).toBe('INACTIVE');
		expect(matchStatusFromTagOrText('#пропал')).toBe('INACTIVE');
		expect(matchStatusFromTagOrText('#status/missing')).toBe('INACTIVE');

		expect(matchStatusFromTagOrText('#живий')).toBe('ACTIVE');
		expect(matchStatusFromTagOrText('#активный')).toBe('ACTIVE');
		expect(matchStatusFromTagOrText('#visited')).toBe('ACTIVE');
	});
});

describe('statusRules negation and pitfalls', () => {
	it('inverts status on explicit negation while avoiding false positives', () => {
		expect(matchStatusFromTagOrText('не мертвий')).toBe('ACTIVE');
		expect(matchStatusFromTagOrText('not dead')).toBe('ACTIVE');
		expect(matchStatusFromTagOrText('не живий')).toBe('INACTIVE');

		// "нежить" (undead) must NOT trigger negation or false ACTIVE/TERMINATED match
		expect(matchStatusFromTagOrText('#нежить')).toBeNull();
		expect(resolveStaticState(['#нежить']).statusType).toBe('UNKNOWN');

		// "не розпочато" / "не начато" directly resolve to INACTIVE
		expect(matchStatusFromTagOrText('#не_розпочато')).toBe('INACTIVE');
		expect(matchStatusFromTagOrText('не начато')).toBe('INACTIVE');
	});
});

describe('statusRules user mappings precedence', () => {
	it('gives user statusMappings priority over built-in stems', () => {
		const userMappings: StatusMappings = {
			activeTags: ['#персонаж/звільнений'],
			terminatedTags: ['#статус/відійшов_у_вічність'],
			inactiveTags: ['#помер_у_бою'],
		};

		// "#помер_у_бою" contains built-in TERMINATED stem "помер",
		// but user placed it in inactiveTags -> must resolve to INACTIVE.
		const resolved = resolveStaticState(['#помер_у_бою'], null, userMappings);
		expect(resolved.statusType).toBe('INACTIVE');
		expect(resolved.source).toBe('TAG');

		const customTerminated = resolveStaticState(
			['#статус/відійшов_у_вічність'],
			null,
			userMappings,
		);
		expect(customTerminated.statusType).toBe('TERMINATED');

		const customActive = resolveStaticState(
			['#персонаж/звільнений'],
			null,
			userMappings,
		);
		expect(customActive.statusType).toBe('ACTIVE');
	});

	it('matches short segment values regardless of #x/ prefix and resolves explicit frontmatter status', () => {
		const segmentMappings: StatusMappings = {
			activeTags: ['у_строю'],
			inactiveTags: ['не_найдено'],
			terminatedTags: ['знищено'],
		};

		expect(
			resolveStaticState(['#предмет/не_найдено'], null, segmentMappings)
				.statusType,
		).toBe('INACTIVE');
		expect(
			resolveStaticState(
				['#запись/архив/не_найдено'],
				null,
				segmentMappings,
			).statusType,
		).toBe('INACTIVE');
		expect(
			resolveStaticState(['#персонаж/у_строю'], null, segmentMappings)
				.statusType,
		).toBe('ACTIVE');

		const fromFrontmatter = resolveStaticState([], {
			status: 'TERMINATED',
			status_note: 'зруйновано у сесії 3',
		});
		expect(fromFrontmatter.statusType).toBe('TERMINATED');
		expect(fromFrontmatter.statusNote).toBe('зруйновано у сесії 3');
	});
});
