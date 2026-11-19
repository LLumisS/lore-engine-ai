/**
 * Lightweight Cyrillic-aware token estimator with per-model calibration.
 * Kept strictly pure (no Obsidian or runtime network dependencies).
 */

export const CYRILLIC_CHARS_PER_TOKEN = 2.3;
export const LATIN_CHARS_PER_TOKEN = 4.0;
export const DIGIT_CHARS_PER_TOKEN = 2.0;
export const PUNCTUATION_TOKENS_WEIGHT = 0.5;
export const DEFAULT_SAFETY_MARGIN = 0.1;

const EMA_ALPHA = 0.3;
const MIN_CALIBRATION_RATIO = 0.5;
const MAX_CALIBRATION_RATIO = 2.5;

const CYRILLIC_REGEX = /[\u0400-\u04FF\u0500-\u052F]/;
const LATIN_REGEX = /[A-Za-z\u00C0-\u024F]/;
const DIGIT_REGEX = /[0-9]/;
const WHITESPACE_REGEX = /\s/;

const calibrationStore: Record<string, number> = Object.create(null) as Record<
	string,
	number
>;

/**
 * Estimates uncalibrated token count for a string, accounting for higher
 * BPE token density of Cyrillic scripts compared to Latin text.
 */
export function estimateRawTokens(text: string): number {
	if (!text || text.trim().length === 0) {
		return 0;
	}

	let raw = 0;
	for (const ch of text) {
		if (WHITESPACE_REGEX.test(ch)) {
			continue;
		}
		if (CYRILLIC_REGEX.test(ch)) {
			raw += 1 / CYRILLIC_CHARS_PER_TOKEN;
		} else if (LATIN_REGEX.test(ch)) {
			raw += 1 / LATIN_CHARS_PER_TOKEN;
		} else if (DIGIT_REGEX.test(ch)) {
			raw += 1 / DIGIT_CHARS_PER_TOKEN;
		} else {
			raw += PUNCTUATION_TOKENS_WEIGHT;
		}
	}

	return raw;
}

/**
 * Returns calibrated integer token estimate for a text string.
 */
export function estimateTokens(text: string, modelId = 'default'): number {
	const raw = estimateRawTokens(text);
	if (raw === 0) {
		return 0;
	}

	const scaled = raw * getCalibrationRatio(modelId);
	return Math.max(1, Math.ceil(scaled));
}

/**
 * Estimates tokens with a multiplicative safety margin (10% by default)
 * for conservative context-budget packing.
 */
export function estimateTokensWithMargin(
	text: string,
	safetyMargin = DEFAULT_SAFETY_MARGIN,
	modelId = 'default',
): number {
	const base = estimateTokens(text, modelId);
	if (base === 0) {
		return 0;
	}

	const margin = Math.max(0, safetyMargin);
	return Math.ceil(base * (1 + margin));
}

/**
 * Updates the moving calibration multiplier for a model based on provider usage
 * counts (e.g., prompt_eval_count or usage.input_tokens).
 */
export function calibrateTokenizer(
	actualTokens: number,
	estimatedTokens: number,
	modelId = 'default',
): number {
	const currentRatio = getCalibrationRatio(modelId);
	if (
		!Number.isFinite(actualTokens) ||
		!Number.isFinite(estimatedTokens) ||
		actualTokens <= 0 ||
		estimatedTokens <= 0
	) {
		return currentRatio;
	}

	const observedRatio = actualTokens / estimatedTokens;
	const blended =
		currentRatio * (1 - EMA_ALPHA) + observedRatio * EMA_ALPHA;
	const clamped = Math.min(
		MAX_CALIBRATION_RATIO,
		Math.max(MIN_CALIBRATION_RATIO, blended),
	);

	calibrationStore[modelId] = clamped;
	return clamped;
}

export function getCalibrationRatio(modelId = 'default'): number {
	return calibrationStore[modelId] ?? 1.0;
}

export function resetTokenizerCalibration(): void {
	for (const key of Object.keys(calibrationStore)) {
		delete calibrationStore[key];
	}
}
