let lastClickedLine = null;
let fileText = "";
let fileLines = [];

const escapeHtml = require("escape-html");

function parseQueryLine() {
  const params = new URLSearchParams(window.location.search);
  const lineParam = params.get("line");
  if (!lineParam) return null;
  const trimmed = lineParam.trim();
  const singleMatch = trimmed.match(/^L?(\d+)$/i);
  if (singleMatch) {
    const line = parseInt(singleMatch[1], 10);
    return line >= 1 ? { start: line, end: line } : null;
  }
  const rangeMatch = trimmed.match(/^L?(\d+)-L?(\d+)$/i);
  if (rangeMatch) {
    const n1 = parseInt(rangeMatch[1], 10);
    const n2 = parseInt(rangeMatch[2], 10);
    if (n1 >= 1 && n2 >= 1) {
      return { start: Math.min(n1, n2), end: Math.max(n1, n2) };
    }
  }
  return null;
}

function updateHighlights(start, end) {
  // Clear only the currently highlighted rows (O(M) where M is previous highlighted count)
  const currentlyHighlighted = document.querySelectorAll(".line-row.highlighted");
  currentlyHighlighted.forEach((el) => el.classList.remove("highlighted"));

  // Add highlight only to the target line range using direct ID lookup (O(K) where K is selected line count)
  if (start !== null && end !== null) {
    for (let i = start; i <= end; i++) {
      const row = document.getElementById("L" + i);
      if (row) {
        row.classList.add("highlighted");
      }
    }
  }

  const indicator = document.getElementById("line-indicator");
  if (indicator) {
    if (start === null) {
      indicator.textContent = "";
      indicator.style.display = "none";
    } else if (start === end) {
      indicator.textContent = `Line ${start}`;
      indicator.style.display = "inline-flex";
    } else {
      indicator.textContent = `Lines ${start}–${end}`;
      indicator.style.display = "inline-flex";
    }
  }
}

function setUrlLine(start, end) {
  const url = new URL(window.location.href);
  if (start === null) {
    url.searchParams.delete("line");
  } else if (start === end) {
    url.searchParams.set("line", String(start));
  } else {
    url.searchParams.set("line", `${start}-${end}`);
  }
  window.history.pushState(null, "", url.toString());
}

function scrollToLine(lineNum, smooth) {
  if (!lineNum || lineNum <= 1) {
    window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
    return;
  }
  const el = document.getElementById("L" + lineNum);
  if (el) {
    el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  }
}

// Handle line number clicks for interactive highlighting
document.addEventListener("click", (e) => {
  const lineNumEl = e.target.closest(".line-num");
  if (!lineNumEl) return;

  e.preventDefault();
  const clickedLine = parseInt(lineNumEl.getAttribute("data-line"), 10);
  if (isNaN(clickedLine)) return;

  let start = clickedLine;
  let end = clickedLine;

  if (e.shiftKey && lastClickedLine !== null) {
    start = Math.min(lastClickedLine, clickedLine);
    end = Math.max(lastClickedLine, clickedLine);
  } else {
    const current = parseQueryLine();
    if (current && current.start === clickedLine && current.end === clickedLine) {
      // Deselect if already selected
      start = null;
      end = null;
      lastClickedLine = null;
      updateHighlights(null, null);
      setUrlLine(null, null);
      return;
    }
    lastClickedLine = clickedLine;
  }

  updateHighlights(start, end);
  setUrlLine(start, end);
  scrollToLine(start, true);
});

// Toggle word wrap
const wrapBtn = document.getElementById("btn-toggle-wrap");
const codeWrapper = document.getElementById("code-wrapper");
if (wrapBtn && codeWrapper) {
  wrapBtn.addEventListener("click", () => {
    codeWrapper.classList.toggle("wrap-lines");
    const isWrapped = codeWrapper.classList.contains("wrap-lines");
    wrapBtn.textContent = isWrapped ? "Unwrap Lines" : "Wrap Lines";
  });
}

// Copy Path
const copyPathBtn = document.getElementById("btn-copy-path");
if (copyPathBtn) {
  copyPathBtn.addEventListener("click", () => {
    const pathText = copyPathBtn.getAttribute("data-path") || "";
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(pathText);
    }
  });
}

// Copy Content or Selected Lines
const copyContentBtn = document.getElementById("btn-copy-content");
if (copyContentBtn) {
  copyContentBtn.addEventListener("click", () => {
    const current = parseQueryLine();
    const textToCopy = current
      ? fileLines.slice(current.start - 1, current.end).join("\n")
      : fileText;

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(textToCopy);
    }
  });
}

// Initialize highlight and scroll to target line on page open
function initViewer() {
  const initial = parseQueryLine();
  if (initial) {
    updateHighlights(initial.start, initial.end);
    if (initial.start > 1) {
      scrollToLine(initial.start, true);
    }
  }
}

window.addEventListener("popstate", () => {
  const current = parseQueryLine();
  if (current) {
    updateHighlights(current.start, current.end);
    scrollToLine(current.start, true);
  } else {
    updateHighlights(null, null);
  }
});

// Fetch file content from /control/download and render lines DOM
async function loadFileContent() {
  const codeWrapper = document.getElementById("code-wrapper");
  const codeLines = document.getElementById("code-lines");
  const badgeLines = document.getElementById("badge-lines");
  if (!codeWrapper || !codeLines) return;

  const downloadUrl = codeWrapper.getAttribute("data-download-url") ||
    document.getElementById("btn-download")?.getAttribute("href") ||
    window.location.pathname.replace(/^\/control\/viewer\//, "/control/download/");
  const contentUrl = `${downloadUrl}${downloadUrl.includes("?") ? "&" : "?"}download=0`;

  try {
    const res = await fetch(contentUrl);
    if (!res.ok) {
      const errText = await res.text();
      if (badgeLines) badgeLines.textContent = "Error";
      codeLines.innerHTML = `<div class="error-row"><span class="error-text">Failed to load file content: ${escapeHtml(errText.trim() || res.statusText)}</span></div>`;
      return;
    }

    fileText = await res.text();
    if (fileText.length === 0) {
      fileLines = [];
    } else {
      fileLines = fileText.split(/\r?\n/);
      if (fileText.endsWith("\n") && fileLines[fileLines.length - 1] === "") {
        fileLines.pop();
      }
    }

    const totalLines = fileLines.length;
    const numDigits = Math.max(String(totalLines).length, 1);
    const gutterWidth = Math.max(48, numDigits * 9 + 24);
    codeWrapper.style.setProperty("--gutter-width", `${gutterWidth}px`);

    if (badgeLines) {
      badgeLines.textContent = `${totalLines} ${totalLines === 1 ? "line" : "lines"}`;
    }

    if (totalLines === 0) {
      codeLines.innerHTML = '<div class="empty-file-row"><span class="empty-file-text">Empty file (0 lines)</span></div>';
    } else {
      const rows = [];
      for (let i = 0; i < totalLines; i++) {
        const lineNum = i + 1;
        const escapedLine = escapeHtml(fileLines[i]);
        rows.push(
          `<div class="line-row" id="L${lineNum}" data-line="${lineNum}">` +
          `<a class="line-num" href="?line=${lineNum}" data-line="${lineNum}">${lineNum}</a>` +
          `<span class="line-content">${escapedLine}</span>` +
          `</div>`
        );
      }
      codeLines.innerHTML = rows.join("\n");
    }

    setTimeout(initViewer, 20);
  } catch (err) {
    if (badgeLines) badgeLines.textContent = "Error";
    codeLines.innerHTML = `<div class="error-row"><span class="error-text">Network error loading file content: ${escapeHtml(err.message || String(err))}</span></div>`;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", loadFileContent);
} else {
  loadFileContent();
}
