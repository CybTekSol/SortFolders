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

        async selectStartupFolder(folderURI) {
          let win = Services.wm.getMostRecentWindow("mail:3pane");
          if (!win || !win.gTabmail) {
            return;
          }
          let firstTab = win.gTabmail.tabInfo[0];
          let contentWin = firstTab?.chromeBrowser?.contentWindow;
          if (contentWin && typeof contentWin.displayFolder === "function") {
            contentWin.displayFolder(folderURI);
          }
        }
      }
    };
  }
};