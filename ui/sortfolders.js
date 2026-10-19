"use strict";

let accountData = [];

function setStatus(msg) {
  let banner = document.getElementById("status-banner");
  banner.textContent = msg;
}

function moveSelectedOption(selectEl, direction) {
  let idx = selectEl.selectedIndex;
  if (idx < 0) {
    return;
  }
  let targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= selectEl.options.length) {
    return;
  }
  let opt = selectEl.options[idx];
  let refOpt = selectEl.options[targetIdx];
  if (direction < 0) {
    selectEl.insertBefore(opt, refOpt);
  } else {
    selectEl.insertBefore(refOpt, opt);
  }
  selectEl.selectedIndex = targetIdx;
}

function sortSelectOptions(selectEl, descending = false) {
  let options = Array.from(selectEl.options);
  options.sort((a, b) => {
    let cmp = a.textContent.localeCompare(b.textContent, undefined, { numeric: true, sensitivity: "base" });
    return descending ? -cmp : cmp;
  });
  selectEl.innerHTML = "";
  for (let opt of options) {
    selectEl.appendChild(opt);
  }
}

function populateParentLevels(account) {
  let parentSelect = document.getElementById("parent-folder-select");
  parentSelect.innerHTML = "";

  let rootOpt = document.createElement("option");
  rootOpt.value = account.rootURI;
  rootOpt.textContent = "[Account Root] " + account.name;
  parentSelect.appendChild(rootOpt);

  let parentURIs = new Set(account.folders.map((f) => f.parentURI));
  for (let folder of account.folders) {
    if (parentURIs.has(folder.uri)) {
      let opt = document.createElement("option");
      opt.value = folder.uri;
      opt.textContent = "—".repeat(folder.depth + 1) + " " + folder.name;
      parentSelect.appendChild(opt);
    }
  }
  populateSiblingFolders(account, parentSelect.value);
}

function populateSiblingFolders(account, parentURI) {
  let siblingList = document.getElementById("sibling-folder-list");
  siblingList.innerHTML = "";

  let siblings = account.folders.filter((f) => f.parentURI === parentURI);
  for (let folder of siblings) {
    let opt = document.createElement("option");
    opt.value = folder.uri;
    opt.textContent = folder.name;
    siblingList.appendChild(opt);
  }
}

async function loadState() {
  accountData = await browser.FolderSort.getAccountTree();

  let accList = document.getElementById("account-list");
  let folderAccSelect = document.getElementById("folder-account-select");
  let startupSelect = document.getElementById("startup-folder-select");

  accList.innerHTML = "";
  folderAccSelect.innerHTML = "";
  startupSelect.innerHTML = "<option value=''>-- Do Not Override Startup Folder --</option>";

  for (let acc of accountData) {
    let opt1 = document.createElement("option");
    opt1.value = acc.key;
    opt1.textContent = `${acc.name} (${acc.type})`;
    accList.appendChild(opt1);

    let opt2 = document.createElement("option");
    opt2.value = acc.key;
    opt2.textContent = acc.name;
    folderAccSelect.appendChild(opt2);

    for (let f of acc.folders) {
      let sOpt = document.createElement("option");
      sOpt.value = f.uri;
      sOpt.textContent = `${acc.name} : ${"—".repeat(f.depth)} ${f.name}`;
      startupSelect.appendChild(sOpt);
    }
  }

  if (accountData.length > 0) {
    populateParentLevels(accountData[0]);
  }

  let stored = await browser.storage.local.get("startupFolderPath");
  if (stored && stored.startupFolderPath) {
    startupSelect.value = stored.startupFolderPath;
  }
}

async function exportBackupJSON() {
  let freshTree = await browser.FolderSort.getAccountTree();
  let stored = await browser.storage.local.get("startupFolderPath");

  let folderEntries = [];
  for (let acc of freshTree) {
    let siblingGroups = {};
    for (let f of acc.folders) {
      if (!siblingGroups[f.parentURI]) {
        siblingGroups[f.parentURI] = [];
      }
      siblingGroups[f.parentURI].push(f);
    }
    for (let parentURI of Object.keys(siblingGroups)) {
      let group = siblingGroups[parentURI];
      group.forEach((folder, idx) => {
        folderEntries.push({
          uri: folder.uri,
          userSortOrder: folder.userSortOrder > 0 ? folder.userSortOrder : idx + 1
        });
      });
    }
  }

  let payload = {
    schemaVersion: 1,
    extensionVersion: "1.2.0",
    exportedAt: new Date().toISOString(),
    accountKeys: freshTree.map((a) => a.key),
    startupFolderPath: (stored && stored.startupFolderPath) ? stored.startupFolderPath : "",
    folderOrders: folderEntries
  };

  let blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  let url = URL.createObjectURL(blob);
  let dateStamp = new Date().toISOString().slice(0, 10);

  let a = document.createElement("a");
  a.href = url;
  a.download = `SortFolders-Backup-${dateStamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  setStatus("Exported JSON backup.");
}

async function importBackupJSON(file) {
  let text = await file.text();
  let payload = JSON.parse(text);

  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid JSON backup format.");
  }

  if (Array.isArray(payload.accountKeys) && payload.accountKeys.length > 0) {
    await browser.FolderSort.setAccountOrder(payload.accountKeys);
  }

  if (Array.isArray(payload.folderOrders) && payload.folderOrders.length > 0) {
    await browser.FolderSort.restoreFolderOrders(payload.folderOrders);
  }

  if (typeof payload.startupFolderPath === "string") {
    await browser.storage.local.set({ startupFolderPath: payload.startupFolderPath });
  }

  await loadState();
  setStatus("Backup restored and applied.");
}

document.addEventListener("DOMContentLoaded", () => {
  loadState().catch((err) => setStatus("Error: " + err.message));

  let accList = document.getElementById("account-list");
  let folderAccSelect = document.getElementById("folder-account-select");
  let parentSelect = document.getElementById("parent-folder-select");
  let siblingList = document.getElementById("sibling-folder-list");
  let fileInput = document.getElementById("file-import-json");

  document.getElementById("acc-up").addEventListener("click", () => moveSelectedOption(accList, -1));
  document.getElementById("acc-down").addEventListener("click", () => moveSelectedOption(accList, 1));

  document.getElementById("acc-save").addEventListener("click", async () => {
    let keys = Array.from(accList.options).map((o) => o.value);
    await browser.FolderSort.setAccountOrder(keys);
    setStatus("Account order saved.");
    await loadState();
  });

  folderAccSelect.addEventListener("change", () => {
    let acc = accountData.find((a) => a.key === folderAccSelect.value);
    if (acc) {
      populateParentLevels(acc);
    }
  });

  parentSelect.addEventListener("change", () => {
    let acc = accountData.find((a) => a.key === folderAccSelect.value);
    if (acc) {
      populateSiblingFolders(acc, parentSelect.value);
    }
  });

  document.getElementById("fld-up").addEventListener("click", () => moveSelectedOption(siblingList, -1));
  document.getElementById("fld-down").addEventListener("click", () => moveSelectedOption(siblingList, 1));
  document.getElementById("fld-az").addEventListener("click", () => sortSelectOptions(siblingList, false));
  document.getElementById("fld-za").addEventListener("click", () => sortSelectOptions(siblingList, true));

  document.getElementById("fld-save").addEventListener("click", async () => {
    let uris = Array.from(siblingList.options).map((o) => o.value);
    await browser.FolderSort.applyFolderOrder(uris);
    setStatus("Folder order applied to Thunderbird.");
    await loadState();
  });

  document.getElementById("startup-save").addEventListener("click", async () => {
    let uri = document.getElementById("startup-folder-select").value;
    await browser.storage.local.set({ startupFolderPath: uri });
    setStatus("Startup folder preference saved.");
  });

  document.getElementById("btn-export-json").addEventListener("click", () => {
    exportBackupJSON().catch((err) => setStatus("Export error: " + err.message));
  });

  document.getElementById("btn-import-json").addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length > 0) {
      importBackupJSON(fileInput.files[0]).catch((err) => setStatus("Import error: " + err.message));
    }
  });
});