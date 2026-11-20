import { normalizePath, TFile, type App, type TAbstractFile } from 'obsidian';
import {
	loadLoreIgnoreFromAdapter,
	parseLoreIgnore,
} from '../config/loreIgnore';
import { computeDegrees, computeGraphStats } from '../core/graphAlgo';
import type {
	GraphEdge,
	GraphNode,
	GraphStats,
	PluginSettings,
} from '../types';
import type { GraphStorage } from './storage';
import { buildVaultEdges, parseVaultNote } from './vaultParser';

const SYNC_BATCH_SIZE = 40;

export interface SyncResult {
	totalNodes: number;
	totalEdges: number;
	updatedCount: number;
}

function yieldToUi(): Promise<void> {
	return new Promise<void>((resolve) => {
		window.setTimeout(resolve, 0);
	});
}

function stripMdExtension(path: string): string {
	const name = path.split('/').pop() ?? path;
	return name.endsWith('.md') ? name.slice(0, -3) : name;
}

/**
 * In-memory knowledge graph manager with cheap dirty-tracking and
 * on-demand incremental synchronization backed by IndexedDB cache.
 */
export class GraphIndex {
	private readonly app: App;
	private readonly storage: GraphStorage;
	private getSettings: () => PluginSettings;

	private nodesMap = new Map<string, GraphNode>();
	private edges: GraphEdge[] = [];
	private dirtyPaths = new Set<string>();
	private lastIgnoreRaw = '';
	private isSyncing = false;
	private dirtyListeners = new Set<(dirtyCount: number) => void>();

	constructor(
		app: App,
		storage: GraphStorage,
		getSettings: () => PluginSettings,
	) {
		this.app = app;
		this.storage = storage;
		this.getSettings = getSettings;
	}

	onDirtyChange(listener: (dirtyCount: number) => void): () => void {
		this.dirtyListeners.add(listener);
		return () => {
			this.dirtyListeners.delete(listener);
		};
	}

	private emitDirtyCount(): void {
		const count = this.getDirtyCount();
		for (const listener of this.dirtyListeners) {
			listener(count);
		}
	}

	/**
	 * Loads the cached snapshot from IndexedDB (if present) and marks
	 * files whose mtime changed (or new/unindexed files) as dirty without
	 * running full parsing at startup.
	 */
	async initialize(): Promise<void> {
		let snapshot = null;
		try {
			snapshot = await this.storage.loadSnapshot();
		} catch {
			snapshot = null;
		}

		const markdownFiles = this.app.vault.getMarkdownFiles();
		const currentFilesByPath = new Map<string, TFile>();
		for (const file of markdownFiles) {
			currentFilesByPath.set(file.path, file);
		}

		if (snapshot) {
			this.nodesMap.clear();
			for (const node of snapshot.nodes) {
				if (currentFilesByPath.has(node.id)) {
					this.nodesMap.set(node.id, node);
				}
			}

			const validIds = new Set(this.nodesMap.keys());
			this.edges = snapshot.edges.filter(
				(edge) => validIds.has(edge.sourceId) && validIds.has(edge.targetId),
			);
			this.lastIgnoreRaw = snapshot.ignoreRaw ?? '';

			for (const file of markdownFiles) {
				const cached = this.nodesMap.get(file.path);
				if (!cached || cached.mtime !== file.stat.mtime) {
					this.dirtyPaths.add(file.path);
					if (cached) {
						cached.isDirty = true;
					}
				}
			}
		} else {
			for (const file of markdownFiles) {
				this.dirtyPaths.add(file.path);
			}
		}

		this.emitDirtyCount();
	}

	markFileDirty(file: TAbstractFile): void {
		if (file.path === '.loreignore') {
			for (const existingPath of this.nodesMap.keys()) {
				this.dirtyPaths.add(existingPath);
			}
			for (const mdFile of this.app.vault.getMarkdownFiles()) {
				this.dirtyPaths.add(mdFile.path);
			}
			this.emitDirtyCount();
			return;
		}

		if (!(file instanceof TFile) || file.extension !== 'md') {
			return;
		}

		this.dirtyPaths.add(file.path);
		const existing = this.nodesMap.get(file.path);
		if (existing) {
			existing.isDirty = true;
		}
		this.emitDirtyCount();
	}

	handleFileCreate(file: TAbstractFile): void {
		this.markFileDirty(file);
	}

	handleFileDelete(file: TAbstractFile): void {
		if (file.path === '.loreignore') {
			this.markFileDirty(file);
			return;
		}

		const removed = this.nodesMap.delete(file.path);
		this.dirtyPaths.delete(file.path);

		if (removed) {
			const affectedNeighbors = new Set<string>();
			this.edges = this.edges.filter((edge) => {
				if (edge.sourceId === file.path) {
					affectedNeighbors.add(edge.targetId);
					return false;
				}
				if (edge.targetId === file.path) {
					affectedNeighbors.add(edge.sourceId);
					return false;
				}
				return true;
			});

			for (const neighborId of affectedNeighbors) {
				const neighbor = this.nodesMap.get(neighborId);
				if (neighbor) {
					neighbor.isDirty = true;
					this.dirtyPaths.add(neighborId);
				}
			}

			this.recomputeDegreesInPlace();
		}

		this.emitDirtyCount();
	}

	handleFileRename(file: TAbstractFile, oldPath: string): void {
		if (oldPath === '.loreignore' || file.path === '.loreignore') {
			this.markFileDirty(file);
			return;
		}

		const existing = this.nodesMap.get(oldPath);
		this.dirtyPaths.delete(oldPath);

		if (!(file instanceof TFile) || file.extension !== 'md') {
			if (existing) {
				this.nodesMap.delete(oldPath);
				this.edges = this.edges.filter(
					(edge) =>
						edge.sourceId !== oldPath && edge.targetId !== oldPath,
				);
				this.recomputeDegreesInPlace();
			}
			this.emitDirtyCount();
			return;
		}

		if (existing) {
			this.nodesMap.delete(oldPath);
			existing.id = file.path;
			existing.title = stripMdExtension(file.path);
			existing.isDirty = true;
			this.nodesMap.set(file.path, existing);
		}

		const incidentNeighbors = new Set<string>();
		this.edges = this.edges.map((edge) => {
			let updated = edge;
			if (edge.sourceId === oldPath) {
				updated = { ...updated, sourceId: file.path };
				incidentNeighbors.add(edge.targetId);
			}
			if (edge.targetId === oldPath) {
				updated = { ...updated, targetId: file.path };
				incidentNeighbors.add(edge.sourceId);
			}
			return updated;
		});

		for (const neighborId of incidentNeighbors) {
			if (neighborId === file.path) {
				continue;
			}
			const neighbor = this.nodesMap.get(neighborId);
			if (neighbor) {
				neighbor.isDirty = true;
				this.dirtyPaths.add(neighborId);
			}
		}

		this.dirtyPaths.add(file.path);
		this.emitDirtyCount();
	}

	private recomputeDegreesInPlace(): void {
		const updated = computeDegrees(
			Array.from(this.nodesMap.values()),
			this.edges,
		);
		this.nodesMap.clear();
		for (const node of updated) {
			this.nodesMap.set(node.id, node);
		}
	}

	/**
	 * Performs on-demand synchronization of dirty notes (or a full rebuild if
	 * `forceFull` is true or `.loreignore` changed) and persists to IndexedDB.
	 */
	async sync(forceFull = false): Promise<SyncResult> {
		if (this.isSyncing) {
			return {
				totalNodes: this.nodesMap.size,
				totalEdges: this.edges.length,
				updatedCount: 0,
			};
		}

		this.isSyncing = true;
		try {
			const settings = this.getSettings();
			const { raw: ignoreRaw, rules: ignoreRules } =
				await loadLoreIgnoreFromAdapter(
					this.app.vault.adapter,
					normalizePath('.loreignore'),
				);

			const ignoreChanged = ignoreRaw !== this.lastIgnoreRaw;
			const shouldFullRebuild =
				forceFull || ignoreChanged || this.nodesMap.size === 0;

			let updatedCount = 0;

			if (shouldFullRebuild) {
				const files = this.app.vault.getMarkdownFiles();
				const nextMap = new Map<string, GraphNode>();

				for (let i = 0; i < files.length; i++) {
					const file = files[i];
					if (!file) {
						continue;
					}
					const parsed = await parseVaultNote(
						this.app,
						file,
						settings,
						ignoreRules,
					);
					if (parsed) {
						nextMap.set(parsed.id, parsed);
					}
					updatedCount += 1;

					if ((i + 1) % SYNC_BATCH_SIZE === 0) {
						await yieldToUi();
					}
				}

				this.nodesMap = nextMap;
				this.dirtyPaths.clear();
			} else {
				const validFiles = new Set(
					this.app.vault.getMarkdownFiles().map((f) => f.path),
				);
				for (const existingPath of Array.from(this.nodesMap.keys())) {
					if (!validFiles.has(existingPath)) {
						this.nodesMap.delete(existingPath);
					}
				}

				const pathsToProcess = Array.from(this.dirtyPaths);
				this.dirtyPaths.clear();

				const activeIgnoreRules = parseLoreIgnore(ignoreRaw);

				for (let i = 0; i < pathsToProcess.length; i++) {
					const path = pathsToProcess[i];
					if (!path) {
						continue;
					}
					const abstractFile =
						this.app.vault.getAbstractFileByPath(path);
					if (
						abstractFile instanceof TFile &&
						abstractFile.extension === 'md'
					) {
						const parsed = await parseVaultNote(
							this.app,
							abstractFile,
							settings,
							activeIgnoreRules,
						);
						if (parsed) {
							this.nodesMap.set(parsed.id, parsed);
						} else {
							this.nodesMap.delete(path);
						}
					} else {
						this.nodesMap.delete(path);
					}
					updatedCount += 1;

					if ((i + 1) % SYNC_BATCH_SIZE === 0) {
						await yieldToUi();
					}
				}
			}

			const validNodeIds = new Set(this.nodesMap.keys());
			this.edges = buildVaultEdges(this.app, validNodeIds);
			this.recomputeDegreesInPlace();
			for (const node of this.nodesMap.values()) {
				node.isDirty = false;
			}

			this.lastIgnoreRaw = ignoreRaw;
			const nodesSnapshot = this.getNodes();
			await this.storage.saveSnapshot(
				nodesSnapshot,
				this.edges,
				ignoreRaw,
			);
			this.emitDirtyCount();

			return {
				totalNodes: nodesSnapshot.length,
				totalEdges: this.edges.length,
				updatedCount,
			};
		} finally {
			this.isSyncing = false;
		}
	}

	getDirtyCount(): number {
		return this.dirtyPaths.size;
	}

	getNode(id: string): GraphNode | undefined {
		return this.nodesMap.get(id);
	}

	/**
	 * Immediately re-parses a single markdown file (optionally merging fresh
	 * frontmatter overrides) and updates both the in-memory graph and IndexedDB cache.
	 */
	async refreshSingleFile(
		file: TFile,
		frontmatterOverrides?: Record<string, unknown>,
	): Promise<GraphNode | null> {
		let ignoreRules = parseLoreIgnore(this.lastIgnoreRaw);
		if (!this.lastIgnoreRaw) {
			const loaded = await loadLoreIgnoreFromAdapter(
				this.app.vault.adapter,
				normalizePath('.loreignore'),
			);
			this.lastIgnoreRaw = loaded.raw;
			ignoreRules = loaded.rules;
		}

		const parsed = await parseVaultNote(
			this.app,
			file,
			this.getSettings(),
			ignoreRules,
			frontmatterOverrides,
		);

		if (parsed) {
			this.nodesMap.set(parsed.id, { ...parsed, isDirty: false });
		} else {
			this.nodesMap.delete(file.path);
		}
		this.dirtyPaths.delete(file.path);

		const validNodeIds = new Set(this.nodesMap.keys());
		this.edges = buildVaultEdges(this.app, validNodeIds);
		this.recomputeDegreesInPlace();

		const updated = this.nodesMap.get(file.path) ?? null;
		if (updated) {
			updated.isDirty = false;
		}

		await this.storage.saveSnapshot(
			this.getNodes(),
			this.edges,
			this.lastIgnoreRaw,
		);
		this.emitDirtyCount();

		return updated;
	}

	getNodes(): GraphNode[] {
		return Array.from(this.nodesMap.values()).sort((a, b) =>
			a.id.localeCompare(b.id),
		);
	}

	getEdges(): GraphEdge[] {
		return [...this.edges];
	}

	getStats(): GraphStats {
		const nodes = this.getNodes().map((node) => ({
			...node,
			isDirty: node.isDirty || this.dirtyPaths.has(node.id),
		}));
		const stats = computeGraphStats(nodes, this.edges);
		return {
			...stats,
			dirtyNodes: this.dirtyPaths.size,
		};
	}
}
