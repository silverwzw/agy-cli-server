function copyFromElement(id, btn) {
  const el = document.getElementById(id);
  if (!el || !navigator.clipboard?.writeText) return;

  navigator.clipboard.writeText(el.innerText).then(() => {
    const orig = btn.innerText;
    btn.innerText = "✓ Copied!";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.innerText = orig;
      btn.classList.remove("copied");
    }, 2000);
  });
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
