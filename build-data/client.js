const url = new URL(location.href);
const secure_protocol = url.protocol === "https:";
const protocol = secure_protocol ? "wss" : "ws";
const socket = io();

const term_div = document.getElementById("terminal");
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
  addon_fit.fit();
  socket.emit("t.resize", { cols: term.cols, rows: term.rows });
});

socket.io.engine.on("upgrade", (transport) => {
  console.log(`socket.io: transport upgraded to ${transport.name} mode`);
});

socket.io.engine.on("upgradeError", (err) => {
  console.error("Socket.IO upgrade error:", err);
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

// term.onSelectionChange((e) => {
//   const selection = term.getSelection();
//   if (selection && secure_protocol ) {
//     try {
//       navigator.clipboard.writeText(selection);
// 	} catch (err) {
// 	  console.error(err);
// 	  alert("Failed to write to clipboard.");
// 	}
//   }
// });
// 
// term_div.addEventListener("contextmenu", (e) => {
//   term.paste("Cannot paste\nbecause not in secure context");
//   e.preventDefault();
// });
