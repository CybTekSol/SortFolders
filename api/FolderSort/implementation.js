"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

function getDirectSubFolders(parentFolder) {
  let raw = [];
  try {
    if (parentFolder.subFolders) {
      raw = Array.from(parentFolder.subFolders);
    }
  } catch (e) {
    raw = [];
  }

  // Fallback for IMAP noselect containers ([Gmail], Proton Folders/Labels)
  if (raw.length === 0 && typeof parentFolder.descendants !== "undefined") {
    try {
      let desc = Array.from(parentFolder.descendants);
      raw = desc.filter((f) => f.parent && f.parent.URI === parentFolder.URI);
    } catch (e) {
      // Ignore if descendants is unavailable
    }
  }

  return raw;
}

function serializeFolders(parentFolder, depth = 0, seenURIs = new Set()) {
  let list = [];
  let subFolders = getDirectSubFolders(parentFolder);

  let sortedSubs = subFolders.sort((a, b) => {
    let orderA = a.userSortOrder || 0;
    let orderB = b.userSortOrder || 0;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    let nameA = a.prettyName || a.name || "";
    let nameB = b.prettyName || b.name || "";
    return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" });
  });

  for (let folder of sortedSubs) {
    if (!folder || !folder.URI || seenURIs.has(folder.URI)) {
      continue;
    }
    seenURIs.add(folder.URI);

    let childSubs = getDirectSubFolders(folder);
    let hasChildren = Boolean(folder.hasSubFolders) || childSubs.length > 0;

    list.push({
      name: folder.prettyName || folder.name,
      uri: folder.URI,
      parentURI: parentFolder.URI,
      depth: depth,
      hasSubFolders: hasChildren,
      userSortOrder: folder.userSortOrder || 0,
      flags: folder.flags || 0
    });

    if (hasChildren) {
      list.push(...serializeFolders(folder, depth + 1, seenURIs));
    }
  }
  return list;
}

function supplementFromLiveDOM(accountRootURI, folderList) {
  let win = Services.wm.getMostRecentWindow("mail:3pane");
  let contentWin = win?.gTabmail?.tabInfo?.[0]?.chromeBrowser?.contentWindow;
  let tree = contentWin?.folderTree || contentWin?.document?.getElementById("folderTree");
  if (!tree) {
    return folderList;
  }

  let rootRow = Array.from(tree.querySelectorAll("li[is='folder-tree-row']")).find(
    (r) => (r.uri || r.dataset?.uri) === accountRootURI
  );
  if (!rootRow) {
    return folderList;
  }

  let knownMap = new Map(folderList.map((f) => [f.uri, f]));

  function walkRow(rowEl, parentURI, depth) {
    let childListEl = rowEl.querySelector(":scope > ul, :scope > ol");
    if (!childListEl) {
      return;
    }
    let childRows = Array.from(childListEl.children).filter(
      (el) => el.matches && el.matches("li[is='folder-tree-row']")
    );
    for (let cRow of childRows) {
      let uri = cRow.uri || cRow.dataset?.uri;
      if (!uri) {
        continue;
      }
      let nestedList = cRow.querySelector(":scope > ul, :scope > ol");
      let domHasChildren = Boolean(
        nestedList && nestedList.querySelector("li[is='folder-tree-row']")
      );

      if (!knownMap.has(uri)) {
        let folderObj = MailServices.folderLookup.getFolderForURL(uri);
        let entry = {
          name: cRow.name || folderObj?.prettyName || folderObj?.name || decodeURIComponent(uri.split("/").pop()),
          uri: uri,
          parentURI: parentURI,
          depth: depth,
          hasSubFolders: domHasChildren || Boolean(folderObj?.hasSubFolders),
          userSortOrder: folderObj?.userSortOrder || 0,
          flags: folderObj?.flags || 0
        };
        folderList.push(entry);
        knownMap.set(uri, entry);
      } else if (domHasChildren) {
        knownMap.get(uri).hasSubFolders = true;
      }

      walkRow(cRow, uri, depth + 1);
    }
  }

  walkRow(rootRow, accountRootURI, 0);
  return folderList;
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

function buildAncestorURISet(targetURI, includeSelf = true) {
  let set = new Set();
  if (!targetURI) {
    return set;
  }
  let folder = MailServices.folderLookup.getFolderForURL(targetURI);
  if (folder && !includeSelf) {
    folder = folder.parent;
  }
  while (folder) {
    set.add(folder.URI);
    folder = folder.parent;
  }
  return set;
}

function persistFolderOpenState(contentWin, row, uri, isOpen) {
  try {
    let docURL = contentWin.document?.URL || "chrome://messenger/content/about3Pane.xhtml";
    if (row && row.id) {
      Services.xulStore.setValue(docURL, row.id, "collapsed", isOpen ? "false" : "true");
    }
    if (contentWin.folderPane && typeof contentWin.folderPane._saveOpenStates === "function") {
      contentWin.folderPane._saveOpenStates();
    }
  } catch (e) {
    // Ignore xulStore errors if internal signature varies
  }
}

function setRowExpansion(contentWin, tree, row, shouldExpand) {
  if (!tree || !row) {
    return;
  }
  let uri = row.uri || row.dataset?.uri || "";
  let isClosed = row.classList.contains("collapsed");
  if (shouldExpand && isClosed) {
    if (typeof tree.expandRow === "function") {
      tree.expandRow(row);
    } else {
      row.classList.remove("collapsed");
    }
    persistFolderOpenState(contentWin, row, uri, true);
  } else if (!shouldExpand && !isClosed) {
    if (typeof tree.collapseRow === "function") {
      tree.collapseRow(row);
    } else {
      row.classList.add("collapsed");
    }
    persistFolderOpenState(contentWin, row, uri, false);
  }
}

function applyFolderTreeExpansion(contentWin, expandMode, startupURI, customExpandedURIs) {
  let tree = contentWin.folderTree || contentWin.document?.getElementById("folderTree");
  if (!tree || expandMode === "default") {
    return;
  }

  // Final target set of rows that should remain expanded when finished
  let finalExpandedSet = new Set();
  // Transit set of parent/account rows that must temporarily open so nested child rows render in DOM
  let transitAncestorSet = new Set();

  if (expandMode === "only_startup") {
    // Expand the ancestors leading to the startup folder
    finalExpandedSet = buildAncestorURISet(startupURI, false);
    transitAncestorSet = new Set(finalExpandedSet);
  } else if (expandMode === "custom") {
    // ONLY keep explicitly checked folders/accounts expanded at the end!
    for (let uri of customExpandedURIs) {
      finalExpandedSet.add(uri);
      for (let anc of buildAncestorURISet(uri, true)) {
        transitAncestorSet.add(anc);
      }
    }
  }

  // Pass 1: Top-down expansion of transit ancestors + target folders so nested folders (e.g. Proton "Folders") exist and open
  for (let pass = 0; pass < 7; pass++) {
    let changed = false;
    let rows = Array.from(tree.querySelectorAll("li[is='folder-tree-row']"));
    for (let row of rows) {
      let uri = row.uri || row.dataset?.uri;
      if (!uri) {
        continue;
      }
      let wantOpenForPass1 =
        expandMode === "expand_all" ||
        transitAncestorSet.has(uri) ||
        finalExpandedSet.has(uri);

      if (wantOpenForPass1 && row.classList.contains("collapsed")) {
        setRowExpansion(contentWin, tree, row, true);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  // Pass 2: Bottom-up collapse of any row NOT in finalExpandedSet
  // If an Account Root was NOT checked, it collapses here while its checked subfolder ("Folders") stays expanded inside it!
  if (expandMode !== "expand_all") {
    let rows = Array.from(tree.querySelectorAll("li[is='folder-tree-row']")).reverse();
    for (let row of rows) {
      let uri = row.uri || row.dataset?.uri;
      if (!uri) {
        continue;
      }
      if (!finalExpandedSet.has(uri) && !row.classList.contains("collapsed")) {
        setRowExpansion(contentWin, tree, row, false);
      }
    }
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
            let seen = new Set([rootFolder.URI]);
            let folders = serializeFolders(rootFolder, 0, seen);
            folders = supplementFromLiveDOM(rootFolder.URI, folders);

            result.push({
              key: acc.key,
              name: acc.incomingServer.prettyName,
              type: acc.incomingServer.type,
              rootURI: rootFolder.URI,
              folders: folders
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

          if (startupURI && typeof contentWin.displayFolder === "function") {
            contentWin.displayFolder(startupURI);
          }

          applyFolderTreeExpansion(
            contentWin,
            expandMode || "default",
            startupURI || "",
            Array.isArray(customExpandedURIs) ? customExpandedURIs : []
          );
        }
      }
    };
  }
};