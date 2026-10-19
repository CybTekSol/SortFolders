"use strict";

async function openManagerTab() {
  await browser.tabs.create({
    url: "ui/sortfolders.html"
  });
}

async function runStartupState() {
  let stored = await browser.storage.local.get({
    startupFolderPath: "",
    startupExpandMode: "default",
    expandedFolderURIs: []
  });

  if (stored.startupFolderPath || stored.startupExpandMode !== "default") {
    let applyFn = () => {
      browser.FolderSort.applyStartupState(
        stored.startupFolderPath || "",
        stored.startupExpandMode || "default",
        Array.isArray(stored.expandedFolderURIs) ? stored.expandedFolderURIs : []
      ).catch(console.error);
    };

    // Initial pass once 3-pane loads, plus a second pass to override late TB 158 session restoration
    setTimeout(applyFn, 900);
    setTimeout(applyFn, 2200);
  }
}

browser.menus.create({
  id: "sortfolders-menu-item",
  title: "SortFolders Manager",
  contexts: ["tools_menu"],
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png"
  }
});

browser.menus.onClicked.addListener((info) => {
  if (info.menuItemId === "sortfolders-menu-item") {
    openManagerTab();
  }
});

browser.browserAction.onClicked.addListener(() => {
  openManagerTab();
});

runStartupState();