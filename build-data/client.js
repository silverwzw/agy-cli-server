const url = new URL(location.href);
const secure_protocol = url.protocol === "https:";
const protocol = secure_protocol ? "wss" : "ws";

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

term.open(term_div);
addon_fit.fit();

socket.on("connect", () => {
  console.log(`socket.io: connected via ${socket.io.engine.transport.name} mode`); 
});

socket.on("s.joinSuccess", () => {
  addon_fit.fit();
  socket.emit("t.resize", { cols: term.cols, rows: term.rows });
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

term.onData((data) => {
  socket.emit("t.c2s", data);
});

let debounceTimerHandle = null;
window.addEventListener('resize', () => {
  clearTimeout(debounceTimerHandle);
  debounceTimerHandle = setTimeout(() => {
    addon_fit.fit();
  }, 120);
});

term.onResize((size) => {
  socket.emit("t.resize", size);
});

// vim: set nu list listchars=trail\:· sw=4 ts=4 expandtab:
