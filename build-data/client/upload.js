const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const destPathInput = document.getElementById("dest-path");
const checkOverwrite = document.getElementById("check-overwrite");
const fileInfo = document.getElementById("file-info");
const summaryCount = document.getElementById("summary-count");
const summarySize = document.getElementById("summary-size");
const btnClear = document.getElementById("btn-clear");
const fileList = document.getElementById("file-list");
const btnUpload = document.getElementById("btn-upload");
const progressContainer = document.getElementById("progress-container");
const progressFill = document.getElementById("progress-fill");
const progressPct = document.getElementById("progress-pct");
const progressStatus = document.getElementById("progress-status");
const resultBox = document.getElementById("result-box");

let selectedFiles = [];
let isUploading = false;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
}

const escapeHtml = require("escape-html");

function computeTargetPath(file, customName) {
  let dest = destPathInput.value.trim().replace(/\\/g, "/") || "/agy";
  dest = dest.replace(/\/+$/, "") || "/";
  const name = (customName && customName.trim())
    ? customName.trim().replace(/\\/g, "/")
    : (file.relativePath || file.name);
  const cleanRelPath = name.replace(/^\/+/, "");
  if (dest === "/") {
    return "/" + cleanRelPath;
  }
  return (dest + "/" + cleanRelPath).replace(/\/+/g, "/");
}

function renderFileList() {
  if (selectedFiles.length === 0) {
    fileInfo.style.display = "none";
    btnUpload.disabled = true;
    btnUpload.innerText = "Upload Files";
    return;
  }

  fileInfo.style.display = "block";
  const totalSize = selectedFiles.reduce((sum, item) => sum + item.file.size, 0);
  summaryCount.innerText = `${selectedFiles.length} ${selectedFiles.length === 1 ? "file" : "files"}`;
  summarySize.innerText = formatBytes(totalSize);

  const pendingFiles = selectedFiles.filter(item => item.status !== "done");

  if (!isUploading) {
    if (pendingFiles.length === 0) {
      btnUpload.disabled = true;
      btnUpload.innerText = "All Files Uploaded";
    } else {
      btnUpload.disabled = false;
      btnUpload.innerText = `Upload ${pendingFiles.length} File(s)`;
    }
  }

  fileList.innerHTML = selectedFiles.map((item, idx) => {
    if (item.status !== "done") {
      item.target = computeTargetPath(item.file, item.customName);
    }
    const target = item.target;
    const originalName = item.file.relativePath || item.file.name;
    const currentName = item.customName || originalName;
    let badgeClass = "status-pending";
    let badgeText = "Ready";

    if (item.status === "uploading") {
      badgeClass = "status-uploading";
      badgeText = (item.pct !== undefined ? item.pct + "%" : "Uploading");
    } else if (item.status === "done") {
      badgeClass = "status-success";
      badgeText = "✓ Done";
    } else if (item.status === "error") {
      badgeClass = "status-error";
      badgeText = "✕ Failed";
    }

    const removeBtn = !isUploading
      ? `<button type="button" class="btn-remove" data-idx="${idx}" title="Remove file">✕</button>`
      : "";

    const renameBtn = (!isUploading && item.status !== "done" && !item.isEditing)
      ? `<button type="button" class="btn-rename" data-idx="${idx}" title="Rename file">Rename</button>`
      : "";

    let nameContent = "";
    if (item.isEditing) {
      nameContent = `
        <div class="rename-container">
          <input type="text" class="input-rename" data-idx="${idx}" value="${escapeHtml(currentName)}" spellcheck="false" autocomplete="off" />
          <button type="button" class="btn-save-rename" data-idx="${idx}" title="Save new name">Save</button>
          <button type="button" class="btn-cancel-rename" data-idx="${idx}" title="Cancel">Cancel</button>
        </div>
      `;
    } else {
      const wasRenamed = Boolean(item.customName && item.customName !== originalName);
      nameContent = `
        <div class="file-item-name" title="${escapeHtml(currentName)}">
          ${escapeHtml(currentName)}
          ${wasRenamed ? `<span class="original-name">(original: ${escapeHtml(originalName)})</span>` : ""}
        </div>
      `;
    }

    return `
      <div class="file-item ${item.isEditing ? "editing" : ""}" data-idx="${idx}">
        <div class="file-item-info">
          ${nameContent}
          <div class="file-item-sub" title="${escapeHtml(target)}">↳ ${escapeHtml(target)} &bull; ${formatBytes(item.file.size)}</div>
        </div>
        <div class="file-item-actions">
          <span class="file-status-badge ${badgeClass}">${badgeText}</span>
          ${renameBtn}
          ${removeBtn}
        </div>
      </div>
    `;
  }).join("");

  const activeInput = fileList.querySelector(".input-rename");
  if (activeInput) {
    activeInput.focus();
    activeInput.select();
  }
}

function updateItemBadge(idx, status, badgeText) {
  const itemEl = fileList.querySelector(`.file-item[data-idx="${idx}"]`);
  if (!itemEl) return;
  const badge = itemEl.querySelector(".file-status-badge");
  if (!badge) return;
  badge.className = `file-status-badge status-${status}`;
  badge.innerText = badgeText;
}

function saveRename(idx) {
  if (idx < 0 || idx >= selectedFiles.length) return;
  const item = selectedFiles[idx];
  const inputEl = fileList.querySelector(`.input-rename[data-idx="${idx}"]`);
  if (!inputEl) return;

  const newName = inputEl.value.trim().replace(/\\/g, "/");
  const originalName = item.file.relativePath || item.file.name;
  const candidateName = (newName && newName !== originalName) ? newName : "";
  const newTarget = computeTargetPath(item.file, candidateName);

  const hasDuplicate = selectedFiles.some(
    (other, otherIdx) => otherIdx !== idx && other.status !== "done" && other.target === newTarget
  );

  if (hasDuplicate) {
    resultBox.className = "result-box error";
    resultBox.style.display = "block";
    resultBox.innerHTML = `<strong>Rename conflict:</strong> <code>${escapeHtml(newTarget)}</code> already exists in upload queue.`;
    inputEl.focus();
    return;
  }

  if (resultBox.classList.contains("error") && resultBox.innerHTML.includes("Rename conflict")) {
    resultBox.style.display = "none";
  }

  item.customName = candidateName;
  item.target = newTarget;
  item.isEditing = false;
  renderFileList();
}

function cancelRename(idx) {
  if (idx < 0 || idx >= selectedFiles.length) return;
  selectedFiles[idx].isEditing = false;
  renderFileList();
}

function addFiles(fileListInput) {
  if (isUploading) return;
  const newFiles = Array.from(fileListInput);
  const duplicates = [];

  for (const file of newFiles) {
    const target = computeTargetPath(file);
    const exists = selectedFiles.some(
      item => item.status !== "done" && item.target === target
    );
    if (exists) {
      duplicates.push(target);
    } else {
      selectedFiles.push({
        file,
        customName: "",
        isEditing: false,
        status: "pending",
        pct: 0,
        target,
      });
    }
  }

  if (duplicates.length > 0) {
    resultBox.className = "result-box error";
    resultBox.style.display = "block";
    const targets = duplicates.map(t => `<code>${escapeHtml(t)}</code>`).join(", ");
    resultBox.innerHTML = `<strong>Duplicate target skipped:</strong> ${targets} already waiting in upload queue.`;
  } else if (resultBox.classList.contains("error") && resultBox.innerHTML.includes("Duplicate target skipped")) {
    resultBox.style.display = "none";
  }

  renderFileList();
}

async function readAllDirectoryEntries(dirReader) {
  const entries = [];
  let batch;
  do {
    batch = await new Promise((resolve, reject) => {
      dirReader.readEntries(resolve, reject);
    });
    if (batch && batch.length > 0) {
      entries.push(...batch);
    }
  } while (batch && batch.length > 0);
  return entries;
}

function getFileFromEntry(fileEntry, relativePath) {
  return new Promise((resolve, reject) => {
    fileEntry.file((file) => {
      if (relativePath) file.relativePath = relativePath;
      resolve(file);
    }, reject);
  });
}

async function traverseEntry(entry, currentPath = "") {
  const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
  if (entry.isFile) {
    try {
      const file = await getFileFromEntry(entry, currentPath ? entryPath : "");
      return [file];
    } catch (err) {
      console.warn("Could not read file from entry:", entry.name, err);
      return [];
    }
  } else if (entry.isDirectory) {
    try {
      const dirReader = entry.createReader();
      const entries = await readAllDirectoryEntries(dirReader);
      const results = await Promise.all(
        entries.map(subEntry => traverseEntry(subEntry, entryPath))
      );
      return results.flat();
    } catch (err) {
      console.warn("Could not read directory entry:", entry.name, err);
      return [];
    }
  }
  return [];
}

async function getFilesFromDataTransfer(dataTransfer) {
  const items = dataTransfer?.items;
  if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === "function") {
    const promises = [];
    for (const item of items) {
      if (item.kind === "file") {
        const entry = item.webkitGetAsEntry();
        if (entry) promises.push(traverseEntry(entry, ""));
      }
    }
    const results = await Promise.all(promises);
    const files = results.flat();
    if (files.length > 0) return files;
  }
  return Array.from(dataTransfer?.files || []);
}

dropZone.addEventListener("click", () => {
  if (!isUploading) fileInput.click();
});

fileInput.addEventListener("change", (e) => {
  if (e.target.files?.length > 0) {
    addFiles(e.target.files);
    fileInput.value = "";
  }
});

destPathInput.addEventListener("input", () => {
  if (!isUploading) renderFileList();
});

["dragenter", "dragover"].forEach(event => {
  dropZone.addEventListener(event, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isUploading) dropZone.classList.add("dragover");
  });
});

dropZone.addEventListener("dragleave", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove("dragover");
  if (isUploading) return;

  const files = await getFilesFromDataTransfer(e.dataTransfer);
  if (files.length > 0) {
    addFiles(files);
  }
});

btnClear.addEventListener("click", () => {
  if (isUploading) return;
  selectedFiles = [];
  renderFileList();
  resultBox.style.display = "none";
  progressContainer.style.display = "none";
});

fileList.addEventListener("click", (e) => {
  if (isUploading) return;

  const saveBtn = e.target.closest(".btn-save-rename");
  if (saveBtn) {
    const idx = parseInt(saveBtn.getAttribute("data-idx"), 10);
    saveRename(idx);
    return;
  }

  const cancelBtn = e.target.closest(".btn-cancel-rename");
  if (cancelBtn) {
    const idx = parseInt(cancelBtn.getAttribute("data-idx"), 10);
    cancelRename(idx);
    return;
  }

  const renameBtn = e.target.closest(".btn-rename");
  if (renameBtn) {
    const idx = parseInt(renameBtn.getAttribute("data-idx"), 10);
    if (!isNaN(idx) && idx >= 0 && idx < selectedFiles.length) {
      selectedFiles.forEach((it, i) => { it.isEditing = (i === idx); });
      renderFileList();
    }
    return;
  }

  const btn = e.target.closest(".btn-remove");
  if (btn) {
    const idx = parseInt(btn.getAttribute("data-idx"), 10);
    if (!isNaN(idx) && idx >= 0 && idx < selectedFiles.length) {
      selectedFiles.splice(idx, 1);
      renderFileList();
    }
  }
});

fileList.addEventListener("keydown", (e) => {
  if (e.target.classList.contains("input-rename")) {
    const idx = parseInt(e.target.getAttribute("data-idx"), 10);
    if (e.key === "Enter") {
      e.preventDefault();
      saveRename(idx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename(idx);
    }
  }
});

function uploadSingleFile(file, target, onProgress, overwrite = false) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `/control/upload?path=${encodeURIComponent(target)}${overwrite ? "&overwrite" : ""}`;
    xhr.open("PUT", url);
    xhr.setRequestHeader("X-File-Path", encodeURI(target));
    const targetFilename = target.split("/").filter(Boolean).pop() || file.name;
    xhr.setRequestHeader("X-File-Name", encodeURI(targetFilename));

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(e.loaded);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        let msg = `HTTP ${xhr.status}`;
        try {
          const resData = JSON.parse(xhr.responseText);
          if (resData.error) msg = resData.error;
        } catch (_) {
          if (xhr.responseText) msg = xhr.responseText.trim();
        }
        reject(new Error(msg));
      }
    };

    xhr.onerror = () => reject(new Error("Network connection error"));
    xhr.ontimeout = () => reject(new Error("Request timed out"));
    xhr.send(file);
  });
}

async function startUpload() {
  if (isUploading || selectedFiles.length === 0) return;

  // Save any active inline rename before starting upload
  selectedFiles.forEach((item, idx) => {
    if (item.isEditing) {
      saveRename(idx);
    }
  });

  let queue = selectedFiles.filter(item => item.status !== "done");
  if (queue.length === 0) return;

  const overwrite = Boolean(checkOverwrite?.checked);
  isUploading = true;
  btnUpload.disabled = true;
  destPathInput.disabled = true;
  if (checkOverwrite) checkOverwrite.disabled = true;
  btnClear.disabled = true;
  resultBox.style.display = "none";
  progressContainer.style.display = "block";
  renderFileList();

  const totalFiles = queue.length;
  const totalBytes = queue.reduce((sum, item) => sum + item.file.size, 0);
  let completedBytesBeforeCurrent = 0;
  let successCount = 0;
  let failCount = 0;
  const errors = [];

  function updateOverallProgress(loadedBytes) {
    const overallPct = totalBytes > 0 ? ((loadedBytes / totalBytes) * 100).toFixed(1) : "100.0";
    progressFill.style.width = overallPct + "%";
    progressPct.innerText = `${overallPct}% (${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)})`;
  }

  for (let i = 0; i < totalFiles; i++) {
    const item = queue[i];
    const itemIdx = selectedFiles.indexOf(item);
    item.status = "uploading";
    item.pct = 0;
    updateItemBadge(itemIdx, "uploading", "0%");

    const target = item.target || computeTargetPath(item.file, item.customName);
    item.target = target;
    const displayName = item.customName || item.file.relativePath || item.file.name;
    progressStatus.innerText = `Uploading (${i + 1}/${totalFiles}): ${displayName}...`;

    try {
      await uploadSingleFile(item.file, target, (loaded) => {
        item.pct = item.file.size > 0 ? Math.min(100, Math.round((loaded / item.file.size) * 100)) : 100;
        updateItemBadge(itemIdx, "uploading", `${item.pct}%`);
        updateOverallProgress(completedBytesBeforeCurrent + loaded);
      }, overwrite);

      item.status = "done";
      item.pct = 100;
      updateItemBadge(itemIdx, "success", "✓ Done");
      successCount++;
    } catch (err) {
      item.status = "error";
      item.error = err.message || "Upload failed";
      updateItemBadge(itemIdx, "error", "✕ Failed");
      failCount++;
      errors.push(`${displayName}: ${item.error}`);
    }

    completedBytesBeforeCurrent += item.file.size;
    updateOverallProgress(completedBytesBeforeCurrent);
  }

  isUploading = false;
  btnUpload.disabled = false;
  destPathInput.disabled = false;
  if (checkOverwrite) checkOverwrite.disabled = false;
  btnClear.disabled = false;
  renderFileList();

  progressStatus.innerText = failCount === 0 ? "Upload Complete!" : "Upload Completed with Errors";
  resultBox.style.display = "block";

  if (failCount === 0) {
    resultBox.className = "result-box success";
    const countText = totalFiles === 1 ? "1 file" : `${totalFiles} files`;
    const dest = destPathInput.value.trim() || "/agy";
    resultBox.innerHTML = `<strong>✓ Success!</strong> Successfully uploaded ${countText} (${formatBytes(totalBytes)}) to <code>${escapeHtml(dest)}</code>`;
  } else {
    resultBox.className = "result-box error";
    resultBox.innerHTML = `<strong>Upload summary:</strong> ${successCount} succeeded, ${failCount} failed.<br>` +
      `<ul style="margin: 6px 0 0 16px; padding: 0; font-family: monospace; font-size: 12px;">` +
      errors.map(e => `<li>${escapeHtml(e)}</li>`).join("") +
      `</ul>`;
  }
}

btnUpload.addEventListener("click", startUpload);
