let lastClickedLine = null;

function parseQueryLine() {
  const params = new URLSearchParams(window.location.search);
  const lineParam = params.get("line");
  if (!lineParam) return null;
  const trimmed = lineParam.trim();
  const singleMatch = trimmed.match(/^(\d+)$/);
  if (singleMatch) {
    const line = parseInt(singleMatch[1], 10);
    return line >= 1 ? { start: line, end: line } : null;
  }
  const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
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
      navigator.clipboard.writeText(pathText).then(() => {
        const orig = copyPathBtn.textContent;
        copyPathBtn.textContent = "✓ Copied!";
        copyPathBtn.classList.add("copied");
        setTimeout(() => {
          copyPathBtn.textContent = orig;
          copyPathBtn.classList.remove("copied");
        }, 2000);
      });
    }
  });
}

// Copy Content or Selected Lines
const copyContentBtn = document.getElementById("btn-copy-content");
if (copyContentBtn) {
  copyContentBtn.addEventListener("click", () => {
    const current = parseQueryLine();
    let textToCopy = "";
    if (current) {
      const lines = [];
      for (let i = current.start; i <= current.end; i++) {
        const row = document.getElementById("L" + i);
        if (row) {
          lines.push(row.querySelector(".line-content")?.textContent || "");
        }
      }
      textToCopy = lines.join("\n");
    } else {
      const allRows = document.querySelectorAll(".line-row");
      textToCopy = Array.from(allRows)
        .map((r) => r.querySelector(".line-content")?.textContent || "")
        .join("\n");
    }

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(textToCopy).then(() => {
        const orig = copyContentBtn.textContent;
        copyContentBtn.textContent = "✓ Copied!";
        copyContentBtn.classList.add("copied");
        setTimeout(() => {
          copyContentBtn.textContent = orig;
          copyContentBtn.classList.remove("copied");
        }, 2000);
      });
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(initViewer, 60);
  });
} else {
  setTimeout(initViewer, 60);
}
