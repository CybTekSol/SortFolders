"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

const FLAG_IMAP_NOSELECT = 0x00000001;

function isGmailNoselectContainer(folder) {
  if (!folder) {
    return false;
  }
  let rawName = (folder.name || folder.prettyName || "").trim();
  if (/^\[(Gmail|Google Mail)\]$/i.test(rawName)) {
    return true;
  }
  let uri = folder.URI || "";
  if (/\/%5B(Gmail|Google%20Mail)%5D$/i.test(uri) || /\/\[(Gmail|Google Mail)\]$/i.test(uri)) {
    return true;
  }
  return false;
}

function getDirectSubFolders(parentFolder) {
  let foundMap = new Map();

  // 1. Standard subFolders enumerator / array
  try {
    if (parentFolder.subFolders) {
      for (let f of Array.from(parentFolder.subFolders)) {
        if (f && f.URI) {
          foundMap.set(f.URI, f);
        }
      }
    }
  } catch (e) {
    // Ignore enumerator errors on noselect containers
  }

  // 2. Deep descendants scan (critical for [Gmail] noselect containers)
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

function sortFolderRecordArray(records) {
  return records.sort((a, b) => {
    let orderA = a.userSortOrder || 0;
    let orderB = b.userSortOrder || 0;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return (a.name || "").localeCompare(b.name || "", undefined, {
      numeric: true,
      sensitivity: "base"
    });
  });
}

function serializeFolders(parentFolder, effectiveParentURI = null, depth = 0, seenURIs = new Set()) {
  let list = [];
  let targetParentURI = effectiveParentURI || parentFolder.URI;
  let subFolders = getDirectSubFolders(parentFolder);

  for (let folder of subFolders) {
    if (!folder || !folder.URI || seenURIs.has(folder.URI)) {
      continue;
    }
    seenURIs.add(folder.URI);

    // If this is [Gmail] or [Google Mail], hoist its children directly into the Account Root level
    if (isGmailNoselectContainer(folder)) {
      let hoistedChildren = serializeFolders(folder, targetParentURI, depth, seenURIs);
      list.push(...hoistedChildren);
      continue;
    }

    let childSubs = getDirectSubFolders(folder);
    let hasChildren = Boolean(folder.hasSubFolders) || childSubs.length > 0;

    list.push({
      name: folder.prettyName || folder.name,
      uri: folder.URI,
      parentURI: targetParentURI,
      realParentURI: folder.parent ? folder.parent.URI : parentFolder.URI,
      depth: depth,
      hasSubFolders: hasChildren,
      userSortOrder: folder.userSortOrder || 0,
      flags: folder.flags || 0
    });

    if (hasChildren) {
      list.push(...serializeFolders(folder, folder.URI, depth + 1, seenURIs));
    }
  }

  // Sort siblings at the current targetParentURI so hoisted [Gmail] folders interleave properly with Inbox/Labels
  let directGroup = list.filter((item) => item.parentURI === targetParentURI);
  let nestedGroup = list.filter((item) => item.parentURI !== targetParentURI);
  sortFolderRecordArray(directGroup);

  let finalOrdered = [];
  for (let item of directGroup) {
    finalOrdered.push(item);
    let itemDescendants = nestedGroup.filter(
      (n) => n.uri.startsWith(item.uri + "/") || n.parentURI === item.uri
    );
    for (let d of itemDescendants) {
      if (!finalOrdered.includes(d)) {
        finalOrdered.push(d);
      }
    }
  }
  for (let rem of nestedGroup) {
    if (!finalOrdered.includes(rem)) {
      finalOrdered.push(rem);
    }
  }

  return finalOrdered;
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

      let folderObj = MailServices.folderLookup.getFolderForURL(uri);
      if (folderObj && isGmailNoselectContainer(folderObj)) {
        walkRow(cRow, parentURI, depth);
        continue;
      }

      let nestedList = cRow.querySelector(":scope > ul, :scope > ol");
      let domHasChildren = Boolean(
        nestedList && nestedList.querySelector("li[is='folder-tree-row']")
      );

      if (!knownMap.has(uri)) {
        let entry = {
          name: cRow.name || folderObj?.prettyName || folderObj?.name || decodeURIComponent(uri.split("/").pop()),
          uri: uri,
          parentURI: parentURI,
          realParentURI: folderObj?.parent?.URI || parentURI,
          depth: depth,
          hasSubFolders: domHasChildren || Boolean(folderObj?.hasSubFolders),
          userSortOrder: folderObj?.userSortOrder || 0,
          flags: folderObj?.flags || 0
        };
        folderList.push(entry);
        knownMap.set(uri, entry);
      } else {
        let existing = knownMap.get(uri);
        if (domHasChildren) {
          existing.hasSubFolders = true;
        }
      }

      walkRow(cRow, uri, depth + 1);
    }
  }

  walkRow(rootRow, accountRootURI, 0);
  return folderList;
}

function persistFolderCustomOrder(folder, orderInt) {
  if (!folder) {
    return;
  }
  try {
    folder.userSortOrder = orderInt;
  } catch (e) {
    // Ignore if read-only on virtual wrapper
  }
  try {
    if (folder.msgDatabase && folder.msgDatabase.dBFolderInfo) {
      folder.msgDatabase.dBFolderInfo.setUint32Property("sortOrder", orderInt);
      folder.msgDatabase.Commit(Ci.nsMsgDBCommitType.kLargeCommit);
    }
  } catch (e) {
    // Noselect or closed DB - safe to ignore
  }
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
            let seen = new Set([rootFolder.URI]);
            let folders = serializeFolders(rootFolder, rootFolder.URI, 0, seen);
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
          let gmailContainerMinOrder = new Map();

          for (let uri of orderedURIs) {
            let folder = MailServices.folderLookup.getFolderForURL(uri);
            if (folder) {
              persistFolderCustomOrder(folder, index);

              if (folder.parent && isGmailNoselectContainer(folder.parent)) {
                let pURI = folder.parent.URI;
                if (!gmailContainerMinOrder.has(pURI)) {
                  gmailContainerMinOrder.set(pURI, index);
                }
              }
              index = index + 1;
            }
          }

          for (let [gmailURI, minIdx] of gmailContainerMinOrder.entries()) {
            let gmailFolder = MailServices.folderLookup.getFolderForURL(gmailURI);
            if (gmailFolder) {
              persistFolderCustomOrder(gmailFolder, minIdx);
            }
          }

          refreshThreePaneFolderTree();
        },

        async restoreFolderOrders(folderEntries) {
          for (let entry of folderEntries) {
            let folder = MailServices.folderLookup.getFolderForURL(entry.uri);
            if (folder) {
              persistFolderCustomOrder(folder, entry.userSortOrder);
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