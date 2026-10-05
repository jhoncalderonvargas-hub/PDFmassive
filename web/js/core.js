const PT_PER_CM = 28.3465;

const state = {
  signature: null,
  aspect: 1,
  docs: [],
  selectedPages: {},
  rejected: [],
  preset: null,
  layout: { mode: "fraction", fx: 0.6, fy: 0.8, fw: 0.26, x: 0, y: 0, w: 6 },
  positionMode: "all",
  pageLayouts: {},
  page: { docId: null, index: 1, total: 0, widthPt: 0, heightPt: 0 },
  pdfDoc: null,
  pdfDocId: null,
  selectedDoc: null,
  results: [],
  busy: false,
};

const $ = (id) => document.getElementById(id);

function toast(message, kind = "") {
  const node = $("toast");
  node.textContent = message;
  node.className = "toast " + kind;
  node.hidden = false;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => (node.hidden = true), 6000);
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function genId() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
}

function cleanName(name) {
  const base = String(name || "").split(/[\\/]/).pop();
  const safe = base.replace(/[^\w\s.\-()[\]]/gu, "_").replace(/[ ._]+$/, "");
  return safe || "documento.pdf";
}

function outputName(name, suffix) {
  const stem = name.replace(/\.pdf$/i, "");
  const s = !suffix || suffix.startsWith("_") ? suffix : "_" + suffix;
  return `${stem}${s}.pdf`;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
