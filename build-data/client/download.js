function copyFromElement(id) {
  const el = document.getElementById(id);
  if (!el || !navigator.clipboard?.writeText) return;

  navigator.clipboard.writeText(el.innerText);
}

function triggerDirectDownload() {
  const directUrl = document.getElementById("direct-download-link")?.getAttribute("href");
  if (!directUrl) return;

  const a = document.createElement("a");
  a.href = directUrl;
  a.click();
}

window.copyFromElement = copyFromElement;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", triggerDirectDownload);
} else {
  triggerDirectDownload();
}
