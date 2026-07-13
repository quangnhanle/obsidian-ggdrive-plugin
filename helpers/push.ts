import ObsidianGoogleDrive from "main";
import { Modal, Notice, setIcon, Setting, TFile, TFolder } from "obsidian";
import {
	batchAsyncs,
	fileNameFromPath,
	foldersToBatches,
	getSyncMessage,
	isSyncableConfigFile,
	snapshotFromTree,
} from "./drive";
import { pull } from "./pull";

class ConfirmPushModal extends Modal {
	proceed: (res: boolean) => void;

	constructor(
		t: ObsidianGoogleDrive,
		initialOperations: [string, "create" | "delete" | "modify"][],
		proceed: (res: boolean) => void
	) {
		super(t.app);
		this.proceed = proceed;

		this.setTitle("Push confirmation");
		this.contentEl
			.createEl("p")
			.setText(
				"Do you want to push the following changes to Google Drive:"
			);
		const container = this.contentEl.createEl("div");

		const render = (operations: typeof initialOperations) => {
			container.empty();
			operations.map(([path, op]) => {
				const div = container.createDiv();
				div.addClass("operation-container");

				const p = div.createEl("p");
				p.createEl("b").setText(`${op[0].toUpperCase()}${op.slice(1)}`);
				p.createSpan().setText(`: ${path}`);

				if (
					op === "delete" &&
					operations.some(([file]) => path.startsWith(file + "/"))
				) {
					return;
				}

				const btn = div.createDiv().createEl("button");
				setIcon(btn, "trash-2");
				btn.onclick = async () => {
					const nestedFiles = operations
						.map(([file]) => file)
						.filter(
							(file) =>
								file.startsWith(path + "/") || file === path
						);
					const proceed = await new Promise<boolean>((resolve) => {
						new ConfirmUndoModal(
							t,
							op,
							nestedFiles,
							resolve
						).open();
					});

					if (!proceed) return;

					nestedFiles.forEach(
						(file) => delete t.settings.operations[file]
					);
					const newOperations = operations.filter(
						([file]) => !nestedFiles.includes(file)
					);
					if (!newOperations.length) return this.close();
					render(newOperations);
				};
			});
		};

		render(initialOperations);

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setCta()
					.onClick(() => {
						proceed(true);
						this.close();
					})
			);
	}

	onClose() {
		this.proceed(false);
	}
}

class ConfirmUndoModal extends Modal {
	proceed: (res: boolean) => void;
	t: ObsidianGoogleDrive;
	filePathToId: Record<string, string>;

	constructor(
		t: ObsidianGoogleDrive,
		operation: "create" | "delete" | "modify",
		files: string[],
		proceed: (res: boolean) => void
	) {
		super(t.app);
		this.t = t;
		this.filePathToId = Object.fromEntries(
			Object.entries(this.t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			])
		);

		const operationMap = {
			create: "creating",
			delete: "deleting",
			modify: "modifying",
		};

		this.setTitle("Undo confirmation");
		this.contentEl
			.createEl("p")
			.setText(
				`Are you sure you want to undo ${operationMap[operation]} the following file(s):`
			);
		this.contentEl.createEl("ul").append(
			...files.map((file) => {
				const li = this.contentEl.createEl("li");
				li.addClass("operation-file");
				li.setText(file);
				return li;
			})
		);
		this.proceed = proceed;
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						if (operation === "delete") {
							await this.handleDelete(files);
						}
						if (operation === "create") {
							await this.handleCreate(files[0]);
						}
						if (operation === "modify") {
							await this.handleModify(files[0]);
						}
						proceed(true);
						this.close();
					})
			);
	}

	onClose() {
		this.proceed(false);
	}

	async handleDelete(paths: string[]) {
		// Restore locally-deleted files from Drive using the last snapshot,
		// which carries each Drive id, type and modified time.
		const snapshot = this.t.settings.driveSnapshot;
		const pathToEntry: Record<
			string,
			{ id: string; isFolder: boolean; modifiedTime: string }
		> = {};
		Object.entries(snapshot).forEach(([id, entry]) => {
			if (paths.includes(entry.path)) {
				pathToEntry[entry.path] = {
					id,
					isFolder: entry.isFolder,
					modifiedTime: entry.modifiedTime,
				};
			}
		});

		const deletedFolders = paths.filter(
			(path) => pathToEntry[path]?.isFolder
		);
		if (deletedFolders.length) {
			const batches = foldersToBatches(deletedFolders);
			for (const batch of batches) {
				await Promise.all(
					batch.map((folder) => this.t.createFolder(folder))
				);
			}
		}

		const deletedFiles = paths.filter(
			(path) => pathToEntry[path] && !pathToEntry[path].isFolder
		);

		await batchAsyncs(
			deletedFiles.map((path) => async () => {
				const onlineFile = await this.t.drive
					.getFile(pathToEntry[path].id)
					.arrayBuffer();
				if (!onlineFile) {
					return new Notice(
						"An error occurred fetching Google Drive files."
					);
				}
				return this.t.createFile(
					path,
					onlineFile,
					pathToEntry[path].modifiedTime
				);
			})
		);
	}

	async handleCreate(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) return;
		return this.t.deleteFile(file);
	}

	async handleModify(path: string) {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;

		const [onlineFile, metadata] = await Promise.all([
			this.t.drive.getFile(this.filePathToId[path]).arrayBuffer(),
			this.t.drive.getFileMetadata(this.filePathToId[path]),
		]);
		if (!onlineFile || !metadata) {
			return new Notice("An error occurred fetching Google Drive files.");
		}
		return this.t.modifyFile(file, onlineFile, metadata.modifiedTime);
	}
}

export const push = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) return;
	const initialOperations = Object.entries(t.settings.operations).sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
	); // Alphabetical

	const { vault } = t.app;
	const adapter = vault.adapter;

	const proceed = await new Promise<boolean>((resolve) => {
		new ConfirmPushModal(t, initialOperations, resolve).open();
	});

	if (!proceed) return;

	const syncNotice = await t.startSync();

	// Pull first so we're pushing on top of the latest Drive state. If the pull
	// aborted (e.g. the root folder couldn't be resolved), don't push blindly.
	const pulled = await pull(t, true);
	if (!pulled) {
		await t.endSync(syncNotice, false);
		return;
	}

	const operations = Object.entries(t.settings.operations);

	const deletes = operations.filter(([_, op]) => op === "delete");
	const creates = operations.filter(([_, op]) => op === "create");
	const modifies = operations.filter(([_, op]) => op === "modify");

	const pathsToIds = Object.fromEntries(
		Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
	);

	// Config files that still exist on Drive (per the snapshot) but were removed
	// locally should be deleted on Drive too.
	Object.values(t.settings.driveSnapshot).forEach((entry) => {
		if (entry.isFolder) return;
		if (!entry.path.startsWith(vault.configDir + "/")) return;
		if (!isSyncableConfigFile(t, entry.path)) return;
		deletes.push([entry.path, "delete"]);
	});
	// The check above only queued paths; drop ones that still exist locally.
	const confirmedDeletes: [string, "delete"][] = [];
	await Promise.all(
		deletes.map(async ([path]) => {
			if (
				path.startsWith(vault.configDir + "/") &&
				(await adapter.exists(path))
			) {
				return;
			}
			confirmedDeletes.push([path, "delete"]);
		})
	);

	if (confirmedDeletes.length) {
		const ids = confirmedDeletes
			.map(([path]) => pathsToIds[path])
			.filter(Boolean);
		if (ids.length) {
			const deleteRequest = await t.drive.batchDelete(ids);
			if (!deleteRequest) {
				return new Notice(
					"An error occurred deleting Google Drive files."
				);
			}
		}
	}

	syncNotice.setMessage("Syncing (33%)");

	if (creates.length) {
		let completed = 0;
		const files = creates.map(([path]) =>
			vault.getAbstractFileByPath(path)
		);

		const folders = files.filter(
			(file) => file instanceof TFolder
		) as TFolder[];

		if (folders.length) {
			const batches = foldersToBatches(folders);

			for (const batch of batches) {
				await batchAsyncs(
					batch.map((folder) => async () => {
						const id = await t.drive.createFolder({
							name: folder.name,
							parent: folder.parent
								? pathsToIds[folder.parent.path]
								: undefined,
							modifiedTime: new Date().toISOString(),
						});
						if (!id) {
							return new Notice(
								"An error occurred creating Google Drive folders."
							);
						}

						completed++;
						syncNotice.setMessage(
							getSyncMessage(33, 66, completed, files.length)
						);

						t.settings.driveIdToPath[id] = folder.path;
						pathsToIds[folder.path] = id;
					})
				);
			}
		}

		const notes = files.filter((file) => file instanceof TFile) as TFile[];

		await batchAsyncs(
			notes.map((note) => async () => {
				const id = await t.drive.uploadFile(
					new Blob([await vault.readBinary(note)]),
					note.name,
					note.parent ? pathsToIds[note.parent.path] : undefined,
					{ modifiedTime: new Date().toISOString() }
				);
				if (!id) {
					return new Notice(
						"An error occurred creating Google Drive files."
					);
				}

				completed++;
				syncNotice.setMessage(
					getSyncMessage(33, 66, completed, files.length)
				);

				t.settings.driveIdToPath[id] = note.path;
			})
		);
	}

	if (modifies.length) {
		let completed = 0;

		const files = modifies
			.map(([path]) => vault.getFileByPath(path))
			.filter((file) => file instanceof TFile) as TFile[];

		const pathToId = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			])
		);

		await batchAsyncs(
			files.map((file) => async () => {
				const id = await t.drive.updateFile(
					pathToId[file.path],
					new Blob([await vault.readBinary(file)]),
					{ modifiedTime: new Date().toISOString() }
				);
				if (!id) {
					return new Notice(
						"An error occurred modifying Google Drive files."
					);
				}

				completed++;
				syncNotice.setMessage(
					getSyncMessage(66, 99, completed, files.length)
				);
			})
		);
	}

	const configFilesToSync = await t.drive.getConfigFilesToSync();

	const foldersToCreate = new Set<string>();
	configFilesToSync.forEach((path) => {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			foldersToCreate.add(parts.slice(0, i).join("/"));
		}
	});

	foldersToCreate.forEach((folder) => {
		if (pathsToIds[folder]) foldersToCreate.delete(folder);
	});

	if (foldersToCreate.size) {
		const batches = foldersToBatches(Array.from(foldersToCreate));

		for (const batch of batches) {
			await batchAsyncs(
				batch.map((folder) => async () => {
					const id = await t.drive.createFolder({
						name: folder.split("/").pop() || "",
						parent: pathsToIds[
							folder.split("/").slice(0, -1).join("/")
						],
						modifiedTime: new Date().toISOString(),
					});
					if (!id) {
						return new Notice(
							"An error occurred creating Google Drive folders."
						);
					}

					t.settings.driveIdToPath[id] = folder;
					pathsToIds[folder] = id;
				})
			);
		}
	}

	await batchAsyncs(
		configFilesToSync.map((path) => async () => {
			if (pathsToIds[path]) {
				await t.drive.updateFile(
					pathsToIds[path],
					new Blob([await adapter.readBinary(path)]),
					{ modifiedTime: new Date().toISOString() }
				);
				return;
			}

			const id = await t.drive.uploadFile(
				new Blob([await adapter.readBinary(path)]),
				fileNameFromPath(path),
				pathsToIds[path.split("/").slice(0, -1).join("/")],
				{ modifiedTime: new Date().toISOString() }
			);
			if (!id) {
				return new Notice(
					"An error occurred creating Google Drive config files."
				);
			}

			t.settings.driveIdToPath[id] = path;
			pathsToIds[path] = id;
		})
	);

	// Re-walk the tree so the snapshot reflects the files we just created and
	// modified (new ids + fresh modified times). Without this the next pull
	// would see every pushed file as a remote change and re-download it.
	const rootId = await t.drive.getRootFolderId();
	if (rootId) {
		try {
			const tree = await t.drive.buildDriveTree(rootId);
			const { driveSnapshot, driveIdToPath } = snapshotFromTree(tree);
			t.settings.driveSnapshot = driveSnapshot;
			t.settings.driveIdToPath = driveIdToPath;
		} catch {
			// Leave the pre-push snapshot in place; the next pull reconciles.
		}
	}

	t.settings.operations = {};

	await t.endSync(syncNotice, false);

	new Notice("Sync complete!");
};
