import {
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	type App,
	type DropdownComponent,
	type TextComponent,
	type ToggleComponent,
} from 'obsidian';
import { formatMessage, t } from '../i18n';
import {
	createEmbeddingProvider,
	createLlmProvider,
} from '../llm/llmProvider';
import { fetchOllamaModels } from '../llm/ollamaClient';
import { PING_SYSTEM_PROMPT } from '../llm/prompts';
import { formatLlmError, isAbortError } from '../llm/streaming';
import {
	DEFAULT_CHAT_MODELS,
	DEFAULT_EMBEDDING_MODELS,
	DEFAULT_SETTINGS,
} from '../settings';
import type { LlmProviderId, PluginSettings, UiLanguage } from '../types';

export interface LoreEnginePluginHost extends Plugin {
	settings: PluginSettings;
	saveSettings(): Promise<void>;
	openPingModal(): void;
	openOnboardingModal(): void;
	toggleNoteBarVisibility(visible: boolean): Promise<void>;
	trackAbortController(controller: AbortController): () => void;
}

const PROVIDER_LABELS: Record<LlmProviderId, string> = {
	ollama: 'Ollama',
	openai: 'OpenAI',
	anthropic: 'Anthropic',
	gemini: 'Google Gemini',
};

const EMBEDDING_PROVIDER_LABELS: Record<'ollama' | 'openai' | 'gemini', string> = {
	ollama: 'Ollama',
	openai: 'OpenAI',
	gemini: 'Google Gemini',
};

export class CloudConsentModal extends Modal {
	private readonly lang: UiLanguage;
	private readonly providerLabel: string;
	private readonly onResult: (accepted: boolean) => void;
	private resolved = false;

	constructor(
		app: App,
		lang: UiLanguage,
		providerLabel: string,
		onResult: (accepted: boolean) => void,
	) {
		super(app);
		this.lang = lang;
		this.providerLabel = providerLabel;
		this.onResult = onResult;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lore-modal');

		new Setting(contentEl)
			.setName(t(this.lang, 'consentModalTitle'))
			.setHeading();

		contentEl.createEl('p', {
			cls: 'lore-privacy-note',
			text: formatMessage(t(this.lang, 'consentModalBody'), {
				provider: this.providerLabel,
			}),
		});

		new Setting(contentEl)
			.addButton((btn) => {
				btn.setButtonText(t(this.lang, 'consentDeclineButton')).onClick(
					() => {
						this.finish(false);
					},
				);
			})
			.addButton((btn) => {
				btn.setButtonText(t(this.lang, 'consentAcceptButton'))
					.setCta()
					.onClick(() => {
						this.finish(true);
					});
			});
	}

	private finish(accepted: boolean): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.close();
		this.onResult(accepted);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.onResult(false);
		}
	}
}

export class PingLlmModal extends Modal {
	private readonly host: LoreEnginePluginHost;
	private promptValue: string;
	private abortController: AbortController | null = null;
	private untrackController: (() => void) | null = null;
	private isStreaming = false;

	private outputEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private sendBtnEl: HTMLButtonElement | null = null;
	private embBtnEl: HTMLButtonElement | null = null;
	private abortBtnEl: HTMLButtonElement | null = null;

	constructor(app: App, host: LoreEnginePluginHost) {
		super(app);
		this.host = host;
		this.promptValue = t(host.settings.uiLanguage, 'pingDefaultPrompt');
	}

	onOpen(): void {
		const { contentEl } = this;
		const lang = this.host.settings.uiLanguage;
		const settings = this.host.settings;

		contentEl.empty();
		contentEl.addClass('lore-modal');

		const chatInfo = formatMessage(t(lang, 'pingProviderInfo'), {
			provider: PROVIDER_LABELS[settings.llmProvider],
			model: settings.modelName,
		});
		const embProviderLabel =
			settings.embeddingProvider === 'anthropic'
				? 'Anthropic'
				: EMBEDDING_PROVIDER_LABELS[settings.embeddingProvider];
		const embInfo = formatMessage(t(lang, 'pingEmbeddingInfo'), {
			provider: embProviderLabel,
			model: settings.embeddingModel,
		});

		new Setting(contentEl)
			.setName(t(lang, 'pingModalTitle'))
			.setDesc(`${chatInfo} | ${embInfo}`)
			.setHeading();

		new Setting(contentEl)
			.setName(t(lang, 'pingPromptLabel'))
			.addTextArea((area) => {
				area.inputEl.addClass('lore-textarea');
				area.inputEl.rows = 3;
				area.setValue(this.promptValue).onChange((val) => {
					this.promptValue = val;
				});
			});

		const controls = new Setting(contentEl);
		controls.addButton((btn) => {
			btn.setButtonText(t(lang, 'pingStartButton'))
				.setCta()
				.onClick(() => {
					void this.startPing();
				});
			this.sendBtnEl = btn.buttonEl;
		});
		controls.addButton((btn) => {
			btn.setButtonText(t(lang, 'pingEmbeddingButton')).onClick(() => {
				void this.startEmbeddingPing();
			});
			this.embBtnEl = btn.buttonEl;
		});
		controls.addButton((btn) => {
			btn.setButtonText(t(lang, 'pingAbortButton')).onClick(() => {
				this.abortController?.abort();
			});
			btn.buttonEl.disabled = true;
			this.abortBtnEl = btn.buttonEl;
		});

		this.outputEl = contentEl.createDiv({ cls: 'lore-ping-output' });
		this.statusEl = contentEl.createDiv({
			cls: 'lore-ping-status lore-muted',
			text: t(lang, 'pingStatusIdle'),
		});
	}

	private setStreamingState(active: boolean): void {
		this.isStreaming = active;
		if (this.sendBtnEl) {
			this.sendBtnEl.disabled = active;
		}
		if (this.embBtnEl) {
			this.embBtnEl.disabled = active;
		}
		if (this.abortBtnEl) {
			this.abortBtnEl.disabled = !active;
		}
	}

	private setStatus(text: string, isError = false): void {
		if (!this.statusEl) {
			return;
		}
		this.statusEl.setText(text);
		if (isError) {
			this.statusEl.addClass('lore-ping-error');
			this.statusEl.removeClass('lore-muted');
		} else {
			this.statusEl.removeClass('lore-ping-error');
			this.statusEl.addClass('lore-muted');
		}
	}

	private async ensureCloudConsentIfNeeded(
		provider: LlmProviderId,
	): Promise<boolean> {
		const settings = this.host.settings;
		if (provider === 'ollama' || settings.cloudConsentGiven) {
			return true;
		}

		return new Promise<boolean>((resolve) => {
			new CloudConsentModal(
				this.app,
				settings.uiLanguage,
				PROVIDER_LABELS[provider],
				(accepted) => {
					resolve(accepted);
				},
			).open();
		}).then(async (accepted) => {
			if (accepted) {
				this.host.settings.cloudConsentGiven = true;
				await this.host.saveSettings();
			}
			return accepted;
		});
	}

	private async startPing(): Promise<void> {
		if (this.isStreaming) {
			return;
		}

		const lang = this.host.settings.uiLanguage;
		const consentOk = await this.ensureCloudConsentIfNeeded(
			this.host.settings.llmProvider,
		);
		if (!consentOk) {
			this.setStatus(t(lang, 'llmErrorCloudConsent'), true);
			return;
		}

		const controller = new AbortController();
		this.abortController = controller;
		this.untrackController = this.host.trackAbortController(controller);

		let accumulated = '';
		this.outputEl?.setText('');
		this.setStreamingState(true);
		this.setStatus(t(lang, 'pingStatusStreaming'));

		try {
			const provider = createLlmProvider(this.host.settings);
			const prompt =
				this.promptValue.trim() || t(lang, 'pingDefaultPrompt');
			const result = await provider.stream({
				system: PING_SYSTEM_PROMPT,
				messages: [{ role: 'user', content: prompt }],
				temperature: 0.2,
				signal: controller.signal,
				onToken: (token) => {
					accumulated += token;
					this.outputEl?.setText(accumulated);
				},
			});

			const inputCount =
				result.usage?.input !== undefined
					? String(result.usage.input)
					: '-';
			const outputCount =
				result.usage?.output !== undefined
					? String(result.usage.output)
					: '-';
			this.setStatus(
				formatMessage(t(lang, 'pingStatusDone'), {
					input: inputCount,
					output: outputCount,
				}),
			);
		} catch (error) {
			if (isAbortError(error)) {
				this.setStatus(t(lang, 'pingStatusAborted'));
			} else {
				const formatted = formatLlmError(
					error,
					lang,
					this.host.settings.llmProvider,
					{
						model: this.host.settings.modelName,
						ollamaUrl: this.host.settings.ollamaUrl,
					},
				);
				this.setStatus(formatted, true);
				new Notice(formatted);
			}
		} finally {
			this.untrackController?.();
			this.untrackController = null;
			this.abortController = null;
			this.setStreamingState(false);
		}
	}

	private async startEmbeddingPing(): Promise<void> {
		if (this.isStreaming) {
			return;
		}

		const lang = this.host.settings.uiLanguage;
		const embProviderId = this.host.settings.embeddingProvider;
		const embProvider = createEmbeddingProvider(this.host.settings);
		if (!embProvider) {
			this.setStatus(t(lang, 'pingEmbeddingUnsupported'), true);
			return;
		}

		const consentOk = await this.ensureCloudConsentIfNeeded(embProviderId);
		if (!consentOk) {
			this.setStatus(t(lang, 'llmErrorCloudConsent'), true);
			return;
		}

		const controller = new AbortController();
		this.abortController = controller;
		this.untrackController = this.host.trackAbortController(controller);

		this.outputEl?.setText('');
		this.setStreamingState(true);
		this.setStatus(t(lang, 'pingStatusEmbedding'));

		const startedAt = Date.now();
		try {
			const prompt =
				this.promptValue.trim() || t(lang, 'pingDefaultPrompt');
			const vectors = await embProvider.embed([prompt], controller.signal);
			const elapsedMs = Date.now() - startedAt;
			const firstVector = vectors[0] ?? [];
			const preview = firstVector
				.slice(0, 6)
				.map((v) => v.toFixed(4))
				.join(', ');

			this.outputEl?.setText(
				`[${preview}${firstVector.length > 6 ? ', ...' : ''}]`,
			);
			this.setStatus(
				formatMessage(t(lang, 'pingStatusEmbeddingDone'), {
					dim: firstVector.length,
					ms: elapsedMs,
				}),
			);
		} catch (error) {
			if (isAbortError(error)) {
				this.setStatus(t(lang, 'pingStatusAborted'));
			} else {
				const formatted = formatLlmError(error, lang, embProviderId, {
					model: this.host.settings.embeddingModel,
					ollamaUrl: this.host.settings.ollamaUrl,
				});
				this.setStatus(formatted, true);
				new Notice(formatted);
			}
		} finally {
			this.untrackController?.();
			this.untrackController = null;
			this.abortController = null;
			this.setStreamingState(false);
		}
	}

	onClose(): void {
		this.abortController?.abort();
		this.abortController = null;
		this.untrackController?.();
		this.untrackController = null;
		this.contentEl.empty();
	}
}

// Obsidian 1.12.3 typings and minAppVersion 1.0.0 do not expose getSettingDefinitions().
export class LoreEngineSettingTab extends PluginSettingTab {
	private readonly host: LoreEnginePluginHost;
	private detectedOllamaModels: string[] = [];
	private providerFieldsEl: HTMLElement | null = null;
	private embeddingFieldsEl: HTMLElement | null = null;
	private cloudConsentToggle: ToggleComponent | null = null;
	private llmProviderDropdown: DropdownComponent | null = null;
	private modelTextInput: TextComponent | null = null;

	constructor(app: App, host: LoreEnginePluginHost) {
		super(app, host);
		this.host = host;
	}

	display(): void {
		const { containerEl } = this;
		const prevScrollTop = containerEl.scrollTop;
		const prevParentScrollTop = containerEl.parentElement?.scrollTop ?? 0;
		const settings = this.host.settings;
		const lang = settings.uiLanguage;

		this.providerFieldsEl = null;
		this.embeddingFieldsEl = null;
		this.cloudConsentToggle = null;
		this.llmProviderDropdown = null;
		this.modelTextInput = null;

		containerEl.empty();

		new Setting(containerEl)
			.setName(t(lang, 'settingsHeadingGeneral'))
			.setHeading();

		new Setting(containerEl)
			.setName(t(lang, 'settingsLanguageName'))
			.setDesc(t(lang, 'settingsLanguageDesc'))
			.addDropdown((dropdown) => {
				dropdown
					.addOption('uk', t(lang, 'settingsLanguageUk'))
					.addOption('ru', t(lang, 'settingsLanguageRu'))
					.addOption('en', t(lang, 'settingsLanguageEn'))
					.setValue(settings.uiLanguage)
					.onChange(async (value) => {
						this.host.settings.uiLanguage = value as UiLanguage;
						await this.host.saveSettings();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName(t(lang, 'settingsHeadingPrivacy'))
			.setHeading();

		containerEl.createDiv({
			cls: 'lore-privacy-note',
			text: t(lang, 'settingsPrivacyNotice'),
		});

		new Setting(containerEl)
			.setName(t(lang, 'settingsCloudConsentName'))
			.setDesc(t(lang, 'settingsCloudConsentDesc'))
			.addToggle((toggle) => {
				this.cloudConsentToggle = toggle;
				toggle
					.setValue(settings.cloudConsentGiven)
					.onChange(async (value) => {
						if (value) {
							new CloudConsentModal(
								this.app,
								lang,
								PROVIDER_LABELS[this.host.settings.llmProvider],
								(accepted) => {
									void (async () => {
										this.host.settings.cloudConsentGiven =
											accepted;
										await this.host.saveSettings();
										this.cloudConsentToggle?.setValue(
											accepted,
										);
									})();
								},
							).open();
							return;
						}
						this.host.settings.cloudConsentGiven = false;
						await this.host.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(t(lang, 'settingsHeadingLlm'))
			.setHeading();

		new Setting(containerEl)
			.setName(t(lang, 'settingsProviderName'))
			.setDesc(t(lang, 'settingsProviderDesc'))
			.addDropdown((dropdown) => {
				this.llmProviderDropdown = dropdown;
				dropdown
					.addOptions(PROVIDER_LABELS)
					.setValue(settings.llmProvider)
					.onChange(async (rawValue) => {
						const nextProvider = rawValue as LlmProviderId;
						if (
							nextProvider !== 'ollama' &&
							!this.host.settings.cloudConsentGiven
						) {
							new CloudConsentModal(
								this.app,
								lang,
								PROVIDER_LABELS[nextProvider],
								(accepted) => {
									void (async () => {
										if (accepted) {
											this.host.settings.cloudConsentGiven = true;
											this.switchLlmProvider(nextProvider);
											this.cloudConsentToggle?.setValue(
												true,
											);
										} else {
											this.switchLlmProvider('ollama');
											this.llmProviderDropdown?.setValue(
												'ollama',
											);
										}
										await this.host.saveSettings();
										this.renderProviderSpecificSettings();
									})();
								},
							).open();
							return;
						}
						this.switchLlmProvider(nextProvider);
						await this.host.saveSettings();
						this.renderProviderSpecificSettings();
					});
			});

		this.providerFieldsEl = containerEl.createDiv({
			cls: 'lore-provider-fields',
		});
		this.renderProviderSpecificSettings();

		new Setting(containerEl)
			.setName(t(lang, 'settingsEmbeddingProviderName'))
			.setDesc(t(lang, 'settingsEmbeddingProviderDesc'))
			.addDropdown((dropdown) => {
				const currentEmb =
					settings.embeddingProvider === 'anthropic'
						? 'ollama'
						: settings.embeddingProvider;
				dropdown
					.addOptions(EMBEDDING_PROVIDER_LABELS)
					.setValue(currentEmb)
					.onChange(async (rawValue) => {
						const nextEmb = rawValue as
							| 'ollama'
							| 'openai'
							| 'gemini';
						if (
							nextEmb !== 'ollama' &&
							!this.host.settings.cloudConsentGiven
						) {
							new CloudConsentModal(
								this.app,
								lang,
								EMBEDDING_PROVIDER_LABELS[nextEmb],
								(accepted) => {
									void (async () => {
										if (accepted) {
											this.host.settings.cloudConsentGiven = true;
											this.switchEmbeddingProvider(
												nextEmb,
											);
											this.cloudConsentToggle?.setValue(
												true,
											);
										} else {
											this.switchEmbeddingProvider(
												'ollama',
											);
											dropdown.setValue('ollama');
										}
										await this.host.saveSettings();
										this.renderEmbeddingSpecificSettings();
									})();
								},
							).open();
							return;
						}
						this.switchEmbeddingProvider(nextEmb);
						await this.host.saveSettings();
						this.renderEmbeddingSpecificSettings();
					});
			});

		this.embeddingFieldsEl = containerEl.createDiv({
			cls: 'lore-provider-fields',
		});
		this.renderEmbeddingSpecificSettings();

		new Setting(containerEl)
			.setName(t(lang, 'settingsTestLlmName'))
			.setDesc(t(lang, 'settingsTestLlmDesc'))
			.addButton((btn) => {
				btn.setButtonText(t(lang, 'commandPingLlmName'))
					.setCta()
					.onClick(() => {
						this.host.openPingModal();
					});
			});

		new Setting(containerEl)
			.setName(t(lang, 'settingsHeadingVault'))
			.setHeading();

		new Setting(containerEl)
			.setName(t(lang, 'settingsOpenOnboardingName'))
			.setDesc(t(lang, 'settingsOpenOnboardingDesc'))
			.addButton((btn) => {
				btn.setButtonText(t(lang, 'commandOnboardingName')).onClick(
					() => {
						this.host.openOnboardingModal();
					},
				);
			});

		new Setting(containerEl)
			.setName(t(lang, 'settingsShowNoteBarName'))
			.setDesc(t(lang, 'settingsShowNoteBarDesc'))
			.addToggle((toggle) => {
				toggle
					.setValue(settings.showNoteBar)
					.onChange(async (value) => {
						await this.host.toggleNoteBarVisibility(value);
					});
			});

		if (prevScrollTop > 0 || prevParentScrollTop > 0) {
			containerEl.scrollTop = prevScrollTop;
			if (containerEl.parentElement) {
				containerEl.parentElement.scrollTop = prevParentScrollTop;
			}
			window.requestAnimationFrame(() => {
				containerEl.scrollTop = prevScrollTop;
				if (containerEl.parentElement) {
					containerEl.parentElement.scrollTop = prevParentScrollTop;
				}
			});
		}
	}

	private switchLlmProvider(nextProvider: LlmProviderId): void {
		const prevProvider = this.host.settings.llmProvider;
		this.host.settings.chatModels = {
			...this.host.settings.chatModels,
			[prevProvider]: this.host.settings.modelName,
		};
		this.host.settings.llmProvider = nextProvider;
		this.host.settings.modelName =
			this.host.settings.chatModels[nextProvider] ??
			DEFAULT_CHAT_MODELS[nextProvider] ??
			'';
	}

	private switchEmbeddingProvider(
		nextProvider: 'ollama' | 'openai' | 'gemini',
	): void {
		const prevProvider = this.host.settings.embeddingProvider;
		this.host.settings.embeddingModels = {
			...this.host.settings.embeddingModels,
			[prevProvider]: this.host.settings.embeddingModel,
		};
		this.host.settings.embeddingProvider = nextProvider;
		this.host.settings.embeddingModel =
			this.host.settings.embeddingModels[nextProvider] ??
			DEFAULT_EMBEDDING_MODELS[nextProvider] ??
			'';
	}

	private renderProviderSpecificSettings(): void {
		if (!this.providerFieldsEl) {
			return;
		}
		const target = this.providerFieldsEl;
		const settings = this.host.settings;
		const lang = settings.uiLanguage;
		const activeProvider = settings.llmProvider;

		this.modelTextInput = null;
		target.empty();

		if (activeProvider === 'ollama') {
			new Setting(target)
				.setName(t(lang, 'settingsOllamaUrlName'))
				.setDesc(t(lang, 'settingsOllamaUrlDesc'))
				.addText((text) => {
					text.setPlaceholder(DEFAULT_SETTINGS.ollamaUrl)
						.setValue(settings.ollamaUrl)
						.onChange(async (value) => {
							this.host.settings.ollamaUrl = value.trim();
							await this.host.saveSettings();
						});
				})
				.addButton((btn) => {
					btn.setButtonText(
						t(lang, 'settingsRefreshModelsBtn'),
					).onClick(() => {
						void this.refreshOllamaModels();
					});
				});

			if (this.detectedOllamaModels.length > 0) {
				new Setting(target)
					.setName(t(lang, 'settingsModelName'))
					.addDropdown((dropdown) => {
						for (const model of this.detectedOllamaModels) {
							dropdown.addOption(model, model);
						}
						if (
							this.detectedOllamaModels.includes(
								settings.modelName,
							)
						) {
							dropdown.setValue(settings.modelName);
						}
						dropdown.onChange(async (value) => {
							this.host.settings.modelName = value;
							this.host.settings.chatModels = {
								...this.host.settings.chatModels,
								ollama: value,
							};
							this.modelTextInput?.setValue(value);
							await this.host.saveSettings();
						});
					});
			}
		} else {
			this.addUnifiedApiKeySetting(target, activeProvider);
		}

		const currentChatModel =
			settings.chatModels[activeProvider] ?? settings.modelName;
		new Setting(target)
			.setName(t(lang, 'settingsModelName'))
			.setDesc(t(lang, 'settingsModelDesc'))
			.addText((text) => {
				this.modelTextInput = text;
				text.setValue(currentChatModel).onChange(async (value) => {
					const trimmed = value.trim();
					this.host.settings.modelName = trimmed;
					this.host.settings.chatModels = {
						...this.host.settings.chatModels,
						[activeProvider]: trimmed,
					};
					await this.host.saveSettings();
				});
			});
	}

	private renderEmbeddingSpecificSettings(): void {
		if (!this.embeddingFieldsEl) {
			return;
		}
		const target = this.embeddingFieldsEl;
		const settings = this.host.settings;
		const lang = settings.uiLanguage;
		const activeEmb =
			settings.embeddingProvider === 'anthropic'
				? 'ollama'
				: settings.embeddingProvider;

		target.empty();

		const currentEmbModel =
			settings.embeddingModels[activeEmb] ?? settings.embeddingModel;
		new Setting(target)
			.setName(t(lang, 'settingsEmbeddingModelName'))
			.setDesc(t(lang, 'settingsEmbeddingModelDesc'))
			.addText((text) => {
				text.setValue(currentEmbModel).onChange(async (value) => {
					const trimmed = value.trim();
					this.host.settings.embeddingModel = trimmed;
					this.host.settings.embeddingModels = {
						...this.host.settings.embeddingModels,
						[activeEmb]: trimmed,
					};
					await this.host.saveSettings();
				});
			});
	}

	private addUnifiedApiKeySetting(
		containerEl: HTMLElement,
		provider: Exclude<LlmProviderId, 'ollama'>,
	): void {
		const lang = this.host.settings.uiLanguage;
		new Setting(containerEl)
			.setName(t(lang, 'settingsApiKeyName'))
			.setDesc(
				formatMessage(t(lang, 'settingsApiKeyDesc'), {
					provider: PROVIDER_LABELS[provider],
				}),
			)
			.addText((text) => {
				text.inputEl.type = 'password';
				text.setPlaceholder(t(lang, 'settingsApiKeyPlaceholder'))
					.setValue(this.host.settings.apiKeys[provider] ?? '')
					.onChange(async (value) => {
						this.host.settings.apiKeys = {
							...this.host.settings.apiKeys,
							[provider]: value.trim(),
						};
						await this.host.saveSettings();
					});
			});
	}

	private async refreshOllamaModels(): Promise<void> {
		const lang = this.host.settings.uiLanguage;
		try {
			const models = await fetchOllamaModels(this.host.settings.ollamaUrl);
			this.detectedOllamaModels = models;
			new Notice(
				formatMessage(t(lang, 'settingsModelsLoadedNotice'), {
					count: models.length,
				}),
			);
			this.renderProviderSpecificSettings();
		} catch (error) {
			new Notice(
				formatLlmError(error, lang, 'ollama', {
					ollamaUrl: this.host.settings.ollamaUrl,
				}),
			);
		}
	}
}
