import ObsidianGoogleDrive from "main";
import { Notice, TAbstractFile, TFile } from "obsidian";
import {
	batchAsyncs,
	DriveTree,
	DriveTreeNode,
	foldersToBatches,
	getSyncMessage,
	isSyncableConfigFile,
	snapshotFromTree,
} from "./drive";
import { refreshAccessToken } from "./ky";

const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";

/**
 * Pulls the vault down from Google Drive by walking the Drive folder tree and
 * diffing it (by stable Drive file id) against the snapshot from the previous
 * sync. This works for folders populated by ANY means (including Google Drive
 * for Desktop) because identity comes from the tree, not from plugin-specific
 * `properties`.
 *
 * @returns false if the sync was aborted before making changes, true otherwise.
 */
export const pull = async (
	t: ObsidianGoogleDrive,
	silenceNotices?: boolean
): Promise<boolean> => {
	let syncNotice: any = null;

	if (!silenceNotices) {
		if (t.syncing) return false;
		syncNotice = await t.startSync();
	}

	const { vault } = t.app;
	const { adapter } = vault;
	const configDir = vault.configDir;

	if (!t.accessToken.token) await refreshAccessToken(t);

	const rootId = await t.drive.getRootFolderId();
	if (!rootId) {
		// getRootFolderId already surfaced a Notice explaining why.
		if (!silenceNotices) await t.endSync(syncNotice);
		return false;
	}

	let tree: DriveTree;
	try {
		tree = await t.drive.buildDriveTree(rootId);
	} catch (e) {
		new Notice(
			"Couldn't fully read your Google Drive folder, so the sync was aborted. Nothing on your device was changed - please try again."
		);
		if (!silenceNotices) await t.endSync(syncNotice);
		return false;
	}

	const isConfigPath = (path: string) =>
		path === configDir || path.startsWith(configDir + "/");

	const prev = t.settings.driveSnapshot || {};
	const nodes = Object.values(tree).filter((node) => node.path !== "");
	const newById: Record<string, DriveTreeNode> = Object.fromEntries(
		nodes.map((node) => [node.id, node])
	);

	const mtime = (value?: string) => new Date(value || 0).getTime();

	// ---- Diff by id. A rename/move (same id, new path) is handled as a
	// vacate-old + download-new so we only rely on existing operation-suppressing
	// helpers (no local id map to move by). ----
	const removePaths: { path: string; isFolder: boolean }[] = [];
	const createNodes: DriveTreeNode[] = [];
	const modifyNodes: DriveTreeNode[] = [];

	for (const node of nodes) {
		const before = prev[node.id];
		if (!before) {
			createNodes.push(node);
		} else if (before.path !== node.path) {
			removePaths.push({ path: before.path, isFolder: before.isFolder });
			createNodes.push(node);
		} else if (!node.isFolder && mtime(node.modifiedTime) > mtime(before.modifiedTime)) {
			modifyNodes.push(node);
		}
	}
	for (const [id, entry] of Object.entries(prev)) {
		if (!newById[id]) {
			removePaths.push({ path: entry.path, isFolder: entry.isFolder });
		}
	}

	// ---- Safety threshold: a truncated tree or a wrong root must never trigger
	// a mass local deletion. ----
	const prevCount = Object.keys(prev).length;
	if (prevCount > 10 && removePaths.length > prevCount * 0.5) {
		new Notice(
			`Sync aborted: Google Drive reports ${removePaths.length} of ${prevCount} tracked items as gone, which looks wrong. Nothing was deleted locally. If this is intentional, use "Reset from Drive".`,
			0
		);
		if (!silenceNotices) await t.endSync(syncNotice);
		return false;
	}

	const nothingToDo =
		!removePaths.length && !createNodes.length && !modifyNodes.length;

	// True when the vault has a pending unsynced create/modify at or under `path`.
	const isProtected = (path: string) =>
		Object.entries(t.settings.operations).some(
			([opPath, op]) =>
				(op === "create" || op === "modify") &&
				(opPath === path || opPath.startsWith(path + "/"))
		);

	const ensureConfigDir = async (filePath: string) => {
		const parts = filePath.split("/");
		for (let i = 1; i < parts.length; i++) {
			const dir = parts.slice(0, i).join("/");
			if (!(await adapter.exists(dir))) {
				try {
					await adapter.mkdir(dir);
				} catch {
					// A concurrent create is fine; a real failure surfaces when
					// the file write below fails.
				}
			}
		}
	};

	syncNotice?.setMessage("Syncing (10%)");

	// ---- 1. Removals (deletes + rename sources). Regular vault content honors
	// local prioritization; config is mirrored directly (no vault operations
	// are tracked for the config dir). ----
	const toTrash: TAbstractFile[] = [];
	for (const { path, isFolder } of removePaths) {
		if (isConfigPath(path)) {
			if (isFolder) {
				if (await adapter.exists(path)) {
					// Only remove if empty, so a folder still holding blacklisted
					// or other kept files is preserved.
					try {
						await adapter.rmdir(path, false);
					} catch {}
				}
			} else if (
				isSyncableConfigFile(t, path) &&
				(await adapter.exists(path))
			) {
				try {
					await adapter.remove(path);
				} catch {}
			}
			continue;
		}

		const op = t.settings.operations[path];
		if (op === "delete") {
			// Both sides deleted it; clear the pending push.
			delete t.settings.operations[path];
			continue;
		}
		const local = vault.getAbstractFileByPath(path);
		if (!local) continue;
		if (local instanceof TFile && op === "modify") {
			// Edited locally, deleted remotely -> keep local, re-create on push.
			t.settings.operations[path] = "create";
			continue;
		}
		if (isFolder && isProtected(path)) {
			// Folder holds unsynced local content; keep it. Its non-protected
			// children are separate removal entries and handled individually.
			continue;
		}
		toTrash.push(local);
	}
	if (toTrash.length) {
		await t.drive.deleteFilesMinimumOperations(toTrash);
	}

	// ---- 2. Create missing vault folders, shallowest first, so files have a
	// parent to land in. (Config folders are created on demand per file.) ----
	const folderPaths = createNodes
		.filter((node) => node.isFolder && !isConfigPath(node.path))
		.map((node) => node.path);
	if (folderPaths.length) {
		const batches = foldersToBatches(folderPaths);
		for (const batch of batches) {
			await Promise.all(
				batch.map(async (folder) => {
					if (
						vault.getFolderByPath(folder) ||
						(await adapter.exists(folder))
					) {
						return;
					}
					return t.createFolder(folder);
				})
			);
		}
	}

	// ---- 3. Download file contents. `isModify` marks a genuine remote change
	// to a file we already tracked; the rest are first-seen creates. ----
	const downloads: { node: DriveTreeNode; isModify: boolean }[] = [
		...createNodes
			.filter((node) => !node.isFolder)
			.map((node) => ({ node, isModify: false })),
		...modifyNodes.map((node) => ({ node, isModify: true })),
	];

	const downloadOne = async (node: DriveTreeNode, isModify: boolean) => {
		const path = node.path;

		// Google Docs/Sheets/etc. have no downloadable bytes via alt=media.
		if (node.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
			new Notice(
				`Skipped "${path}" - Google-format files can't be synced to a local file.`
			);
			return;
		}

		const isConfig = isConfigPath(path);
		if (isConfig && !isSyncableConfigFile(t, path)) return;

		const localFile = isConfig ? null : vault.getFileByPath(path);
		if (!isConfig) {
			const localExists = localFile || (await adapter.exists(path));
			const op = t.settings.operations[path];
			if (localExists) {
				// Local prioritization: an unsynced local change wins.
				if (op === "modify") return;
				if (op === "create") {
					// Both sides created this path; keep local and push it up.
					t.settings.operations[path] = "modify";
					return;
				}
				if (!isModify) {
					// First time we've seen this Drive id and a local file
					// already exists with no pending change (e.g. a Google Drive
					// for Desktop mirror): adopt the local copy as-is. No
					// download, no re-push - assumed already in sync.
					return;
				}
				// isModify with no local op -> Drive is authoritative; overwrite.
			}
		}

		const content = await t.drive.getFile(node.id).arrayBuffer();

		// A failed download comes back as an empty body (the response hook
		// swallows HTTP errors). Never overwrite an existing non-empty local
		// file with empty content - that corrupts files and, for plugin code,
		// can disable the plugin.
		if (content.byteLength === 0) {
			const stat = await adapter.stat(path);
			if (stat && stat.size > 0) {
				new Notice(
					`Skipped "${path}" - the download came back empty (possible network error). Left the local file untouched.`
				);
				return;
			}
		}

		if (isConfig) {
			await ensureConfigDir(path);
			return t.upsertFile(path, content, node.modifiedTime);
		}
		if (localFile instanceof TFile) {
			return t.modifyFile(localFile, content, node.modifiedTime);
		}
		return t.upsertFile(path, content, node.modifiedTime);
	};

	let completed = 0;
	await batchAsyncs(
		downloads.map(({ node, isModify }) => async () => {
			await downloadOne(node, isModify);
			completed++;
			syncNotice?.setMessage(
				getSyncMessage(40, 100, completed, downloads.length)
			);
		})
	);

	// ---- 4. Persist the new snapshot (and the derived id->path map) so the
	// next sync diffs against reality. ----
	const { driveSnapshot, driveIdToPath } = snapshotFromTree(tree);
	t.settings.driveSnapshot = driveSnapshot;
	t.settings.driveIdToPath = driveIdToPath;

	if (silenceNotices) return true;

	await t.endSync(syncNotice);
	new Notice(
		nothingToDo
			? "You're up to date!"
			: "Files have been synced from Google Drive!"
	);
	return true;
};
