import { beforeEach, describe, expect, it } from 'vitest';
import {
	calibrateTokenizer,
	estimateTokens,
	estimateTokensWithMargin,
	getCalibrationRatio,
	resetTokenizerCalibration,
} from '../src/core/tokenizer';
import { t } from '../src/i18n';
import { DEFAULT_SETTINGS, deepMergeSettings } from '../src/settings';
import type { ScoringWeights } from '../src/types';

describe('tokenizer', () => {
	beforeEach(() => {
		resetTokenizerCalibration();
	});

	it('returns 0 for empty and whitespace-only strings', () => {
		expect(estimateTokens('')).toBe(0);
		expect(estimateTokens('   \n\t  ')).toBe(0);
		expect(estimateTokensWithMargin('')).toBe(0);
	});

	it('assigns higher token density to Ukrainian Cyrillic than Latin text of equal length', () => {
		const ukrainian = 'Барон Келд править містом Окхейвен';
		const english = 'Baron Keld rules Oakhaven city now';

		expect(ukrainian.length).toBe(english.length);
		expect(estimateTokens(ukrainian)).toBeGreaterThan(
			estimateTokens(english),
		);
	});

	it('handles mixed Ukrainian, English, numbers, and wiki/markdown syntax', () => {
		const mixed = '## Сесія 12: [[Барон Келд]] (CR 5) — статус #active';
		const tokens = estimateTokens(mixed);

		expect(tokens).toBeGreaterThan(10);
		expect(tokens).toBeLessThan(60);
	});

	it('applies the safety margin correctly', () => {
		const sample = 'Коротка замітка про місто Окхейвен і замок на пагорбі.';
		const base = estimateTokens(sample);
		const withMargin = estimateTokensWithMargin(sample, 0.1);

		expect(withMargin).toBe(Math.ceil(base * 1.1));
		expect(withMargin).toBeGreaterThan(base);
	});

	it('calibrates and clamps per-model ratio and resets cleanly', () => {
		expect(getCalibrationRatio('llama3.1:8b')).toBe(1.0);

		const updated = calibrateTokenizer(150, 100, 'llama3.1:8b');
		expect(updated).toBeCloseTo(1.15, 5);
		expect(getCalibrationRatio('llama3.1:8b')).toBeCloseTo(1.15, 5);
		expect(getCalibrationRatio('other-model')).toBe(1.0);

		// Extreme spike gets smoothed and clamped below MAX_CALIBRATION_RATIO (2.5)
		for (let i = 0; i < 20; i++) {
			calibrateTokenizer(1000, 10, 'llama3.1:8b');
		}
		expect(getCalibrationRatio('llama3.1:8b')).toBe(2.5);

		// Invalid counts are ignored
		expect(calibrateTokenizer(0, 100, 'other-model')).toBe(1.0);
		expect(calibrateTokenizer(100, 0, 'other-model')).toBe(1.0);

		resetTokenizerCalibration();
		expect(getCalibrationRatio('llama3.1:8b')).toBe(1.0);
	});
});

describe('deepMergeSettings', () => {
	it('preserves nested defaults when merging partial settings without mutating DEFAULT_SETTINGS', () => {
		const partial = {
			llmProvider: 'openai' as const,
			scoringWeights: { semantic: 0.8 } as ScoringWeights,
			experiment: { disableGraphTraversal: true } as typeof DEFAULT_SETTINGS.experiment,
			statusMappings: { terminatedTags: ['#dead'] } as typeof DEFAULT_SETTINGS.statusMappings,
		};

		const merged = deepMergeSettings(DEFAULT_SETTINGS, partial);

		expect(merged.llmProvider).toBe('openai');
		expect(merged.scoringWeights.semantic).toBe(0.8);
		expect(merged.scoringWeights.proximity).toBe(
			DEFAULT_SETTINGS.scoringWeights.proximity,
		);
		expect(merged.scoringWeights.typeBoost).toBe(
			DEFAULT_SETTINGS.scoringWeights.typeBoost,
		);
		expect(merged.experiment.disableGraphTraversal).toBe(true);
		expect(merged.experiment.logRetrievalTraces).toBe(false);
		expect(merged.statusMappings.terminatedTags).toEqual(['#dead']);
		expect(merged.statusMappings.inactiveTags).toEqual(
			DEFAULT_SETTINGS.statusMappings.inactiveTags,
		);

		// Mutating merged arrays must not mutate DEFAULT_SETTINGS
		merged.statusMappings.inactiveTags.push('#custom');
		expect(DEFAULT_SETTINGS.statusMappings.inactiveTags).not.toContain(
			'#custom',
		);
		expect(DEFAULT_SETTINGS.scoringWeights.semantic).toBe(0.35);
	});
});

describe('i18n', () => {
	it('returns localized strings for uk and en', () => {
		expect(t('uk', 'helloNotice')).toContain('LoreEngine AI');
		expect(t('en', 'helloNotice')).toContain('LoreEngine AI');
		expect(t('uk', 'commandHelloName')).not.toBe(
			t('en', 'commandHelloName'),
		);
	});
});
