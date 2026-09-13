function copyFromElement(id, btn) {
  const el = document.getElementById(id);
  if (el) copyText(el.innerText, btn);
}

function copyText(text, btn) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.innerText;
      btn.innerText = "✓ Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.innerText = orig;
        btn.classList.remove("copied");
      }, 2000);
    });
  }
}

function triggerDirectDownload() {
  const retryLink = document.getElementById("direct-download-link") || document.querySelector(".retry-link");
  const directUrl = retryLink ? retryLink.getAttribute("href") : "";
  if (directUrl) {
    const a = document.createElement("a");
    a.href = directUrl;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { document.body.removeChild(a); } catch (_) {}
    }, 1000);
  }
}

window.copyFromElement = copyFromElement;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", triggerDirectDownload);
} else {
  triggerDirectDownload();
}
