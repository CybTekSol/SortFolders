"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

const FLAG_IMAP_NOSELECT = 0x00000001;

function isTransparentNamespaceContainer(folder) {
  if (!folder) {
    return false;
  }
  let rawName = (folder.name || folder.prettyName || "").trim();
  // [Gmail], [Google Mail], or any IMAP noselect container that isn't a real selectable folder
  if (/^\[.*\]$/.test(rawName)) {
    return true;
  }
  if ((folder.flags & FLAG_IMAP_NOSELECT) !== 0 && !folder.hasSubFolders) {
    return false;
  }
  // Check if Thunderbird hides this noselect container from about:3pane
  let win = Services.wm.getMostRecentWindow("mail:3pane");
  let contentWin = win?.gTabmail?.tabInfo?.[0]?.chromeBrowser?.contentWindow;
  let tree = contentWin?.folderTree || contentWin?.document?.getElementById("folderTree");
  if (tree && (folder.flags & FLAG_IMAP_NOSELECT) !== 0) {
    let rowInDOM = Array.from(tree.querySelectorAll("li[is='folder-tree-row']")).some(
      (r) => (r.uri || r.dataset?.uri) === folder.URI
    );
    if (!rowInDOM) {
      return true;
    }
  }
  return false;
}

function getFolderDisplayName(folder, domRow = null) {
  if (domRow) {
    let nameEl = domRow.querySelector(".folder-name");
    if (nameEl && nameEl.textContent.trim()) {
      return nameEl.textContent.trim();
    }
    if (domRow.name && String(domRow.name).trim()) {
      return String(domRow.name).trim();
    }
  }
  if (folder) {
    return folder.localizedName || folder.prettyName || folder.name || "";
  }
  return "";
}

function getDirectSubFolders(parentFolder) {
  let foundMap = new Map();

  try {
    if (parentFolder.subFolders) {
      for (let f of Array.from(parentFolder.subFolders)) {
        if (f && f.URI) {
          foundMap.set(f.URI, f);
        }
      }
    }
  } catch (e) {
    // Ignore enumerator errors
  }

  try {
    let rootServerFolder = parentFolder.rootFolder || parentFolder;
    if (rootServerFolder && rootServerFolder.descendants) {
      let parentURI = parentFolder.URI;
      let parentPrefix = parentURI.endsWith("/") ? parentURI : parentURI + "/";
      for (let desc of Array.from(rootServerFolder.descendants)) {
        if (!desc || !desc.URI || foundMap.has(desc.URI)) {
          continue;
        }
        if (desc.parent && desc.parent.URI === parentURI) {
          foundMap.set(desc.URI, desc);
        } else if (desc.URI.startsWith(parentPrefix)) {
          let remainder = desc.URI.slice(parentPrefix.length);
          if (remainder.length > 0 && !remainder.includes("/")) {
            foundMap.set(desc.URI, desc);
          }
        }
      }
    }
  } catch (e) {
    // Ignore if descendants not supported
  }

  return Array.from(foundMap.values());
}

function getEffectiveSortOrder(folder, domRow = null) {
  if (folder && typeof folder.userSortOrder === "number" && folder.userSortOrder > 0 && folder.userSortOrder < 999999999) {
    return folder.userSortOrder;
  }
  if (domRow && typeof domRow.folderSortOrder === "number" && domRow.folderSortOrder > 0 && domRow.folderSortOrder < 999999999) {
    return domRow.folderSortOrder;
  }
  return 0;
}

function sortFolderRecordArray(records) {
  return records.sort((a, b) => {
    let orderA = a.userSortOrder > 0 ? a.userSortOrder : 999999999;
    let orderB = b.userSortOrder > 0 ? b.userSortOrder : 999999999;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return (a.name || "").localeCompare(b.name || "", undefined, {
      numeric: true,
      sensitivity: "base"
    });
  });
}

function buildAccountFolderList(rootFolder) {
  let accountRootURI = rootFolder.URI;
  let win = Services.wm.getMostRecentWindow("mail:3pane");
  let contentWin = win?.gTabmail?.tabInfo?.[0]?.chromeBrowser?.contentWindow;
  let tree = contentWin?.folderTree || contentWin?.document?.getElementById("folderTree");

  let recordsMap = new Map();
  let domOrderCounter = 1;

  // Step 1: Walk live about:3pane DOM first so GMX INBOX.* flattening, [Gmail] hoisting,
  // and localized European folder names match what Thunderbird displays 1:1.
  if (tree) {
    let rootRow = Array.from(tree.querySelectorAll("li[is='folder-tree-row']")).find(
      (r) => (r.uri || r.dataset?.uri) === accountRootURI
    );

    if (rootRow) {
      let walkDOM = (rowEl, visualParentURI, depth) => {
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
          let folderObj = MailServices.folderLookup.getFolderForURL(uri);
          if (folderObj && isTransparentNamespaceContainer(folderObj)) {
            walkDOM(cRow, visualParentURI, depth);
            continue;
          }

          let nestedList = cRow.querySelector(":scope > ul, :scope > ol");
          let domHasChildren = Boolean(
            nestedList && nestedList.querySelector("li[is='folder-tree-row']")
          );
          let xpcomSubs = folderObj ? getDirectSubFolders(folderObj) : [];

          let entry = {
            name: getFolderDisplayName(folderObj, cRow),
            uri: uri,
            parentURI: visualParentURI,
            realParentURI: folderObj?.parent?.URI || visualParentURI,
            depth: depth,
            hasSubFolders: domHasChildren || Boolean(folderObj?.hasSubFolders) || xpcomSubs.length > 0,
            userSortOrder: getEffectiveSortOrder(folderObj, cRow),
            domPosition: domOrderCounter++,
            flags: folderObj?.flags || 0
          };

          recordsMap.set(uri, entry);
          walkDOM(cRow, uri, depth + 1);
        }
      };

      walkDOM(rootRow, accountRootURI, 0);
    }
  }

  // Step 2: Supplement from XPCOM MailServices for any collapsed/unrendered subfolders
  // while respecting GMX INBOX.* and [Gmail] visual parentage already discovered in Step 1.
  let seenXPCOM = new Set([accountRootURI]);

  let walkXPCOM = (parentFolder, effectiveParentURI, depth) => {
    let subFolders = getDirectSubFolders(parentFolder);
    for (let folder of subFolders) {
      if (!folder || !folder.URI || seenXPCOM.has(folder.URI)) {
        continue;
      }
      seenXPCOM.add(folder.URI);

      if (isTransparentNamespaceContainer(folder)) {
        walkXPCOM(folder, effectiveParentURI, depth);
        continue;
      }

      let childSubs = getDirectSubFolders(folder);
      let hasChildren = Boolean(folder.hasSubFolders) || childSubs.length > 0;

      if (!recordsMap.has(folder.URI)) {
        recordsMap.set(folder.URI, {
          name: getFolderDisplayName(folder, null),
          uri: folder.URI,
          parentURI: effectiveParentURI,
          realParentURI: folder.parent ? folder.parent.URI : parentFolder.URI,
          depth: depth,
          hasSubFolders: hasChildren,
          userSortOrder: getEffectiveSortOrder(folder, null),
          domPosition: domOrderCounter++,
          flags: folder.flags || 0
        });
      } else {
        let existing = recordsMap.get(folder.URI);
        if (hasChildren) {
          existing.hasSubFolders = true;
        }
      }

      if (hasChildren) {
        let currentEntry = recordsMap.get(folder.URI);
        let nextDepth = currentEntry ? currentEntry.depth + 1 : depth + 1;
        walkXPCOM(folder, folder.URI, nextDepth);
      }
    }
  };

  walkXPCOM(rootFolder, accountRootURI, 0);

  // Step 3: Reconstruct hierarchical list sorted by userSortOrder (or live DOM position) per parentURI
  let allRecords = Array.from(recordsMap.values());
  let orderedList = [];
  let visited = new Set();

  let appendChildrenOf = (pURI, currentDepth) => {
    let children = allRecords.filter((r) => r.parentURI === pURI && !visited.has(r.uri));
    children.sort((a, b) => {
      let hasCustomA = a.userSortOrder > 0;
      let hasCustomB = b.userSortOrder > 0;
      if (hasCustomA && hasCustomB && a.userSortOrder !== b.userSortOrder) {
        return a.userSortOrder - b.userSortOrder;
      }
      if (hasCustomA !== hasCustomB) {
        return hasCustomA ? -1 : 1;
      }
      if (a.domPosition !== b.domPosition) {
        return a.domPosition - b.domPosition;
      }
      return (a.name || "").localeCompare(b.name || "", undefined, {
        numeric: true,
        sensitivity: "base"
      });
    });

    for (let child of children) {
      visited.add(child.uri);
      child.depth = currentDepth;
      orderedList.push(child);
      appendChildrenOf(child.uri, currentDepth + 1);
    }
  };

  appendChildrenOf(accountRootURI, 0);

  // Append any remaining orphaned records
  for (let rem of allRecords) {
    if (!visited.has(rem.uri)) {
      visited.add(rem.uri);
      orderedList.push(rem);
    }
  }

  return orderedList;
}

function persistFolderCustomOrder(folder, orderInt) {
  if (!folder) {
    return;
  }
  try {
    folder.userSortOrder = orderInt;
  } catch (e) {
    // Ignore if virtual wrapper
  }
  try {
    folder.setStringProperty("sortOrder", String(orderInt));
  } catch (e) {
    // Ignore if folder cache unavailable
  }
  try {
    if (folder.msgDatabase && folder.msgDatabase.dBFolderInfo) {
      folder.msgDatabase.dBFolderInfo.setUint32Property("sortOrder", orderInt);
      folder.msgDatabase.dBFolderInfo.userSortOrder = orderInt;
      folder.msgDatabase.Commit(Ci.nsMsgDBCommitType.kLargeCommit);
    }
  } catch (e) {
    // Noselect or closed DB
  }
}

function reorderLiveDOMRows(orderedURIs) {
  let win = Services.wm.getMostRecentWindow("mail:3pane");
  if (!win || !win.gTabmail) {
    return;
  }

  let orderMap = new Map();
  orderedURIs.forEach((uri, idx) => {
    orderMap.set(uri, idx + 1);
  });

  for (let tabInfo of win.gTabmail.tabInfo) {
    let contentWin = tabInfo.chromeBrowser?.contentWindow;
    let tree = contentWin?.folderTree || contentWin?.document?.getElementById("folderTree");
    if (!tree) {
      continue;
    }

    let matchedRows = [];
    let allRows = Array.from(tree.querySelectorAll("li[is='folder-tree-row']"));
    for (let row of allRows) {
      let uri = row.uri || row.dataset?.uri;
      if (uri && orderMap.has(uri)) {
        let sortVal = orderMap.get(uri);
        try {
          row.folderSortOrder = sortVal;
          row.dataset.folderSortOrder = String(sortVal);
        } catch (e) {
          // Ignore if getter-only on custom element
        }
        matchedRows.push({ row, sortVal });
      }
    }

    // Group matched rows by their immediate DOM <ul>/<ol> parent container and physically reorder them
    let containerMap = new Map();
    for (let item of matchedRows) {
      let parentList = item.row.parentElement;
      if (parentList && (parentList.tagName === "UL" || parentList.tagName === "OL")) {
        if (!containerMap.has(parentList)) {
          containerMap.set(parentList, []);
        }
        containerMap.get(parentList).push(item);
      }
    }

    for (let [parentList, items] of containerMap.entries()) {
      items.sort((a, b) => a.sortVal - b.sortVal);
      for (let item of items) {
        parentList.appendChild(item.row);
      }
    }
  }
}

function refreshThreePaneFolderTree(orderedURIs = null) {
  if (Array.isArray(orderedURIs) && orderedURIs.length > 0) {
    reorderLiveDOMRows(orderedURIs);
  }

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

  if (Array.isArray(orderedURIs) && orderedURIs.length > 0) {
    reorderLiveDOMRows(orderedURIs);
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
    // Ignore xulStore errors
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

  let finalExpandedSet = new Set();
  let transitAncestorSet = new Set();

  if (expandMode === "only_startup") {
    finalExpandedSet = buildAncestorURISet(startupURI, false);
    transitAncestorSet = new Set(finalExpandedSet);
  } else if (expandMode === "custom") {
    for (let uri of customExpandedURIs) {
      finalExpandedSet.add(uri);
      for (let anc of buildAncestorURISet(uri, true)) {
        transitAncestorSet.add(anc);
      }
    }
  }

  // Pass 1: Top-down expansion of transit ancestors + target folders
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
            let folders = buildAccountFolderList(rootFolder);

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
          let parentContainerMinOrder = new Map();

          for (let uri of orderedURIs) {
            let folder = MailServices.folderLookup.getFolderForURL(uri);
            if (folder) {
              persistFolderCustomOrder(folder, index);

              if (folder.parent && isTransparentNamespaceContainer(folder.parent)) {
                let pURI = folder.parent.URI;
                if (!parentContainerMinOrder.has(pURI)) {
                  parentContainerMinOrder.set(pURI, index);
                }
              }
              index = index + 1;
            }
          }

          for (let [containerURI, minIdx] of parentContainerMinOrder.entries()) {
            let containerFolder = MailServices.folderLookup.getFolderForURL(containerURI);
            if (containerFolder) {
              persistFolderCustomOrder(containerFolder, minIdx);
            }
          }

          refreshThreePaneFolderTree(orderedURIs);
        },

        async restoreFolderOrders(folderEntries) {
          let sortedEntries = Array.from(folderEntries).sort(
            (a, b) => (a.userSortOrder || 0) - (b.userSortOrder || 0)
          );
          let orderedURIs = [];

          for (let entry of sortedEntries) {
            let folder = MailServices.folderLookup.getFolderForURL(entry.uri);
            if (folder) {
              persistFolderCustomOrder(folder, entry.userSortOrder);
              orderedURIs.push(entry.uri);
            }
          }
          refreshThreePaneFolderTree(orderedURIs);
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