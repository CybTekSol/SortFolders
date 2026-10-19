"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

function serializeFolders(parentFolder, depth = 0) {
  let list = [];
  let subFolders = parentFolder.subFolders || [];
  let sortedSubs = Array.from(subFolders).sort((a, b) => {
    let orderA = a.userSortOrder || 0;
    let orderB = b.userSortOrder || 0;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  for (let folder of sortedSubs) {
    list.push({
      name: folder.name,
      uri: folder.URI,
      parentURI: parentFolder.URI,
      depth: depth,
      hasSubFolders: Boolean(folder.hasSubFolders),
      userSortOrder: folder.userSortOrder || 0,
      flags: folder.flags
    });
    if (folder.hasSubFolders) {
      list.push(...serializeFolders(folder, depth + 1));
    }
  }
  return list;
}

function refreshThreePaneFolderTree() {
  let win = Services.wm.getMostRecentWindow("mail:3pane");
  if (!win || !win.gTabmail) {
    return;
  }
  for (let tabInfo of win.gTabmail.tabInfo) {
    let contentWin = tabInfo.chromeBrowser?.contentWindow;
    if (contentWin && contentWin.folderPane) {
      if (typeof contentWin.folderPane.rebuildFolderTree === "function") {
        contentWin.folderPane.rebuildFolderTree();
      } else if (typeof contentWin.folderPane.init === "function") {
        contentWin.folderPane._rebuild?.();
      }
    }
  }
}

function buildAncestorURISet(targetURI) {
  let set = new Set();
  if (!targetURI) {
    return set;
  }
  let folder = MailServices.folderLookup.getFolderForURL(targetURI);
  while (folder) {
    set.add(folder.URI);
    folder = folder.parent;
  }
  return set;
}

function setRowExpansion(tree, row, shouldExpand) {
  if (!tree || !row) {
    return;
  }
  let isClosed = row.classList.contains("collapsed");
  if (shouldExpand && isClosed) {
    if (typeof tree.expandRow === "function") {
      tree.expandRow(row);
    } else {
      row.classList.remove("collapsed");
    }
  } else if (!shouldExpand && !isClosed) {
    if (typeof tree.collapseRow === "function") {
      tree.collapseRow(row);
    } else {
      row.classList.add("collapsed");
    }
  }
}

function applyFolderTreeExpansion(contentWin, expandMode, startupURI, customExpandedURIs) {
  let tree = contentWin.folderTree || contentWin.document?.getElementById("folderTree");
  if (!tree || expandMode === "default") {
    return;
  }

  let allowedSet = new Set();
  if (expandMode === "only_startup") {
    allowedSet = buildAncestorURISet(startupURI);
  } else if (expandMode === "custom") {
    for (let uri of customExpandedURIs) {
      for (let anc of buildAncestorURISet(uri)) {
        allowedSet.add(anc);
      }
    }
    if (startupURI) {
      for (let anc of buildAncestorURISet(startupURI)) {
        allowedSet.add(anc);
      }
    }
  }

  // Pass 1: Top-down expansion so lazy child rows exist in the DOM
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    let rows = Array.from(tree.querySelectorAll("li[is='folder-tree-row']"));
    for (let row of rows) {
      let uri = row.uri || row.dataset?.uri;
      if (!uri) {
        continue;
      }
      let wantOpen = (expandMode === "expand_all") || allowedSet.has(uri);
      if (wantOpen && row.classList.contains("collapsed")) {
        setRowExpansion(tree, row, true);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  // Pass 2: Bottom-up collapse of any row not in the target set (fixes TB 158 first-folder bug)
  if (expandMode !== "expand_all") {
    let rows = Array.from(tree.querySelectorAll("li[is='folder-tree-row']")).reverse();
    for (let row of rows) {
      let uri = row.uri || row.dataset?.uri;
      if (!uri) {
        continue;
      }
      if (!allowedSet.has(uri) && !row.classList.contains("collapsed")) {
        setRowExpansion(tree, row, false);
      }
    }
  }

  // Persist open state to Thunderbird's xulStore if folderPane exposes _saveOpenStates
  try {
    if (contentWin.folderPane && typeof contentWin.folderPane._saveOpenStates === "function") {
      contentWin.folderPane._saveOpenStates();
    }
  } catch (e) {
    // Ignore if internal method signature differs
  }
}

var FolderSort = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      FolderSort: {
        async getAccountTree() {
          let accounts = MailServices.accounts.accounts;
          let result = [];
          for (let acc of accounts) {
            if (!acc.incomingServer) {
              continue;
            }
            let rootFolder = acc.incomingServer.rootFolder;
            result.push({
              key: acc.key,
              name: acc.incomingServer.prettyName,
              type: acc.incomingServer.type,
              rootURI: rootFolder.URI,
              folders: serializeFolders(rootFolder, 0)
            });
          }
          return result;
        },

        async setAccountOrder(accountKeys) {
          if (typeof MailServices.accounts.reorderAccounts === "function") {
            MailServices.accounts.reorderAccounts(accountKeys);
          } else {
            Services.prefs.setStringPref(
              "mail.accountmanager.accounts",
              accountKeys.join(",")
            );
          }
          Services.prefs.savePrefFile(null);
          refreshThreePaneFolderTree();
        },

        async applyFolderOrder(orderedURIs) {
          let index = 1;
          for (let uri of orderedURIs) {
            let folder = MailServices.folderLookup.getFolderForURL(uri);
            if (folder) {
              folder.userSortOrder = index;
              index = index + 1;
            }
          }
          refreshThreePaneFolderTree();
        },

        async restoreFolderOrders(folderEntries) {
          for (let entry of folderEntries) {
            let folder = MailServices.folderLookup.getFolderForURL(entry.uri);
            if (folder) {
              folder.userSortOrder = entry.userSortOrder;
            }
          }
          refreshThreePaneFolderTree();
        },

        async applyStartupState(startupURI, expandMode, customExpandedURIs) {
          let win = Services.wm.getMostRecentWindow("mail:3pane");
          if (!win || !win.gTabmail) {
            return;
          }
          let firstTab = win.gTabmail.tabInfo[0];
          let contentWin = firstTab?.chromeBrowser?.contentWindow;
          if (!contentWin) {
            return;
          }

          applyFolderTreeExpansion(
            contentWin,
            expandMode || "default",
            startupURI || "",
            Array.isArray(customExpandedURIs) ? customExpandedURIs : []
          );

          if (startupURI && typeof contentWin.displayFolder === "function") {
            contentWin.displayFolder(startupURI);
          }
        }
      }
    };
  }
};