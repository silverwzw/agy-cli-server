const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const destPathInput = document.getElementById("dest-path");
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
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function computeTargetPath(file, totalCount) {
  let dest = destPathInput.value.trim().replace(/\\/g, "/") || "/agy";
  if (totalCount > 1 || dest.endsWith("/") || !dest.includes(".")) {
    return (dest.replace(/\/+$/, "") + "/" + file.name).replace(/\/+/g, "/");
  }
  return dest;
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
    if (item.status !== "done" || !item.target) {
      item.target = computeTargetPath(item.file, pendingFiles.length);
    }
    const target = item.target;
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

    return `
      <div class="file-item" data-idx="${idx}">
        <div class="file-item-info">
          <div class="file-item-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div>
          <div class="file-item-sub" title="${escapeHtml(target)}">↳ ${escapeHtml(target)} &bull; ${formatBytes(item.file.size)}</div>
        </div>
        <div class="file-item-actions">
          <span class="file-status-badge ${badgeClass}">${badgeText}</span>
          ${removeBtn}
        </div>
      </div>
    `;
  }).join("");
}

function updateItemBadge(idx, status, badgeText) {
  const itemEl = fileList.querySelector(`.file-item[data-idx="${idx}"]`);
  if (!itemEl) return;
  const badge = itemEl.querySelector(".file-status-badge");
  if (!badge) return;
  badge.className = `file-status-badge status-${status}`;
  badge.innerText = badgeText;
}

function addFiles(fileListInput) {
  if (isUploading) return;
  const newFiles = Array.from(fileListInput);
  for (const file of newFiles) {
    const exists = selectedFiles.some(item => item.file.name === file.name && item.file.size === file.size);
    if (!exists) {
      selectedFiles.push({ file, status: "pending", pct: 0, target: "" });
    }
  }
  renderFileList();
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

["dragleave", "drop"].forEach(event => {
  dropZone.addEventListener(event, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove("dragover");
  });
});

dropZone.addEventListener("drop", (e) => {
  if (!isUploading && e.dataTransfer?.files?.length > 0) {
    addFiles(e.dataTransfer.files);
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
  const btn = e.target.closest(".btn-remove");
  if (!btn) return;
  const idx = parseInt(btn.getAttribute("data-idx"), 10);
  if (!isNaN(idx) && idx >= 0 && idx < selectedFiles.length) {
    selectedFiles.splice(idx, 1);
    renderFileList();
  }
});

function uploadSingleFile(file, target, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", "/control/upload?path=" + encodeURIComponent(target));
    try {
      xhr.setRequestHeader("X-File-Path", encodeURI(target));
      xhr.setRequestHeader("X-File-Name", encodeURI(file.name));
    } catch (_) {}

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

  let queue = selectedFiles.filter(item => item.status !== "done");
  if (queue.length === 0) return;

  isUploading = true;
  btnUpload.disabled = true;
  destPathInput.disabled = true;
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

  for (let i = 0; i < totalFiles; i++) {
    const item = queue[i];
    const itemIdx = selectedFiles.indexOf(item);
    item.status = "uploading";
    item.pct = 0;
    updateItemBadge(itemIdx, "uploading", "0%");

    const target = item.target || computeTargetPath(item.file, totalFiles);
    item.target = target;
    progressStatus.innerText = `Uploading (${i + 1}/${totalFiles}): ${item.file.name}...`;

    try {
      await uploadSingleFile(item.file, target, (loaded) => {
        item.pct = item.file.size > 0 ? Math.min(100, Math.round((loaded / item.file.size) * 100)) : 100;
        updateItemBadge(itemIdx, "uploading", `${item.pct}%`);

        const currentOverallLoaded = completedBytesBeforeCurrent + loaded;
        const overallPct = totalBytes > 0 ? ((currentOverallLoaded / totalBytes) * 100).toFixed(1) : "100.0";
        progressFill.style.width = overallPct + "%";
        progressPct.innerText = `${overallPct}% (${formatBytes(currentOverallLoaded)} / ${formatBytes(totalBytes)})`;
      });

      item.status = "done";
      item.pct = 100;
      item.target = target;
      updateItemBadge(itemIdx, "success", "✓ Done");
      successCount++;
    } catch (err) {
      item.status = "error";
      item.error = err.message || "Upload failed";
      updateItemBadge(itemIdx, "error", "✕ Failed");
      failCount++;
      errors.push(`${item.file.name}: ${item.error}`);
    }

    completedBytesBeforeCurrent += item.file.size;
    const currentProgressPct = totalBytes > 0 ? ((completedBytesBeforeCurrent / totalBytes) * 100).toFixed(1) : "100.0";
    progressFill.style.width = currentProgressPct + "%";
    progressPct.innerText = `${currentProgressPct}% (${formatBytes(completedBytesBeforeCurrent)} / ${formatBytes(totalBytes)})`;
  }

  isUploading = false;
  btnUpload.disabled = false;
  destPathInput.disabled = false;
  btnClear.disabled = false;
  renderFileList();

  progressStatus.innerText = failCount === 0 ? "Upload Complete!" : "Upload Completed with Errors";
  resultBox.style.display = "block";

  if (failCount === 0) {
    resultBox.className = "result-box success";
    const countText = totalFiles === 1 ? "1 file" : `${totalFiles} files`;
    const dest = totalFiles === 1 && queue[0]?.target ? queue[0].target : (destPathInput.value.trim() || "/agy");
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
