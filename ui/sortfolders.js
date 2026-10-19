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
  rootOpt.textContent = account.name;
  parentSelect.appendChild(rootOpt);

  let parentURIs = new Set(account.folders.map((f) => f.parentURI));
  for (let folder of account.folders) {
    if (folder.hasSubFolders || parentURIs.has(folder.uri)) {
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

function populateExpandableChecklist(accounts, checkedURIs) {
  let container = document.getElementById("expandable-folder-list");
  container.innerHTML = "";
  let checkedSet = new Set(Array.isArray(checkedURIs) ? checkedURIs : []);

  for (let acc of accounts) {
    let parentURIs = new Set(acc.folders.map((f) => f.parentURI));

    let rootLabel = document.createElement("label");
    rootLabel.className = "checkbox-item account-root";

    let rootCb = document.createElement("input");
    rootCb.type = "checkbox";
    rootCb.value = acc.rootURI;
    rootCb.dataset.isAccountRoot = "true";
    rootCb.checked = checkedSet.has(acc.rootURI);

    let rootText = document.createElement("span");
    rootText.textContent = acc.name;

    rootLabel.appendChild(rootCb);
    rootLabel.appendChild(rootText);
    container.appendChild(rootLabel);

    for (let f of acc.folders) {
      if (f.hasSubFolders || parentURIs.has(f.uri)) {
        let fLabel = document.createElement("label");
        fLabel.className = "checkbox-item subfolder-item";

        let fCb = document.createElement("input");
        fCb.type = "checkbox";
        fCb.value = f.uri;
        fCb.dataset.isAccountRoot = "false";
        fCb.checked = checkedSet.has(f.uri);

        let fText = document.createElement("span");
        fText.textContent = `${"—".repeat(f.depth + 1)} ${f.name}`;

        fLabel.appendChild(fCb);
        fLabel.appendChild(fText);
        container.appendChild(fLabel);
      }
    }
  }
}

function getCheckedExpandedURIs() {
  let checkboxes = document.querySelectorAll("#expandable-folder-list input[type='checkbox']:checked");
  return Array.from(checkboxes).map((cb) => cb.value);
}

function updateCustomExpandBoxVisibility() {
  let mode = document.getElementById("startup-expand-mode").value;
  let box = document.getElementById("custom-expand-container");
  if (mode === "custom") {
    box.classList.remove("disabled");
  } else {
    box.classList.add("disabled");
  }
}

async function loadState() {
  let prevSelectedAcc = document.getElementById("folder-account-select").value;
  let prevSelectedParent = document.getElementById("parent-folder-select").value;

  accountData = await browser.FolderSort.getAccountTree();

  let accList = document.getElementById("account-list");
  let folderAccSelect = document.getElementById("folder-account-select");
  let startupSelect = document.getElementById("startup-folder-select");
  let expandModeSelect = document.getElementById("startup-expand-mode");

  accList.innerHTML = "";
  folderAccSelect.innerHTML = "";
  startupSelect.innerHTML = "<option value=''>-- Do Not Override Startup Folder --</option>";

  for (let acc of accountData) {
    let opt1 = document.createElement("option");
    opt1.value = acc.key;
    opt1.textContent = acc.name;
    accList.appendChild(opt1);

    let opt2 = document.createElement("option");
    opt2.value = acc.key;
    opt2.textContent = acc.name;
    folderAccSelect.appendChild(opt2);

    let rootStartupOpt = document.createElement("option");
    rootStartupOpt.value = acc.rootURI;
    rootStartupOpt.textContent = acc.name;
    startupSelect.appendChild(rootStartupOpt);

    for (let f of acc.folders) {
      let sOpt = document.createElement("option");
      sOpt.value = f.uri;
      sOpt.textContent = `${acc.name} : ${"—".repeat(f.depth + 1)} ${f.name}`;
      startupSelect.appendChild(sOpt);
    }
  }

  if (accountData.length > 0) {
    let targetAcc = accountData.find((a) => a.key === prevSelectedAcc) || accountData[0];
    folderAccSelect.value = targetAcc.key;
    populateParentLevels(targetAcc);

    let parentSelect = document.getElementById("parent-folder-select");
    if (prevSelectedParent && Array.from(parentSelect.options).some((o) => o.value === prevSelectedParent)) {
      parentSelect.value = prevSelectedParent;
      populateSiblingFolders(targetAcc, prevSelectedParent);
    }
  }

  let stored = await browser.storage.local.get({
    startupFolderPath: "",
    startupExpandMode: "default",
    expandedFolderURIs: []
  });

  startupSelect.value = stored.startupFolderPath || "";
  expandModeSelect.value = stored.startupExpandMode || "default";
  populateExpandableChecklist(accountData, stored.expandedFolderURIs);
  updateCustomExpandBoxVisibility();
}

async function exportBackupJSON() {
  let freshTree = await browser.FolderSort.getAccountTree();
  let stored = await browser.storage.local.get({
    startupFolderPath: "",
    startupExpandMode: "default",
    expandedFolderURIs: []
  });

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
    schemaVersion: 2,
    extensionVersion: "1.5.0",
    exportedAt: new Date().toISOString(),
    accountKeys: freshTree.map((a) => a.key),
    startupFolderPath: stored.startupFolderPath || "",
    startupExpandMode: stored.startupExpandMode || "default",
    expandedFolderURIs: Array.isArray(stored.expandedFolderURIs) ? stored.expandedFolderURIs : [],
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

  setStatus("Exported JSON backup (v1.5.0).");
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

  let newStartupPath = typeof payload.startupFolderPath === "string" ? payload.startupFolderPath : "";
  let newExpandMode = typeof payload.startupExpandMode === "string" ? payload.startupExpandMode : "default";
  let newExpandedURIs = Array.isArray(payload.expandedFolderURIs) ? payload.expandedFolderURIs : [];

  await browser.storage.local.set({
    startupFolderPath: newStartupPath,
    startupExpandMode: newExpandMode,
    expandedFolderURIs: newExpandedURIs
  });

  await browser.FolderSort.applyStartupState(newStartupPath, newExpandMode, newExpandedURIs);
  await loadState();
  setStatus("Backup restored and applied.");
}

document.addEventListener("DOMContentLoaded", () => {
  loadState().catch((err) => setStatus("Error: " + err.message));

  let accList = document.getElementById("account-list");
  let folderAccSelect = document.getElementById("folder-account-select");
  let parentSelect = document.getElementById("parent-folder-select");
  let siblingList = document.getElementById("sibling-folder-list");
  let expandModeSelect = document.getElementById("startup-expand-mode");
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

  expandModeSelect.addEventListener("change", () => {
    updateCustomExpandBoxVisibility();
  });

  document.getElementById("exp-check-all").addEventListener("click", () => {
    let cbs = document.querySelectorAll("#expandable-folder-list input[type='checkbox']");
    cbs.forEach((cb) => { cb.checked = true; });
  });

  document.getElementById("exp-uncheck-all").addEventListener("click", () => {
    let cbs = document.querySelectorAll("#expandable-folder-list input[type='checkbox']");
    cbs.forEach((cb) => { cb.checked = false; });
  });

  document.getElementById("exp-subfolders-only").addEventListener("click", () => {
    let cbs = document.querySelectorAll("#expandable-folder-list input[type='checkbox']");
    cbs.forEach((cb) => {
      cb.checked = (cb.dataset.isAccountRoot === "false");
    });
  });

  document.getElementById("startup-test-now").addEventListener("click", async () => {
    let startupURI = document.getElementById("startup-folder-select").value;
    let expandMode = expandModeSelect.value;
    let customURIs = getCheckedExpandedURIs();
    await browser.FolderSort.applyStartupState(startupURI, expandMode, customURIs);
    setStatus("Expansion state applied to 3-pane window.");
  });

  document.getElementById("startup-save").addEventListener("click", async () => {
    let startupURI = document.getElementById("startup-folder-select").value;
    let expandMode = expandModeSelect.value;
    let customURIs = getCheckedExpandedURIs();

    await browser.storage.local.set({
      startupFolderPath: startupURI,
      startupExpandMode: expandMode,
      expandedFolderURIs: customURIs
    });

    await browser.FolderSort.applyStartupState(startupURI, expandMode, customURIs);
    setStatus("Startup folder & expansion preferences saved and applied.");
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