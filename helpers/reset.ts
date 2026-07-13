import ObsidianGoogleDrive from "main";
import { batchAsyncs, foldersToBatches, getSyncMessage } from "./drive";
import {
	Notice,
	TAbstractFile,
	TFile,
	TFolder,
	Modal,
	Setting,
} from "obsidian";
import { pull } from "./pull";

export class ConfirmResetModal extends Modal {
	proceed: (res: boolean) => void;
	constructor(t: ObsidianGoogleDrive, proceed: (res: boolean) => void) {
		super(t.app);
		this.proceed = proceed;

		this.setTitle(
			"Are you sure you want to reset the data from Google Drive?"
		);
		this.setContent(
			"You'll loose all the local changes to your data and load only the information on your google drive. This step is irreversible."
		);
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("RESET!")
					.setWarning()
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

export const reset = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) return;

	const proceed = await new Promise<boolean>((resolve) => {
		new ConfirmResetModal(t, resolve).open();
	});
	if (!proceed) return;

	const syncNotice = await t.startSync();

	await pull(t, true);

	const { vault } = t.app;

	const operations = Object.entries(t.settings.operations);
	const deletes = operations.filter(([_, op]) => op === "delete");
	const creates = operations.filter(([_, op]) => op === "create");
	const modifies = operations.filter(([_, op]) => op === "modify");

	const filePathToId = Object.fromEntries(
		Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
	);

	if (creates.length) {
		await t.drive.deleteFilesMinimumOperations(
			creates
				.map(([path]) => vault.getAbstractFileByPath(path))
				.filter(
					(file) => file instanceof TAbstractFile
				) as TAbstractFile[]
		);
	}

	syncNotice.setMessage("Syncing (33%)");

	if (modifies.length) {
		let completed = 0;
		const files = modifies
			.map(([path]) => vault.getFileByPath(path))
			.filter((file) => file instanceof TFile) as TFile[];
		await batchAsyncs(
			files.map((file) => async () => {
				const [onlineFile, metadata] = await Promise.all([
					t.drive.getFile(filePathToId[file.path]).arrayBuffer(),
					t.drive.getFileMetadata(filePathToId[file.path]),
				]);
				if (!onlineFile || !metadata) {
					return new Notice(
						"An error occurred fetching Google Drive files."
					);
				}

				completed++;
				syncNotice.setMessage(
					getSyncMessage(33, 66, completed, files.length)
				);
				return t.modifyFile(file, onlineFile, metadata.modifiedTime);
			})
		);
	}

	if (deletes.length) {
		// Locally-deleted paths are restored from Drive using the snapshot the
		// leading pull just rebuilt (it carries each item's id, type and mtime).
		const pathToEntry: Record<
			string,
			{ id: string; isFolder: boolean; modifiedTime: string }
		> = {};
		Object.entries(t.settings.driveSnapshot).forEach(([id, entry]) => {
			pathToEntry[entry.path] = {
				id,
				isFolder: entry.isFolder,
				modifiedTime: entry.modifiedTime,
			};
		});

		const deletedFolders = deletes.filter(
			([path]) => pathToEntry[path]?.isFolder
		);

		if (deletedFolders.length) {
			const batches = foldersToBatches(
				deletedFolders.map(([path]) => path)
			);

			for (const batch of batches) {
				await Promise.all(
					batch.map((folder) => t.createFolder(folder))
				);
			}
		}

		let completed = 0;

		const deletedFiles = deletes.filter(
			([path]) => pathToEntry[path] && !pathToEntry[path].isFolder
		);

		await batchAsyncs(
			deletedFiles.map(([path]) => async () => {
				const onlineFile = await t.drive
					.getFile(pathToEntry[path].id)
					.arrayBuffer();
				if (!onlineFile) {
					return new Notice(
						"An error occurred fetching Google Drive files."
					);
				}
				completed++;
				syncNotice.setMessage(
					getSyncMessage(66, 99, completed, deletedFiles.length)
				);
				return t.createFile(
					path,
					onlineFile,
					pathToEntry[path].modifiedTime
				);
			})
		);
	}

	t.settings.operations = {};

	await t.endSync(syncNotice);

	new Notice("Reset complete.");
};
