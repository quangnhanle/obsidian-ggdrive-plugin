# Google Drive Sync

This is an unofficial sync plugin for Obsidian, specifically for Google Drive.

## Disclaimer

-   This is **not** the [official sync service](https://obsidian.md/sync) provided by Obsidian
-   This plugin communicates with external servers, namely the Google Drive API and [https://obsidian-google-drive-website-ten.vercel.app](https://ogd.richardxiong.com)
    -   The details of this communication are explained at the bottom of the notes section

## Caution

**ALWAYS backup your vault before using this plugin.**

## Features

-   Syncing both ways (from Obsidian to Google Drive and back)
-   Cross-device support
-   Obsidian iOS app support
-   Local file prioritization (automatically resolves conflicts)
-   Multiple vaults per Google account
-   Configuration syncing

## New Devices

-   If you've already been using this plugin and want to start using it on a new device, then follow these instructions:
    1. Open Google Drive and download the entire Obsidian folder to your new device
    2. Move the Obsidian folder to the location where you want your vault to be
    3. Open Obsidian and set the vault location to the folder you just moved
-   If you activate the plugin on a new device without downloading the Obsidian folder from Google Drive, the plugin will start downloading from Google Drive as per a typical sync, which could take an extremely long amount of time depending on the number of notes in Google Drive, but it would still work (we suggest the above method instead)

## Notes

-   You CAN populate the Google Drive folder by any means, including Google Drive for Desktop or manual uploads
    -   The plugin identifies files by walking the Drive folder tree (by name/hierarchy), not by hidden tags, so it picks up files added by other tools on the next pull
    -   Google-format files (Docs, Sheets, Slides, etc.) are skipped because they have no downloadable file contents
-   Local changes made outside of the Obsidian app (while Obsidian is closed) are not tracked for PUSH
    -   Drive-side changes are always detected on pull, but for the plugin to push your local edits up, make them through the Obsidian app
-   If you ever encounter the following situation or vice versa, SYNC after you delete/rename it and before you rename/create the file/folder with the exact same path (this error arises from our plugin seeing a file convert into a folder or vice versa) (this doesn't apply for file to file or folder to folder):
    -   You have a file that has NO file extension already synced (most files have a file extension so you usually don't have to worry about this)
    -   You delete it/rename it
    -   You rename/create a folder with the exact same path
-   Activating on a non-empty vault is supported (adopt mode)
    -   On the first sync, existing local files are matched to the Drive folder by path: files already present locally are kept as-is (never overwritten), and anything that exists only on Drive is downloaded
    -   This makes it safe to point the plugin at a vault that Google Drive for Desktop already mirrors locally
    -   Still **BACK UP** your vault before the first sync
-   We suggest only editing Obsidian notes on one device at a time to avoid conflicts and syncing before editing on another device
    -   Our plugin does have code to handle conflicts, but it might not be perfect or as the user expects, so try to avoid them
-   Make sure to sync with an adequate internet connection
    -   Closing the app or losing connection while syncing could lead to data corruption
-   The plugin does NOT have manual conflict resolution
    -   If you encounter a conflict, the plugin will automatically resolve it with local file prioritization
-   Do **NOT** change the Obsidian configuration folder
    -   If you really want to, make a new vault, change the folder, enable the plugin, and copy your files over (you can move the contents of .obsidian to the new folder through file explorer)
-   This only accesses the Google Drive API to sync files and does not access or store any data outside of the user's device
-   This only accesses [https://ogd.richardxiong.com](https://ogd.richardxiong.com) to convert refresh tokens into access tokens (while hiding the client secret) and to check internet connectivity with a simple ping request

## Setup

Note: Instructions are also on this plugin's homepage with images at [https://ogd.richardxiong.com](https://ogd.richardxiong.com)

1. Visit this plugin's homepage at [https://ogd.richardxiong.com](https://ogd.richardxiong.com)
2. Click `Sign In` at the top right and log in with your Google account
3. Copy the refresh token that appears after logging in
4. Enable the Google Drive Sync plugin in Obsidian
5. Paste the refresh token into the plugin settings in Obsidian
6. Reload the Obsidian app

## Use

-   After setup, the plugin will automatically sync your vault with Google Drive whenever Obsidian is open
    -   This sync is from Google Drive TO Obsidian, not the other way around (pulling cloud files)
    -   The plugin prioritizes unsynced local changes except for local file deletions (cloud file creation/modification will overwrite local deletion)
    -   You can pull by running the `Pull from Google Drive` command
    -   Pulling new plugins/configurations may require a restart of Obsidian
-   To sync local changes to Google Drive, click the sync button on the ribbon or run the `Push to Google Drive` command from the command palette
    -   While you do not have to sync before you close Obsidian, we suggest doing so to ensure that Google Drive is up to date and no conflicts occur
    -   This will pull changes before pushing changes to Google Drive
-   If you want to set your local vault state to the Google Drive state, run the `Set Local Vault to Google Drive` command
-   If you mess with the vault's files while Obsidian is closed, try to revert any of the changes you made

## Choosing the Drive folder / Multiple Vaults

-   The plugin syncs the Google Drive folder whose **name matches your vault's name**
    -   After the first sync it remembers that folder by its Drive ID, so you can then rename it, color it, and move it anywhere in your Drive without consequence
-   If several Drive folders share your vault's name, set the exact **Root folder ID** in the plugin settings (find the ID in the folder's URL) to disambiguate
-   If no matching folder is found, the plugin will NOT create one - create/populate the folder first (e.g. with Google Drive for Desktop), then sync
-   You can have multiple vaults per Google account by giving each vault a distinct name / folder
-   This plugin's own `data.json` (which holds your refresh token and device-local sync state) is never uploaded to Drive

Privacy Policy: [https://ogd.richardxiong.com/privacy](https://ogd.richardxiong.com/privacy)
