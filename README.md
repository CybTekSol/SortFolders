# SortFolders

**SortFolders** is an open-source Thunderbird MailExtension designed to provide clean, centralized management for account ordering, custom folder sorting (`A-Z`, `Z-A`, and manual positioning), startup folder selection, and full JSON configuration backup and restore.

Developed and maintained by **CybTekSol [ https://github.com/CybTekSol ]** as a modern, lightweight successor to legacy XUL account and folder sorting utilities.

---

## Important Notice & Support Policy

> **DISCLAIMER:**  
> This extension is provided free of charge, **AS-IS**, no warranties or guarantees (expressed or implied)... use is at your own risk and is licensed as stated in the LICENSE file located in this repository.  
>
> Because Thunderbird does not provide native WebExtension APIs for direct `nsIMsgFolder.userSortOrder` manipulation, `mail.accountmanager.accounts` reordering, or live `about:3pane` folder tree rebuilding, SortFolders relies on internal Mozilla ESM / Experiment APIs. Major Thunderbird upgrades frequently alter internal Mozilla modules and may temporarily break functionality.
>
> **Maintenance is best-effort.** The codebase is structured using a hardened "Thin Bridge" pattern to minimize maintenance overhead. Community bug reports, feedback, and Pull Requests are welcome.

---

## Features

- **Account Order Management:** Quickly move mail, feed, and local accounts up or down in the Thunderbird folder pane and persist the exact sequence directly to `MailServices.accounts`.
- **Granular Folder Sorting:** Select any account and parent folder level (from the Account Root down to nested subfolder hierarchies) and reorder sibling folders manually or sort them automatically (`Sort A-Z` / `Sort Z-A`).
- **Custom Startup Folder Selection:** Configure a specific default folder across any account to automatically open and focus whenever Thunderbird launches.
- **Full JSON Backup & Restore:** Export your complete account order, custom `userSortOrder` folder integers across all hierarchies, and startup folder preference to a portable `.json` file, and restore your entire configuration in one click.
- **Native Dark & Light Theme Support:** Clean, dependency-free HTML5/CSS Grid dashboard that automatically adapts to your operating system and Thunderbird color scheme (`prefers-color-scheme`).

---

## Compatibility

- **Thunderbird Version:** 158.0 and Newer

- **OS Tested:** Windows 10/11 (including IoT Enterprise / LTSC), Linux (LMDE7, Arch/EndeavourOS), macOS.

---

## Architecture: The "Thin Bridge"

SortFolders utilizes a hybrid "Thin Bridge" pattern to isolate Thunderbird's internal privileged APIs from the user interface and state management logic:

- **Standard WebExtension Frontend (`ui/` & `background.js`):** All user interface rendering, interactive list sorting, startup preference storage (`browser.storage.local`), and JSON serialization/deserialization run inside standard, unprivileged WebExtension tabs and background scripts.
- **Minimal ESM Experiment Bridge (`api/FolderSort/`):** The privileged `FolderSort` Experiment API (`implementation.js`) is kept intentionally thin, exposing only four focused methods (`getAccountTree`, `setAccountOrder`, `applyFolderOrder`, `restoreFolderOrders`, and `selectStartupFolder`) via `MailServices.sys.mjs` and `about:3pane`. If Mozilla alters internal folder pane methods in future Thunderbird releases, only the thin bridge requires adjustment.

---

## Installation

### Manual Install (.xpi)
1. Download the latest `SortFolders-1.2.0-tb158.xpi` from the [Releases](https://github.com/CybTekSol/SortFolders/releases) section.
2. In Thunderbird, open **Tools > Add-ons and Themes** (or press `Ctrl + Shift + A`).
3. Click the gear icon in the top right and select **Install Add-on From File...**
4. Select the downloaded `.xpi` file and confirm installation.

---

## Configuration Settings

1. **Launching SortFolders:** Click the **SortFolders** button on the Thunderbird toolbar, or open **Tools > SortFolders Manager** from the main menu bar.
2. **Reordering Accounts:** In Panel **1. Account Order**, highlight an account, use **Move Up** or **Move Down** to set its position, and click **Save Account Order**.
3. **Sorting Folders:** In Panel **2. Folder Sort Order**, select the target **Account** and **Parent Level**. Use **Move Up**, **Move Down**, **Sort A-Z**, or **Sort Z-A** to arrange the sibling folders, then click **Apply Folder Order** to immediately update the Thunderbird folder pane.
4. **Setting a Startup Folder:** In Panel **3. Default Startup Folder**, choose your preferred folder from the dropdown (or select `-- Do Not Override Startup Folder --`) and click **Save Startup Folder**.
5. **Backing Up & Restoring:** In Panel **4. JSON Backup & Restore**, click **Export Backup (.json)** to save a timestamped snapshot (`SortFolders-Backup-YYYY-MM-DD.json`), or click **Restore from Backup (.json)** to apply a saved configuration file.

---

## Changelog

### Changes in version 1.2.0:
* Added custom extension icon set (`icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-64.png`) across the Add-ons Manager, main toolbar button, Tools menu entry, manager tab favicon, and UI header banner.
* Added extension version badge (`v1.2.0`) to the SortFolders Manager header and included `extensionVersion` metadata in exported JSON backup files.
* Updated `build.sh` packaging script to bundle `icons/` and display custom artwork in the Linux `yad` build dialog.

### Changes in version 1.1.0:
* Added full **JSON Backup & Restore** panel to export and import account ordering, custom `userSortOrder` folder structures, and startup folder settings.
* Added `restoreFolderOrders` batch API method to `api/FolderSort/schema.json` and `implementation.js`.

### Changes in version 1.0.0:
* Initial clean-room MailExtension release for Thunderbird 158+.
* Implemented Account Order manager, per-level Folder Sort Order manager (`Move Up/Down`, `Sort A-Z`, `Sort Z-A`), and Default Startup Folder selector.

---

## License

Licensed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html) (GPL-3.0).