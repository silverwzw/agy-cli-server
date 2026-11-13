// ===============================================
//                 Global Setup
// ===============================================

const pathParts = window.location.pathname.split("/").filter(Boolean);
let sessionMode = "";
let sessionName = "";

if (pathParts.length >= 2 && (pathParts[0] === "a" || pathParts[0] === "s")) {
  sessionMode = pathParts[0];
  try {
    sessionName = decodeURIComponent(pathParts[1]).trim();
  } catch (_) {
    sessionName = pathParts[1].trim();
  }
}

const term_div = document.getElementById("terminal");

function showError(err) {
  term_div.style.color = "#ff5555";
  term_div.style.padding = "20px";
  term_div.style.fontFamily = "monospace";
  term_div.style.fontSize = "16px";

  let msg = err?.message || (typeof err === "string" ? err : "");
  if (!msg && err) {
    try {
      msg = JSON.stringify(err, null, 2);
    } catch (_) {
      msg = String(err);
    }
  }
  term_div.innerText = msg || "Unknown error";
}

if (!sessionName) {
  showError("Error: Invalid or missing session name. Expected URL format: /a/<name> or /s/<name>");
  throw new Error("Missing or invalid session name");
}

document.title = `${sessionName} - Web Terminal`;

// ===============================================
//                 xterm Setup
// ===============================================

function linkHandlerActivate(event, url) {
  if (!url || typeof url !== "string") return;

  console.log(`Opening link uri: ${url}`);

  let targetUrl = url;
  if (url.startsWith("file:///")) try {
    const parsed = new URL(url);
    const rawPath = parsed.pathname.replace(/^\/+/, "");
    if (!rawPath) return;

    targetUrl = `/control/viewer/abs/${rawPath}`;
    const hash = parsed.hash.replace(/^#/, "").trim();
    if (hash) {
      const singleMatch = hash.match(/^L?(\d+)$/i);
      if (singleMatch) {
        targetUrl += `?line=${singleMatch[1]}`;
      } else {
        const rangeMatch = hash.match(/^L?(\d+)-L?(\d+)$/i);
        if (rangeMatch) {
          targetUrl += `?line=${rangeMatch[1]}-${rangeMatch[2]}`;
        }
      }
    }
  } catch (_) {
    return;
  }

  if (targetUrl.startsWith("/control/download/")) {
    targetUrl = targetUrl.replace(/#/g, "%23");
  }

  if (
    targetUrl.startsWith("/control/download/") ||
    targetUrl.startsWith("/control/viewer/") ||
    targetUrl.startsWith("http://") ||
    targetUrl.startsWith("https://")
  ) try {
    const a = document.createElement("a");
    a.href = targetUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (_) {
    window.open(targetUrl, "_blank");
  }
}

const term = new Terminal({
  // Search addon relies on proposed API
  allowProposedApi: true,
  linkHandler: {
    allowNonHttpProtocols: true,
    activate: linkHandlerActivate,
  },
});

const addon_fit = new FitAddon.FitAddon();
term.loadAddon(addon_fit);

const addon_clipboard = new ClipboardAddon.ClipboardAddon();
term.loadAddon(addon_clipboard);

term.loadAddon(new WebLinksAddon.WebLinksAddon());

const addon_image = new ImageAddon.ImageAddon();
term.loadAddon(addon_image);

const addon_progress = new ProgressAddon.ProgressAddon();
term.loadAddon(addon_progress);

const addon_search = new SearchAddon.SearchAddon({
  highlightLimit: 1000,
});
term.loadAddon(addon_search);

term.open(term_div);
addon_fit.fit();

let debounceTimerHandle = null;
window.addEventListener('resize', () => {
  // Handler must be registered after terminal has been attached to DOM
  clearTimeout(debounceTimerHandle);
  debounceTimerHandle = setTimeout(() => {
    addon_fit.fit();
  }, 120);
});

// ===============================================
//                 Socket Setup
// ===============================================


if (document.prerendering) {
  document.addEventListener("prerenderingchange", initSocket, { once: true });
} else {
  initSocket();
}

function initSocket() {
  const socket = io({
    query: {
      mode: sessionMode,
      name: sessionName,
    },
  });


  //
  // == Connection Management ==
  //

  socket.on("connect", () => {
    console.log(`socket.io: connected via ${socket.io.engine.transport.name} mode`); 
  });

  socket.on("connect_error", (err) => {
    console.error("Socket.IO connect error:", err);
    showError(err);
  });

  socket.on("error", (err) => {
    console.error("Socket.IO error:", err);
    showError(err);
  });

  socket.io.engine.on("upgrade", (transport) => {
    console.log(`socket.io: transport upgraded to ${transport.name} mode`);
  });

  socket.io.engine.on("upgradeError", (err) => {
    console.error("Socket.IO upgrade error:", err);
  });

  //
  // == Socket <-> xTerm ==
  //

  let isReplaying = false;
  // Monotonic generation token to invalidate stale async term.write() replay callbacks
  // when a new replay starts, the socket disconnects, or the session is aborted.
  let replayToken = 0;
  let pendingS2c = [];
  let isAborted = false;

  function syncTerminalSize() {
    addon_fit.fit();
    if (!isAborted) {
      socket.emit("t.resize", { cols: term.cols, rows: term.rows });
    }
  }

  socket.on("t.replay", (data) => {
    // Advance the replay token so any earlier in-flight term.write() callback becomes a no-op.
    const token = ++replayToken;
    isReplaying = true;
    term.options.disableStdin = true;
    term.reset();

    const replayText = typeof data === "string" ? data : "";
    term.write(replayText, () => {
      // Ignore stale callback if superseded by another replay, disconnect, or session abort.
      if (token !== replayToken) return;

      isReplaying = false;
      if (!isAborted) {
        term.options.disableStdin = false;
      }
      if (pendingS2c.length > 0) {
        const queued = pendingS2c.join("");
        pendingS2c = [];
        term.write(queued);
      }
      syncTerminalSize();
    });
  });

  socket.on("t.s2c", (data) => {
    if (isReplaying) {
      pendingS2c.push(data);
      return;
    }
    term.write(data);
  });

  const onDataHandler = term.onData((data) => {
    // Suppress terminal query responses (e.g. DSR/DA/OSC/DECRQM) emitted while replaying history.
    if (isReplaying || isAborted) return;
    socket.emit("t.c2s", data);
  });

  const onResizeHandler = term.onResize((size) => {
    if (isReplaying || isAborted) return;
    socket.emit("t.resize", size);
  });


  //
  // == Session Management ==
  //

  socket.on("s.joinSuccess", ({ hasReplay } = {}) => {
    if (hasReplay) {
      // Hold live t.s2c output and initial t.resize until t.replay completes.
      isReplaying = true;
      pendingS2c = [];
    } else {
      syncTerminalSize();
    }
  });

  socket.on("disconnect", () => {
    // Invalidate any pending replay callback so it cannot mutate state after disconnect.
    replayToken++;
    isReplaying = false;
    pendingS2c = [];
    if (!isAborted) {
      term.options.disableStdin = false;
    }
  });

  socket.on("s.aborted", () => {
    isAborted = true;
    // Invalidate any pending replay callback before tearing down the session.
    replayToken++;
    isReplaying = false;
    pendingS2c = [];
    term.options.disableStdin = true;
    onDataHandler.dispose();
    onResizeHandler.dispose();
    socket.disconnect();
  });
}

// =======================================================
//                  Progress Addon UI Handling
// =======================================================

const progressBar = document.getElementById("progress-bar");

addon_progress.onChange(({ state, value }) => {
  if (!progressBar) return;
  switch (state) {
    case 0:
      progressBar.style.opacity = "0";
      progressBar.style.width = "0%";
      break;
    case 1:
      progressBar.style.backgroundColor = "#38bdf8";
      progressBar.style.opacity = "1";
      progressBar.style.width = `${Math.min(Math.max(value, 0), 100)}%`;
      break;
    case 2:
      progressBar.style.backgroundColor = "#ef4444";
      progressBar.style.opacity = "1";
      progressBar.style.width = `${value > 0 ? value : 100}%`;
      break;
    case 3:
      progressBar.style.backgroundColor = "#a855f7";
      progressBar.style.opacity = "1";
      progressBar.style.width = "100%";
      break;
    case 4:
      progressBar.style.backgroundColor = "#f59e0b";
      progressBar.style.opacity = "1";
      progressBar.style.width = `${value}%`;
      break;
  }
});

// =======================================================
//                   Search Addon UI Handling
// =======================================================

const searchBar = document.getElementById("search-bar");
const searchInput = document.getElementById("search-input");
const searchCount = document.getElementById("search-count");
const searchPrev = document.getElementById("search-prev");
const searchNext = document.getElementById("search-next");
const searchClose = document.getElementById("search-close");

const searchOptions = {
  decorations: {
    matchBackground: "#444400",
    matchBorder: "#888800",
    matchOverviewRuler: "#ffff00",
    activeMatchBackground: "#ffaa00",
    activeMatchBorder: "#ffffff",
    activeMatchColorOverviewRuler: "#ffaa00",
  },
};

function doSearch(reverse = false, incremental = false) {
  const query = searchInput.value;
  if (!query) {
    addon_search.clearDecorations();
    searchCount.innerText = "";
    return;
  }
  const opts = incremental ? { ...searchOptions, incremental: true } : searchOptions;
  if (reverse) {
    addon_search.findPrevious(query, opts);
  } else {
    addon_search.findNext(query, opts);
  }
}

function openSearchBar() {
  searchBar.style.display = "flex";
  searchInput.focus();
  searchInput.select();
  if (searchInput.value) {
    doSearch(false);
  }
}

function closeSearchBar() {
  searchBar.style.display = "none";
  addon_search.clearDecorations();
  term.focus();
}

function isSearchBarOpen() {
  return searchBar.style.display !== "none";
}

addon_search.onDidChangeResults((e) => {
  if (!e || e.resultCount === 0) {
    searchCount.innerText = searchInput.value ? "0/0" : "";
  } else {
    searchCount.innerText = `${e.resultIndex + 1}/${e.resultCount}`;
  }
});

searchInput.addEventListener("input", () => {
  doSearch(false, true);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    doSearch(e.shiftKey);
  }
});

searchPrev.addEventListener("click", () => doSearch(true));
searchNext.addEventListener("click", () => doSearch(false));
searchClose.addEventListener("click", closeSearchBar);

term.attachCustomKeyEventHandler((e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key?.toLowerCase() === "f" || e.code === "KeyF")) {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "keydown") {
      openSearchBar();
    }
    return false;
  }
  if (e.key === "Escape" && isSearchBarOpen()) {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "keydown") {
      closeSearchBar();
    }
    return false;
  }
  return true;
});

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key?.toLowerCase() === "f" || e.code === "KeyF")) {
    e.preventDefault();
    openSearchBar();
  } else if (e.key === "Escape" && isSearchBarOpen()) {
    e.preventDefault();
    closeSearchBar();
  }
});

// vim: set nu list listchars=trail\:· sw=4 ts=4 expandtab:
