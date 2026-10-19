"use strict";

async function openManagerTab() {
  await browser.tabs.create({
    url: "ui/sortfolders.html"
  });
}

async function applyStartupFolder() {
  let stored = await browser.storage.local.get("startupFolderPath");
  if (stored && stored.startupFolderPath) {
    setTimeout(() => {
      browser.FolderSort.selectStartupFolder(stored.startupFolderPath).catch(console.error);
    }, 900);
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

applyStartupFolder();