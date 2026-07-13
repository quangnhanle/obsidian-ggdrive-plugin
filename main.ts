import { checkConnection, DriveSnapshot, getDriveClient } from "helpers/drive";
import { refreshAccessToken } from "helpers/ky";
import { pull } from "helpers/pull";
import { push } from "helpers/push";
import { reset } from "helpers/reset";
import {
	App,
	debounce,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
	Vault,
	Menu,
} from "obsidian";

interface PluginSettings {
	refreshToken: string;
	operations: Record<string, "create" | "delete" | "modify">;
	driveIdToPath: Record<string, string>;
	lastSyncedAt: number;
	// Pinned id of the vault's root folder on Drive (stable across renames).
	rootFolderId: string;
	// Snapshot of the Drive tree at the previous sync, keyed by Drive file id.
	// Diffing it against a freshly-walked tree drives create/delete/rename/modify.
	driveSnapshot: DriveSnapshot;
}

const DEFAULT_SETTINGS: PluginSettings = {
	refreshToken: "",
	operations: {},
	driveIdToPath: {},
	lastSyncedAt: 0,
	rootFolderId: "",
	driveSnapshot: {},
};

export default class ObsidianGoogleDrive extends Plugin {
	settings: PluginSettings;
	accessToken = {
		token: "",
		expiresAt: 0,
	};
	drive = getDriveClient(this);
	ribbonIcon: HTMLElement;
	syncing: boolean;

	async onload() {
		const { vault } = this.app;

		await this.loadSettings();

		this.addSettingTab(new SettingsTab(this.app, this));

		if (!this.settings.refreshToken) {
			new Notice(
				"Please add your refresh token to Google Drive Sync through our website or our readme/this plugin's settings. If you haven't already, PLEASE read through this plugin's readme or website CAREFULLY for instructions on how to use this plugin. If you don't know what you're doing, your data could get DELETED.",
				0
			);
			return;
		}

		this.ribbonIcon = this.addRibbonIcon(
			"refresh-cw",
			"Obsidian Google Drive",
			(event) => {
				if (this.syncing) return;
				const menu = new Menu();

				menu.addItem((item) =>
					item
						.setTitle("Pull from Drive")
						.setIcon("cloud-download")
						.onClick(() => {
							pull(this);
						})
				);

				menu.addItem((item) =>
					item
						.setTitle("Push to Drive")
						.setIcon("cloud-upload")
						.onClick(() => {
							push(this);
						})
				);
				menu.addItem((item) =>
					item
						.setTitle("Reset from Drive")
						.setIcon("triangle-alert")
						.onClick(() => {
							reset(this);
						})
				);
				menu.showAtMouseEvent(event);
			}
		);

		this.addCommand({
			id: "push",
			name: "Push to Google Drive",
			callback: () => push(this),
		});

		this.addCommand({
			id: "pull",
			name: "Pull from Google Drive",
			callback: () => pull(this),
		});

		this.addCommand({
			id: "reset",
			name: "Reset local vault to Google Drive",
			callback: () => reset(this),
		});

		this.registerEvent(
			this.app.workspace.on("quit", () => this.saveSettings())
		);

		this.app.workspace.onLayoutReady(() =>
			this.registerEvent(vault.on("create", this.handleCreate.bind(this)))
		);
		this.registerEvent(vault.on("delete", this.handleDelete.bind(this)));
		this.registerEvent(vault.on("modify", this.handleModify.bind(this)));
		this.registerEvent(vault.on("rename", this.handleRename.bind(this)));

		checkConnection().then(async (connected) => {
			if (connected) {
				this.syncing = true;
				this.ribbonIcon.addClass("spin");
				await pull(this, true);
				await this.endSync();
			}
		});
	}

	onunload() {
		return this.saveSettings();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	saveSettings() {
		return this.saveData(this.settings);
	}

	debouncedSaveSettings = debounce(this.saveSettings.bind(this), 500, true);

	handleCreate(file: TAbstractFile) {
		if (this.settings.operations[file.path] === "delete") {
			if (file instanceof TFile) {
				this.settings.operations[file.path] = "modify";
			} else {
				delete this.settings.operations[file.path];
			}
		} else {
			this.settings.operations[file.path] = "create";
		}
		this.debouncedSaveSettings();
	}

	handleDelete(file: TAbstractFile) {
		if (this.settings.operations[file.path] === "create") {
			delete this.settings.operations[file.path];
		} else {
			this.settings.operations[file.path] = "delete";
		}
		this.debouncedSaveSettings();
	}

	handleModify(file: TFile) {
		const operation = this.settings.operations[file.path];
		if (operation === "create" || operation === "modify") {
			return;
		}
		this.settings.operations[file.path] = "modify";
		this.debouncedSaveSettings();
	}

	handleRename(file: TAbstractFile, oldPath: string) {
		this.handleDelete({ ...file, path: oldPath } as TAbstractFile);
		this.handleCreate(file);

		// When a folder is renamed/moved, Obsidian fires a single rename event
		// for the folder only — descendants silently receive new paths without
		// their own events. Record each descendant's move so its children are
		// actually pushed (under the new path) and cleaned up (under the old).
		if (file instanceof TFolder) {
			const newPrefix = file.path;
			Vault.recurseChildren(file, (child) => {
				if (child.path === file.path) return;
				const childOldPath =
					oldPath + child.path.slice(newPrefix.length);
				this.handleDelete({
					...child,
					path: childOldPath,
				} as TAbstractFile);
				this.handleCreate(child);
			});
		}

		this.debouncedSaveSettings();
	}

	async createFolder(path: string) {
		const oldOperation = this.settings.operations[path];
		await this.app.vault.createFolder(path);
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async createFile(
		path: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.createBinary(path, content, {
			mtime: modificationDate,
		});
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async modifyFile(
		file: TFile,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[file.path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.modifyBinary(file, content, {
			mtime: modificationDate,
		});
		this.settings.operations[file.path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async upsertFile(
		file: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[file];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.adapter.writeBinary(file, content, {
			mtime: modificationDate,
		});
		this.settings.operations[file] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file];
	}

	async deleteFile(file: TAbstractFile) {
		await this.app.fileManager.trashFile(file);
		// This is a programmatic (pull-driven) delete, so drop any operation the
		// vault's own delete event queued for this path — the file is gone and
		// there is nothing left to push.
		delete this.settings.operations[file.path];
	}

	async startSync() {
		if (!(await checkConnection())) {
			new Notice(
				"You are not connected to the internet, so you cannot sync right now. Please try syncing once you have connection again."
			);
			throw new Error("No internet connection; sync aborted.");
		}
		this.ribbonIcon.addClass("spin");
		this.syncing = true;
		return new Notice("Syncing (0%)", 0);
	}

	async endSync(syncNotice?: Notice, retainConfigChanges = true) {
		if (retainConfigChanges) {
			const configFilesToSync = await this.drive.getConfigFilesToSync();

			this.settings.lastSyncedAt = Date.now();

			await Promise.all(
				configFilesToSync.map(async (file) =>
					this.app.vault.adapter.writeBinary(
						file,
						await this.app.vault.adapter.readBinary(file),
						{ mtime: Date.now() }
					)
				)
			);
		} else {
			this.settings.lastSyncedAt = Date.now();
		}

		await this.saveSettings();
		this.ribbonIcon.removeClass("spin");
		this.syncing = false;
		syncNotice?.hide();
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: ObsidianGoogleDrive;

	constructor(app: App, plugin: ObsidianGoogleDrive) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("a", {
			href: "https://obsidian-google-drive-website-ten.vercel.app",
			text: "Get refresh token",
		});

		new Setting(containerEl)
			.setName("Refresh token")
			.setDesc(
				"A refresh token is required to access your Google Drive for syncing. Back up your vault before the first sync."
			)
			.addText((text) => {
				text.setPlaceholder("Enter your refresh token")
					.setValue(this.plugin.settings.refreshToken)
					.onChange(async (value) => {
						this.plugin.settings.refreshToken = value;
						if (!value) {
							return this.plugin.debouncedSaveSettings();
						}
						if (!(await refreshAccessToken(this.plugin))) {
							text.setValue("");
							return;
						}

						// Locate and pin the vault's root folder on Drive. Adopt
						// mode supports a NON-EMPTY local vault (e.g. an existing
						// Google Drive for Desktop mirror): the first pull
						// reconciles existing files by modified time without
						// overwriting newer local content. getRootFolderId
						// surfaces its own Notice if the folder can't be found.
						await this.plugin.drive.getRootFolderId();

						await this.plugin.saveSettings();
						new Notice(
							"Refresh token saved! Back up your vault, then reload Obsidian to activate sync.",
							0
						);
					});
			});

		this.rootFolderIdSetting(containerEl);
	}

	rootFolderIdSetting(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName("Root folder ID (optional)")
			.setDesc(
				"Pin the exact Google Drive folder to sync. Leave empty to auto-match a folder named after the vault. Use this if several Drive folders share the vault's name (find the ID in the folder's URL)."
			)
			.addText((text) =>
				text
					.setPlaceholder("Drive folder ID")
					.setValue(this.plugin.settings.rootFolderId)
					.onChange((value) => {
						this.plugin.settings.rootFolderId = value.trim();
						this.plugin.debouncedSaveSettings();
					})
			);
	}
}
