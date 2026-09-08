const url = new URL(location.href);
const secure_protocol = url.protocol === "https:"
const protocol = secure_protocol ? "wss" : "ws";
const socket = io(`${protocol}://${url.host}`);

const term_div = document.getElementById("terminal");
const term = new Terminal();

term.open(term_div);

socket.on("connect", () => {
  console.log(`socket.io: connected via ${socket.io.engine.transport.name} mode`); 
});

socket.io.engine.on("upgrade", (transport) => {
  console.log(`socket.io: transport upgraded to ${transport.name} mode`);
});

socket.io.engine.on("upgradeError", (err) => {
  console.error("Socket.IO upgrade error:", err);
});

socket.on("t.incomingData", (data) => {
  term.write(data);
});

term.onData((data) => {
  socket.emit("t.keystroke", data);
});

term.onSelectionChange((e) => {
  const selection = term.getSelection();
  if (selection && secure_protocol ) {
    try {
      navigator.clipboard.writeText(selection);
	} catch (err) {
	  console.error(err);
	  alert("Failed to write to clipboard.");
	}
  }
});

term_div.addEventListener("contextmenu", (e) => {
  term.paste("Cannot paste\nbecause not in secure context");
  e.preventDefault();
});
