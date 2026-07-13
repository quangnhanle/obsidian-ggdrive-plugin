import ky from "ky";
import ObsidianGoogleDrive from "main";
import { getDriveKy } from "./ky";
import { Notice, TAbstractFile, TFolder } from "obsidian";

export interface FileMetadata {
	id: string;
	name: string;
	description: string;
	mimeType: string;
	starred: boolean;
	properties: Record<string, string>;
	modifiedTime: string;
}

// A single node of the Drive folder tree, keyed by Drive file id. `path` is the
// vault-relative path derived from the parent chain (root folder's path is "").
export interface DriveTreeNode {
	id: string;
	path: string;
	mimeType: string;
	modifiedTime: string;
	parentId: string | null;
	isFolder: boolean;
}

export type DriveTree = Record<string, DriveTreeNode>;

// Persisted projection of the tree from the previous sync. Diffing it against a
// freshly-walked tree (by id) yields creates/deletes/renames/modifies.
export interface SnapshotEntry {
	path: string;
	modifiedTime: string;
	isFolder: boolean;
}

export type DriveSnapshot = Record<string, SnapshotEntry>;

type StringSearch = string | { contains: string } | { not: string };
type DateComparison = { eq: string } | { gt: string } | { lt: string };

interface QueryMatch {
	name?: StringSearch | StringSearch[];
	mimeType?: StringSearch | StringSearch[];
	parent?: string;
	starred?: boolean;
	query?: string;
	properties?: Record<string, string>;
	modifiedTime?: DateComparison;
}

export const folderMimeType = "application/vnd.google-apps.folder";

export const BLACKLISTED_CONFIG_FILES = [
	"graph.json",
	"workspace.json",
	"workspace-mobile.json",
];

export const WHITELISTED_PLUGIN_FILES = [
	"manifest.json",
	"styles.css",
	"main.js",
	"data.json",
];

// Google Drive query strings wrap values in single quotes, so any backslash or
// single quote inside a value (e.g. a file named "John's notes.md") must be
// escaped or the query becomes malformed and the API rejects it with a 400.
const escapeQueryValue = (value: string) =>
	value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const stringSearchToQuery = (search: StringSearch) => {
	if (typeof search === "string") return `='${escapeQueryValue(search)}'`;
	if ("contains" in search)
		return ` contains '${escapeQueryValue(search.contains)}'`;
	if ("not" in search) return `!='${escapeQueryValue(search.not)}'`;
};

const queryHandlers = {
	name: (name: StringSearch) => "name" + stringSearchToQuery(name),
	mimeType: (mimeType: StringSearch) =>
		"mimeType" + stringSearchToQuery(mimeType),
	parent: (parent: string) => `'${escapeQueryValue(parent)}' in parents`,
	starred: (starred: boolean) => `starred=${starred}`,
	query: (query: string) => `fullText contains '${escapeQueryValue(query)}'`,
	properties: (properties: Record<string, string>) =>
		Object.entries(properties).map(
			([key, value]) =>
				`properties has { key='${escapeQueryValue(
					key
				)}' and value='${escapeQueryValue(value)}' }`
		),
	modifiedTime: (modifiedTime: DateComparison) => {
		if ("eq" in modifiedTime) return `modifiedTime='${modifiedTime.eq}'`;
		if ("gt" in modifiedTime) return `modifiedTime>'${modifiedTime.gt}'`;
		if ("lt" in modifiedTime) return `modifiedTime<'${modifiedTime.lt}'`;
	},
};

export const fileListToMap = (files: { id: string; name: string }[]) =>
	Object.fromEntries(files.map(({ id, name }) => [name, id]));

export const getDriveClient = (t: ObsidianGoogleDrive) => {
	const drive = getDriveKy(t);

	const getQuery = (matches: QueryMatch[]) =>
		encodeURIComponent(
			`(${matches
				.map((match) => {
					const entries = Object.entries(match).flatMap(
						([key, value]) =>
							value === undefined
								? []
								: Array.isArray(value)
								? value.map((v) => [key, v])
								: [[key, value]]
					);
					return `(${entries
						.map(([key, value]) =>
							queryHandlers[key as keyof QueryMatch](
								value as never
							)
						)
						.join(" and ")})`;
				})
				.join(" or ")}) and trashed=false`
		);

	const paginateFiles = async ({
		matches,
		pageToken,
		order = "descending",
		pageSize = 30,
		include = [
			"id",
			"name",
			"mimeType",
			"starred",
			"description",
			"properties",
		],
	}: {
		matches?: QueryMatch[];
		order?: "ascending" | "descending";
		pageToken?: string;
		pageSize?: number;
		include?: (keyof FileMetadata)[];
	}) => {
		const files = await drive
			.get(
				`drive/v3/files?fields=nextPageToken,files(${include.join(
					","
				)})&pageSize=${pageSize}&q=${
					matches ? getQuery(matches) : "trashed=false"
				}${
					matches?.find(({ query }) => query)
						? ""
						: "&orderBy=name" +
						  (order === "ascending" ? "" : " desc")
				}${pageToken ? "&pageToken=" + pageToken : ""}`
			)
			.json<any>();
		if (!files) return;
		return files as {
			nextPageToken?: string;
			files: FileMetadata[];
		};
	};

	const searchFiles = async (
		data: {
			matches?: QueryMatch[];
			order?: "ascending" | "descending";
			include?: (keyof FileMetadata)[];
		},
		includeObsidian = false
	) => {
		const files = await paginateFiles({ ...data, pageSize: 1000 });
		if (!files) return;

		while (files.nextPageToken) {
			const nextPage = await paginateFiles({
				...data,
				pageToken: files.nextPageToken,
				pageSize: 1000,
			});
			if (!nextPage) return;
			files.files.push(...nextPage.files);
			files.nextPageToken = nextPage.nextPageToken;
		}

		if (includeObsidian) return files.files as FileMetadata[];

		return files.files.filter(
			({ properties }) => properties?.obsidian !== "vault"
		) as FileMetadata[];
	};

	// Memoized so concurrent callers share a single resolution instead of each
	// racing. Reset to null on failure so a later call can retry.
	let rootFolderPromise: Promise<string | undefined> | null = null;

	// Resolves the vault's root folder on Drive WITHOUT relying on the
	// plugin-specific `obsidian`/`vault` properties, so it also finds folders
	// created by Google Drive for Desktop. Order: pinned id -> folder named
	// after the vault -> legacy tagged folder. Never auto-creates (that would
	// reintroduce a duplicate tagged folder and confuse the tree walk).
	const getRootFolderId = () => {
		if (rootFolderPromise) return rootFolderPromise;

		rootFolderPromise = (async () => {
			const vaultName = t.app.vault.getName();

			// 1. Pinned id from a previous resolution. Drive ids are stable
			// across renames/moves, so this is the most robust anchor.
			if (t.settings.rootFolderId) {
				const meta = await drive
					.get(
						`drive/v3/files/${t.settings.rootFolderId}?fields=id,trashed`
					)
					.json<any>()
					.catch(() => null);
				if (meta?.id && !meta.trashed) return meta.id as string;
			}

			// 2. A folder named exactly after the vault.
			const byName = await searchFiles(
				{ matches: [{ name: vaultName, mimeType: folderMimeType }] },
				true
			);
			if (!byName) return;
			if (byName.length === 1) {
				t.settings.rootFolderId = byName[0].id;
				return byName[0].id as string;
			}
			if (byName.length > 1) {
				new Notice(
					`Found ${byName.length} Google Drive folders named "${vaultName}". Set the exact folder ID in the plugin settings to disambiguate.`,
					0
				);
				return;
			}

			// 3. Legacy fallback: a folder this plugin tagged before (handles
			// existing users who renamed their Drive root - README allows it).
			const tagged = await searchFiles(
				{ matches: [{ properties: { obsidian: "vault" } }] },
				true
			);
			if (!tagged) return;
			if (tagged.length) {
				t.settings.rootFolderId = tagged[0].id;
				return tagged[0].id as string;
			}

			new Notice(
				`No Google Drive folder named "${vaultName}" was found. Create and populate it (e.g. with Google Drive for Desktop) before syncing.`,
				0
			);
			return;
		})();

		rootFolderPromise.then(
			(id) => {
				if (!id) rootFolderPromise = null;
			},
			() => {
				rootFolderPromise = null;
			}
		);

		return rootFolderPromise;
	};

	const createFolder = async ({
		name,
		parent,
		description,
		properties,
		modifiedTime,
	}: {
		name: string;
		description?: string;
		parent?: string;
		properties?: Record<string, string>;
		modifiedTime?: string;
	}) => {
		if (!parent) {
			parent = await getRootFolderId();
			if (!parent) return;
		}

		const folder = await drive
			.post(`drive/v3/files`, {
				json: {
					name,
					mimeType: folderMimeType,
					description,
					parents: [parent],
					properties,
					modifiedTime,
				},
			})
			.json<any>();
		if (!folder) return;
		return folder.id as string;
	};

	const uploadFile = async (
		file: Blob,
		name: string,
		parent?: string,
		metadata?: Partial<Omit<FileMetadata, "id">>
	) => {
		if (!parent) {
			parent = await getRootFolderId();
			if (!parent) return;
		}

		if (!metadata) metadata = {};

		const form = new FormData();
		form.append(
			"metadata",
			new Blob(
				[
					JSON.stringify({
						name,
						mimeType: file.type,
						parents: [parent],
						...metadata,
					}),
				],
				{ type: "application/json" }
			)
		);
		form.append("file", file);

		const result = await drive
			.post(`upload/drive/v3/files?uploadType=multipart&fields=id`, {
				body: form,
			})
			.json<any>();
		if (!result) return;

		return result.id as string;
	};

	const updateFile = async (
		id: string,
		newContent: Blob,
		newMetadata: Partial<Omit<FileMetadata, "id">> = {}
	) => {
		const form = new FormData();
		form.append(
			"metadata",
			new Blob([JSON.stringify(newMetadata)], {
				type: "application/json",
			})
		);
		form.append("file", newContent);

		const result = await drive
			.patch(
				`upload/drive/v3/files/${id}?uploadType=multipart&fields=id`,
				{
					body: form,
				}
			)
			.json<any>();
		if (!result) return;

		return result.id as string;
	};

	const updateFileMetadata = async (
		id: string,
		metadata: Partial<Omit<FileMetadata, "id">>
	) => {
		const result = await drive
			.patch(`drive/v3/files/${id}`, {
				json: metadata,
			})
			.json<any>();
		if (!result) return;
		return result.id as string;
	};

	const deleteFile = async (id: string) => {
		const result = await drive.delete(`drive/v3/files/${id}`);
		if (!result.ok) return;
		return true;
	};

	const getFile = (id: string) =>
		drive.get(`drive/v3/files/${id}?alt=media&acknowledgeAbuse=true`);

	const getFileMetadata = (id: string) =>
		drive.get(`drive/v3/files/${id}`).json<FileMetadata>();

	// Walks the whole folder tree under `rootId`, deriving each item's
	// vault-relative path from its position in the tree (NOT from a `path`
	// property), so it enumerates files created by any means, including Google
	// Drive for Desktop. This is the ONLY vault-content enumerator - it keeps
	// the query scoped to descendants of the root instead of the whole account.
	//
	// Throws if any page fetch fails, so callers abort before acting on a
	// truncated tree (a partial tree would look like a mass deletion).
	const buildDriveTree = async (rootId: string): Promise<DriveTree> => {
		const tree: DriveTree = {
			[rootId]: {
				id: rootId,
				path: "",
				mimeType: folderMimeType,
				modifiedTime: "",
				parentId: null,
				isFolder: true,
			},
		};
		// path -> id, to detect two Drive items resolving to one local path.
		const pathToId: Record<string, string> = { "": rootId };

		const fetchChildren = async (parentIds: string[]) => {
			const q = `(${parentIds
				.map((id) => `'${escapeQueryValue(id)}' in parents`)
				.join(" or ")}) and trashed=false`;

			const files: {
				id: string;
				name: string;
				mimeType: string;
				modifiedTime: string;
				parents?: string[];
			}[] = [];
			let pageToken: string | undefined;
			do {
				const page = await drive
					.get(
						`drive/v3/files?fields=nextPageToken,files(id,name,mimeType,modifiedTime,parents)&pageSize=1000&q=${encodeURIComponent(
							q
						)}${pageToken ? "&pageToken=" + pageToken : ""}`
					)
					.json<any>();
				if (!page) {
					throw new Error(
						"Failed to list a page of Google Drive files while building the vault tree."
					);
				}
				files.push(...page.files);
				pageToken = page.nextPageToken;
			} while (pageToken);

			return files;
		};

		let frontier = [rootId];
		while (frontier.length) {
			const parentSet = new Set(frontier);

			// Chunk parents so the OR query stays within Drive's length limits,
			// then run the chunks concurrently.
			const chunks: string[][] = [];
			for (let i = 0; i < frontier.length; i += 40) {
				chunks.push(frontier.slice(i, i + 40));
			}
			const children = (
				await batchAsyncs(chunks.map((chunk) => () => fetchChildren(chunk)))
			).flat() as {
				id: string;
				name: string;
				mimeType: string;
				modifiedTime: string;
				parents?: string[];
			}[];

			const nextFrontier: string[] = [];
			for (const file of children) {
				if (!file || tree[file.id]) continue; // Already placed (shallowest wins).

				// A file may list several parents; use one inside the level we
				// just queried so the derived path stays within the vault tree.
				const parentId =
					file.parents?.find((p) => parentSet.has(p)) ??
					file.parents?.[0];
				const parent = parentId ? tree[parentId] : undefined;
				if (!parent) continue;

				const path = parent.path
					? `${parent.path}/${file.name}`
					: file.name;
				const isFolder = file.mimeType === folderMimeType;

				const rivalId = pathToId[path];
				if (rivalId) {
					// Two ids collide on one path; keep the newer, drop the other.
					const rival = tree[rivalId];
					new Notice(
						`Google Drive has two items at "${path}". Keeping the most recently modified one; please remove the duplicate.`
					);
					if (
						new Date(rival.modifiedTime || 0).getTime() >=
						new Date(file.modifiedTime || 0).getTime()
					) {
						continue;
					}
					delete tree[rivalId];
				}

				tree[file.id] = {
					id: file.id,
					path,
					mimeType: file.mimeType,
					modifiedTime: file.modifiedTime,
					parentId: parent.id,
					isFolder,
				};
				pathToId[path] = file.id;

				if (isFolder) nextFrontier.push(file.id);
			}

			frontier = nextFrontier;
		}

		return tree;
	};

	const batchDelete = async (ids: string[]) => {
		const body = new FormData();

		// Loop through file IDs to create each delete request
		ids.forEach((fileId, index) => {
			const deleteRequest = [
				`--batch_boundary`,
				"Content-Type: application/http",
				"",
				`DELETE /drive/v3/files/${fileId} HTTP/1.1`,
				"",
				"",
			].join("\r\n");

			body.append(`request_${index + 1}`, deleteRequest);
		});

		body.append("", "--batch_boundary--");

		const result = await drive
			.post(`batch/drive/v3`, {
				headers: {
					"Content-Type": "multipart/mixed; boundary=batch_boundary",
				},
				body,
			})
			.text();
		if (!result) return;
		return result;
	};

	const deleteFilesMinimumOperations = async (files: TAbstractFile[]) => {
		const folders = files.filter(
			(file) => file instanceof TFolder
		) as TFolder[];

		if (folders.length) {
			const maxDepth = Math.max(
				...folders.map(({ path }) => path.split("/").length)
			);

			for (let depth = 1; depth <= maxDepth; depth++) {
				const foldersToDelete = files.filter(
					(file) =>
						file instanceof TFolder &&
						file.path.split("/").length === depth
				);
				await Promise.all(
					foldersToDelete.map((folder) => t.deleteFile(folder))
				);
				foldersToDelete.forEach(
					(folder) =>
						(files = files.filter(
							({ path }) =>
								!path.startsWith(folder.path + "/") &&
								path !== folder.path
						))
				);
			}
		}

		await Promise.all(files.map((file) => t.deleteFile(file)));
	};

	const getConfigFilesToSync = async () => {
		const configFilesToSync: string[] = [];
		const { vault } = t.app;
		const { adapter } = vault;

		const [configFiles, plugins] = await Promise.all([
			adapter.list(vault.configDir),
			adapter.list(vault.configDir + "/plugins"),
		]);

		await Promise.all(
			configFiles.files
				.filter((path) => isSyncableConfigFile(t, path))
				.map(async (path) => {
					const file = await adapter.stat(path);
					if ((file?.mtime || 0) > t.settings.lastSyncedAt) {
						configFilesToSync.push(path);
					}
				})
				.concat(
					plugins.folders.map(async (plugin) => {
						const files = await adapter.list(plugin);
						await Promise.all(
							files.files
								.filter((path) =>
									isSyncableConfigFile(t, path)
								)
								.map(async (path) => {
									const file = await adapter.stat(path);
									if (
										(file?.mtime || 0) >
										t.settings.lastSyncedAt
									) {
										configFilesToSync.push(path);
									}
								})
						);
					})
				)
		);

		return configFilesToSync;
	};

	return {
		paginateFiles,
		searchFiles,
		getRootFolderId,
		createFolder,
		uploadFile,
		updateFile,
		updateFileMetadata,
		deleteFile,
		getFile,
		getFileMetadata,
		buildDriveTree,
		batchDelete,
		checkConnection,
		deleteFilesMinimumOperations,
		getConfigFilesToSync,
	};
};

export const checkConnection = async () => {
	try {
		const result = await ky.get("https://obsidian-google-drive-website-ten.vercel.app/api/ping");
		return result.ok;
	} catch {
		return false;
	}
};

export const batchAsyncs = async (
	requests: (() => Promise<any>)[],
	batchSize = 10
) => {
	const results = [];
	for (let i = 0; i < requests.length; i += batchSize) {
		const batch = requests.slice(i, i + batchSize);
		results.push(...(await Promise.all(batch.map((request) => request()))));
	}
	return results;
};

export const getSyncMessage = (
	min: number,
	max: number,
	completed: number,
	total: number
) => `Syncing (${Math.floor(min + (max - min) * (completed / total))}%)`;

export const fileNameFromPath = (path: string) => path.split("/").slice(-1)[0];

// Path of THIS plugin's own data.json (holds device-local state + the refresh
// token). It must never be synced in either direction.
export const ownDataJsonPath = (t: ObsidianGoogleDrive) =>
	t.manifest.dir ? t.manifest.dir + "/data.json" : null;

// Decides whether a file inside the config dir (.obsidian) may be mirrored:
// excludes device-specific files, non-whitelisted plugin files, and our own
// data.json. Kept in one place so push and pull stay symmetric.
export const isSyncableConfigFile = (
	t: ObsidianGoogleDrive,
	path: string
) => {
	if (path === ownDataJsonPath(t)) return false;
	const name = fileNameFromPath(path);
	if (BLACKLISTED_CONFIG_FILES.includes(name)) return false;
	if (path.startsWith(t.app.vault.configDir + "/plugins/")) {
		return WHITELISTED_PLUGIN_FILES.includes(name);
	}
	return true;
};

// Projects a walked Drive tree into the persisted snapshot + id->path map.
export const snapshotFromTree = (tree: DriveTree) => {
	const nodes = Object.values(tree).filter((node) => node.path !== "");
	const driveSnapshot: DriveSnapshot = Object.fromEntries(
		nodes.map((node): [string, SnapshotEntry] => [
			node.id,
			{
				path: node.path,
				modifiedTime: node.modifiedTime,
				isFolder: node.isFolder,
			},
		])
	);
	const driveIdToPath: Record<string, string> = Object.fromEntries(
		nodes.map((node) => [node.id, node.path])
	);
	return { driveSnapshot, driveIdToPath };
};

/**
 * @returns Batches in increasing order of depth
 */
export const foldersToBatches: {
	(folders: string[]): string[][];
	(folders: TFolder[]): TFolder[][];
} = (folders) => {
	const batches: (typeof folders)[] = new Array(
		Math.max(
			...folders.map(
				(folder) =>
					(folder instanceof TFolder ? folder.path : folder).split(
						"/"
					).length
			)
		)
	)
		.fill(0)
		.map(() => []);

	folders.forEach((folder) => {
		batches[
			(folder instanceof TFolder ? folder.path : folder).split("/")
				.length - 1
		].push(folder as any);
	});

	return batches as any;
};
