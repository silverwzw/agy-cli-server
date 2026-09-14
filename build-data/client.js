const pathParts = window.location.pathname.split("/").filter(Boolean);
let sessionMode = "";
let sessionName = "";

if (pathParts.length >= 2 && (pathParts[0] === "a" || pathParts[0] === "s")) {
  sessionMode = pathParts[0];
  sessionName = decodeURIComponent(pathParts[1]).trim();
}

const term_div = document.getElementById("terminal");

function showError(err) {
  term_div.style.color = "#ff5555";
  term_div.style.padding = "20px";
  term_div.style.fontFamily = "monospace";
  term_div.style.fontSize = "16px";

  let msg;
  if (err && typeof err.message === "string") {
    msg = err.message;
  } else if (typeof err === "string") {
    msg = err;
  } else {
    try {
      msg = JSON.stringify(err) ?? "Unknown error";
    } catch (e) {
      console.error(e);
      msg = "unknown error, see console for details";
    }
  }
  term_div.innerText = msg;
}

if (!sessionName) {
  showError("Error: Invalid or missing session name. Expected URL format: /a/<name> or /s/<name>");
  throw new Error("Missing or invalid session name");
}

document.title = `${sessionName} - Web Terminal`;

const socket = io({
  query: {
    mode: sessionMode,
    name: sessionName,
  },
});

const term = new Terminal();

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

window.term = term;
window.addon_fit = addon_fit;
window.addon_clipboard = addon_clipboard;
window.addon_image = addon_image;
window.addon_progress = addon_progress;
window.addon_search = addon_search;

term.open(term_div);
addon_fit.fit();

socket.on("connect", () => {
  console.log(`socket.io: connected via ${socket.io.engine.transport.name} mode`); 
});

socket.on("s.joinSuccess", () => {
  addon_fit.fit();
  if (!isAborted) {
    socket.emit("t.resize", { cols: term.cols, rows: term.rows });
  }
});

socket.io.engine.on("upgrade", (transport) => {
  console.log(`socket.io: transport upgraded to ${transport.name} mode`);
});

socket.io.engine.on("upgradeError", (err) => {
  console.error("Socket.IO upgrade error:", err);
});

socket.on("connect_error", (err) => {
  console.error("Socket.IO connect error:", err);
  showError(err);
});

socket.on("error", (err) => {
  console.error("Socket.IO error:", err);
  showError(err);
});

socket.on("t.s2c", (data) => {
  term.write(data);
});

let isAborted = false;

socket.on("s.aborted", () => {
  isAborted = true;
  if (term.options) {
    term.options.disableStdin = true;
  }
  if (onDataHandler && onDataHandler.dispose) {
    onDataHandler.dispose();
  }
  if (onResizeHandler && onResizeHandler.dispose) {
    onResizeHandler.dispose();
  }
});

const onDataHandler = term.onData((data) => {
  if (isAborted) return;
  socket.emit("t.c2s", data);
});

let debounceTimerHandle = null;
window.addEventListener('resize', () => {
  clearTimeout(debounceTimerHandle);
  debounceTimerHandle = setTimeout(() => {
    addon_fit.fit();
  }, 120);
});

const onResizeHandler = term.onResize((size) => {
  if (isAborted) return;
  socket.emit("t.resize", size);
});

// =======================================================
//                  Progress Addon UI Handling
// =======================================================

const progressBar = document.getElementById("progress-bar");
const defaultTitle = document.title;

addon_progress.onChange(({ state, value }) => {
  if (!progressBar) return;
  switch (state) {
    case 0:
      progressBar.style.opacity = "0";
      progressBar.style.width = "0%";
      document.title = defaultTitle;
      break;
    case 1:
      progressBar.style.backgroundColor = "#38bdf8";
      progressBar.style.opacity = "1";
      progressBar.style.width = `${Math.min(Math.max(value, 0), 100)}%`;
      document.title = `(${value}%) ${defaultTitle}`;
      break;
    case 2:
      progressBar.style.backgroundColor = "#ef4444";
      progressBar.style.opacity = "1";
      progressBar.style.width = `${value > 0 ? value : 100}%`;
      document.title = `[!] (${value}%) ${defaultTitle}`;
      break;
    case 3:
      progressBar.style.backgroundColor = "#a855f7";
      progressBar.style.opacity = "1";
      progressBar.style.width = "100%";
      document.title = `(...) ${defaultTitle}`;
      break;
    case 4:
      progressBar.style.backgroundColor = "#f59e0b";
      progressBar.style.opacity = "1";
      progressBar.style.width = `${value}%`;
      document.title = `[Paused] (${value}%) ${defaultTitle}`;
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

function doSearch(reverse = false) {
  const query = searchInput ? searchInput.value : "";
  if (!query) {
    addon_search.clearDecorations();
    if (searchCount) searchCount.innerText = "";
    return;
  }
  if (reverse) {
    addon_search.findPrevious(query, searchOptions);
  } else {
    addon_search.findNext(query, searchOptions);
  }
}

function openSearchBar() {
  if (!searchBar) return;
  searchBar.style.display = "flex";
  if (searchInput) {
    searchInput.focus();
    searchInput.select();
    if (searchInput.value) {
      doSearch(false);
    }
  }
}

function closeSearchBar() {
  if (!searchBar) return;
  searchBar.style.display = "none";
  addon_search.clearDecorations();
  term.focus();
}

function isSearchBarOpen() {
  return searchBar && searchBar.style.display !== "none";
}

if (searchBar && searchInput) {
  addon_search.onDidChangeResults((e) => {
    if (!searchCount) return;
    if (!e || e.resultCount === 0) {
      searchCount.innerText = searchInput.value ? "0/0" : "";
    } else {
      searchCount.innerText = `${e.resultIndex + 1}/${e.resultCount}`;
    }
  });

  searchInput.addEventListener("input", () => {
    doSearch(false);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSearch(e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchBar();
    }
  });

  if (searchPrev) {
    searchPrev.addEventListener("click", () => doSearch(true));
  }
  if (searchNext) {
    searchNext.addEventListener("click", () => doSearch(false));
  }
  if (searchClose) {
    searchClose.addEventListener("click", closeSearchBar);
  }
}

term.attachCustomKeyEventHandler((e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    if (e.type === "keydown") {
      openSearchBar();
    }
    return false;
  }
  if (e.key === "Escape" && isSearchBarOpen()) {
    if (e.type === "keydown") {
      closeSearchBar();
    }
    return false;
  }
  return true;
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isSearchBarOpen()) {
    closeSearchBar();
  }
});

// vim: set nu list listchars=trail\:· sw=4 ts=4 expandtab:
