const state = {
  sid: null,
  docs: [],
  hasSignature: false,
  aspect: 3,
  layout: { mode: "fraction", fx: 0.6, fy: 0.8, fw: 0.26, x: 0, y: 0, w: 6 },
  page: { docId: null, index: 1, total: 0, widthPt: 0, heightPt: 0, zoom: 1 },
  job: null,
  polling: null,
  selectedDoc: null,
  selectedPages: {},
  busy: false,
};

const $ = (id) => document.getElementById(id);
const PT_PER_CM = 28.3465;

function toast(message, kind = "") {
  const node = $("toast");
  node.textContent = message;
  node.className = "toast " + kind;
  node.hidden = false;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => (node.hidden = true), 6000);
}

async function api(path, options = {}) {
  const response = await fetch(`/api/session/${state.sid}${path}`, options);
  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { detail: text }; }
  }
  if (!response.ok) {
    const detail = data.detail || `Error ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}

async function init() {
  const created = await fetch("/api/session", { method: "POST" }).then((r) => r.json());
  state.sid = created.id;
  state.layout = created.layout;
  state.docs = created.documents;
  $("autoWorkers").textContent = created.max_workers || Math.min(16, navigator.hardwareConcurrency || 4);
  $("fx").value = (state.layout.fx * 100).toFixed(1);
  $("fy").value = (state.layout.fy * 100).toFixed(1);
  $("fw").value = (state.layout.fw * 100).toFixed(1);
  applyMode(state.layout.mode);
  renderDocs();
  syncSuffixToInputs();
  updateReadout();
}

function applyMode(mode) {
  $("modeSelect").value = mode;
  $("fractionBox").hidden = mode !== "fraction";
  $("absoluteBox").hidden = mode !== "absolute";
}

function syncSuffixToInputs() {
  document.querySelectorAll(".docItem").forEach((item) => {
    const field = item.querySelector(".pagesInput");
    if (field) field.value = state.selectedPages[item.dataset.id] ?? "todas";
  });
}

function selectedSpec(docId) {
  const node = document.querySelector(`.docItem[data-id="${docId}"] .pagesInput`);
  return node ? node.value.trim() : "todas";
}

function renderDocs() {
  const list = $("docList");
  $("docCount").textContent = state.docs.length;
  $("btnClearPdfs").hidden = state.docs.length === 0;
  $("btnZip").hidden = true;

  if (!state.docs.length) {
    list.innerHTML = '<div class="note">Aún no hay documentos.</div>';
    $("docSummary").textContent = "";
    $("docSelect").innerHTML = "";
    return;
  }

  const pages = state.docs.reduce((acc, d) => acc + d.pages, 0);
  $("docSummary").textContent = `${state.docs.length} documento(s), ${pages} página(s) en total`;

  const current = state.selectedDoc && state.docs.some((d) => d.id === state.selectedDoc)
    ? state.selectedDoc
    : state.docs[0].id;
  state.selectedDoc = current;

  list.innerHTML = "";
  for (const doc of state.docs) {
    const row = document.createElement("div");
    row.className = "docItem" + (doc.id === current ? " sel" : "");
    row.dataset.id = doc.id;
    const signed = doc.signed ? `<span class="pill">Firmado ✓</span>` : "";
    row.innerHTML = `
      <div>
        <div class="name" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</div>
        <div class="sub"><span>${doc.pages} página(s) · ${(doc.size / 1048576).toFixed(2)} MB</span>${signed}</div>
      </div>
      <input class="pagesInput" value="${escapeHtml(state.selectedPages[doc.id] ?? "todas")}" placeholder="todas" title="Páginas a firmar (todas, primera, ultima, 1,3,5-8)">
      <div class="actions">
        <button class="ghost open" type="button">Ver</button>
        <button class="ghost del" type="button" title="Quitar documento">✕</button>
      </div>`;
    row.querySelector(".open").onclick = () => openDoc(doc.id);
    row.querySelector(".del").onclick = () => removeDoc(doc.id);
    row.querySelector(".pagesInput").oninput = (event) => {
      state.selectedPages[doc.id] = event.target.value;
    };
    list.appendChild(row);
  }

  const select = $("docSelect");
  const previous = select.value;
  select.innerHTML = state.docs
    .map((d) => `<option value="${d.id}">${escapeHtml(d.name)} (${d.pages} pág.)</option>`)
    .join("");
  select.value = state.docs.some((d) => d.id === previous) ? previous : current;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function bindDrop(zoneId, inputId, handler) {
  const zone = $(zoneId);
  const input = $(inputId);
  zone.onclick = () => input.click();
  zone.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") input.click(); };
  zone.tabIndex = 0;
  input.onchange = () => { if (input.files.length) handler(input.files); input.value = ""; };
  ["dragenter", "dragover"].forEach((name) =>
    zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add("over"); }));
  ["dragleave", "drop"].forEach((name) =>
    zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove("over"); }));
  zone.addEventListener("drop", (event) => {
    const files = event.dataTransfer.files;
    if (files.length) handler(files);
  });
}

async function uploadSignature(files) {
  const file = files[0];
  const form = new FormData();
  form.append("file", file);
  try {
    const result = await api("/signature", { method: "POST", body: form });
    state.hasSignature = true;
    state.aspect = result.aspect;
    $("sigPreview").src = URL.createObjectURL(file);
    $("sigPreview").hidden = false;
    $("sigBox").querySelector(".dropText").hidden = true;
    $("sigOverlay").src = $("sigPreview").src;
    $("sigOverlay").hidden = false;
    $("btnClearSig").hidden = false;
    $("sigBox2").hidden = false;
    toast(`Firma cargada (${file.name})`, "good");
    drawSignature();
  } catch (error) {
    toast(error.message, "bad");
  }
}

async function uploadPdfs(files) {
  const pdfs = Array.from(files).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) return toast("Selecciona archivos PDF", "bad");
  if (state.busy) return toast("Espera a que termine la carga anterior", "bad");

  state.busy = true;
  $("uploadProgress").hidden = false;
  $("uploadNote").textContent = `Subiendo ${pdfs.length} archivo(s)...`;

  const batchSize = 40;
  let added = 0;
  const skipped = [];
  for (let index = 0; index < pdfs.length; index += batchSize) {
    const batch = pdfs.slice(index, index + batchSize);
    const form = new FormData();
    batch.forEach((file) => form.append("files", file, file.name));
    try {
      const result = await api("/documents", { method: "POST", body: form });
      added += result.added.length;
      skipped.push(...result.skipped);
      state.docs = result.session.documents;
      renderDocs();
    } catch (error) {
      toast(error.message, "bad");
      break;
    }
    const done = Math.min(index + batchSize, pdfs.length);
    $("uploadBar").style.width = `${(done / pdfs.length) * 100}%`;
    $("uploadNote").textContent = `Subiendo ${done}/${pdfs.length} · ${added} cargados`;
  }

  $("uploadProgress").hidden = true;
  $("uploadBar").style.width = "0%";
  $("uploadNote").textContent = added
    ? `${added} documento(s) cargados${skipped.length ? ` · ${skipped.length} omitidos: ${skipped.slice(0, 3).map((s) => s.name).join(", ")}` : ""}`
    : "No se cargó ningún PDF";
  state.busy = false;

  if (!state.selectedDoc && state.docs.length) await openDoc(state.docs[0].id);
}

async function removeDoc(docId) {
  try {
    const result = await api(`/documents/${docId}`, { method: "DELETE" });
    state.docs = result.session.documents;
    delete state.selectedPages[docId];
    if (state.selectedDoc === docId) state.page.docId = null;
    renderDocs();
    if (!state.docs.length) clearStage();
    else if (state.selectedDoc) await openDoc(state.selectedDoc);
  } catch (error) {
    toast(error.message, "bad");
  }
}

function clearStage() {
  state.page = { docId: null, index: 1, total: 0, widthPt: 0, heightPt: 0, zoom: 1 };
  $("pageImg").removeAttribute("src");
  $("stage").hidden = true;
  $("stageEmpty").hidden = false;
  $("stageEmptyInner").classList.remove("loading");
  $("pageWrap").classList.remove("loading");
  $("pageTotal").textContent = "/ ?";
  $("pageInput").value = 1;
  updateReadout();
}

async function openDoc(docId, pageIndex = 1) {
  state.selectedDoc = docId;
  state.page.index = pageIndex;
  renderDocs();
  await loadPage();
}

async function loadPage() {
  const docId = $("docSelect").value || state.selectedDoc;
  if (!docId) return clearStage();
  state.selectedDoc = docId;
  const hasImage = Boolean($("pageImg").getAttribute("src"));
  if (hasImage) $("pageWrap").classList.add("loading");
  else $("stageEmptyInner").classList.add("loading");
  try {
    const info = await api(`/page?doc_id=${encodeURIComponent(docId)}&page=${state.page.index}&zoom=1.7`);
    const image = $("pageImg");
    image.src = "data:image/png;base64," + info.png;
    if (image.decode) await image.decode().catch(() => {});
    state.page = {
      docId,
      index: info.page,
      total: info.total_pages,
      widthPt: info.width_pt,
      heightPt: info.height_pt,
    };
    $("pageInput").max = info.total_pages;
    $("pageInput").value = info.page;
    $("pageTotal").textContent = `/ ${info.total_pages}`;
    $("stage").hidden = false;
    $("stageEmpty").hidden = true;
    $("sigBox2").hidden = !state.hasSignature;
    $("btnSign").disabled = !state.hasSignature;
    drawSignature();
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    $("pageWrap").classList.remove("loading");
    $("stageEmptyInner").classList.remove("loading");
  }
}

function layoutRect() {
  const widthPt = state.page.widthPt || 612;
  const heightPt = state.page.heightPt || 792;
  let x, y, w;
  if (state.layout.mode === "fraction") {
    w = widthPt * state.layout.fw;
    x = widthPt * state.layout.fx;
    y = heightPt * state.layout.fy;
  } else {
    w = state.layout.w * PT_PER_CM;
    x = state.layout.x * PT_PER_CM;
    y = state.layout.y * PT_PER_CM;
  }
  const h = w * state.aspect;
  return { x, y, w, h, widthPt, heightPt };
}

function drawSignature() {
  if (!state.hasSignature || !state.page.widthPt) {
    $("sigBox2").hidden = true;
    return;
  }
  const box = $("sigBox2");
  box.hidden = false;
  const rect = layoutRect();
  box.style.left = `${(rect.x / rect.widthPt) * 100}%`;
  box.style.top = `${(rect.y / rect.heightPt) * 100}%`;
  box.style.width = `${(rect.w / rect.widthPt) * 100}%`;
  box.style.height = `${(rect.h / rect.heightPt) * 100}%`;
  updateReadout();
}

function updateReadout() {
  if (!state.page.widthPt) {
    $("readout").textContent = "Sin página cargada";
    return;
  }
  const rect = layoutRect();
  const cm = (v) => (v / PT_PER_CM).toFixed(2);
  const text = [
    `página ${state.page.docId ? "" : ""}${state.page.index}/${state.page.total} · ${rect.widthPt}×${rect.heightPt} pt`,
    `x ${rect.x.toFixed(1)} pt (${cm(rect.x)} cm) · y ${rect.y.toFixed(1)} pt (${cm(rect.y)} cm)`,
    `ancho ${rect.w.toFixed(1)} pt (${cm(rect.w)} cm) · alto ${rect.h.toFixed(1)} pt (${cm(rect.h)} cm)`,
    state.layout.mode === "fraction"
      ? `fracción ${(state.layout.fx * 100).toFixed(1)}% / ${(state.layout.fy * 100).toFixed(1)}% · ancho ${(state.layout.fw * 100).toFixed(1)}%`
      : "modo absoluto (cm)",
  ].join("\n");
  $("readout").textContent = text;
}

function pushLayout(patch) {
  Object.assign(state.layout, patch);
  $("fx").value = (state.layout.fx * 100).toFixed(1);
  $("fy").value = (state.layout.fy * 100).toFixed(1);
  $("fw").value = (state.layout.fw * 100).toFixed(1);
  $("absX").value = state.layout.x.toFixed(2);
  $("absY").value = state.layout.y.toFixed(2);
  $("absW").value = state.layout.w.toFixed(2);
  drawSignature();
  saveLayout();
}

let layoutTimer = null;
function saveLayout() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => {
    api("/layout", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.layout),
    }).catch(() => {});
  }, 400);
}

function initDrag() {
  const box = $("sigBox2");
  const handle = $("sigHandle");
  let drag = null;

  box.addEventListener("pointerdown", (event) => {
    if (event.target === handle) return;
    event.preventDefault();
    const rect = layoutRect();
    drag = { type: "move", startX: event.clientX, startY: event.clientY, rect };
    box.classList.add("active");
    box.setPointerCapture(event.pointerId);
  });

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = layoutRect();
    drag = { type: "resize", startX: event.clientX, rect };
    box.classList.add("active");
    handle.setPointerCapture(event.pointerId);
  });

  const onMove = (event) => {
    if (!drag) return;
    const image = $("pageImg");
    const pxPerPt = image.clientWidth / (state.page.widthPt || 1);
    const dxPt = (event.clientX - drag.startX) / pxPerPt;
    if (drag.type === "move") {
      const widthPt = state.page.widthPt;
      const heightPt = state.page.heightPt;
      if (state.layout.mode === "fraction") {
        const fx = Math.min(Math.max((drag.rect.x + dxPt) / widthPt, 0), 1 - drag.rect.w / widthPt);
        const fy = Math.min(Math.max((drag.rect.y + dy(event, drag)) / heightPt, 0), 1 - drag.rect.h / heightPt);
        pushLayout({ fx, fy });
      } else {
        const x = Math.min(Math.max(drag.rect.x + dxPt, 0), widthPt - drag.rect.w);
        const y = Math.min(Math.max(drag.rect.y + (event.clientY - drag.startY) / pxPerPt, 0), heightPt - drag.rect.h);
        pushLayout({ x: x / PT_PER_CM, y: y / PT_PER_CM });
      }
    } else {
      const widthPt = Math.min(Math.max(drag.rect.w + dxPt, 12), state.page.widthPt);
      if (state.layout.mode === "fraction") {
        pushLayout({ fw: widthPt / state.page.widthPt });
      } else {
        pushLayout({ w: widthPt / PT_PER_CM });
      }
    }
  };

  function dy(event, base) {
    const image = $("pageImg");
    const pxPerPt = image.clientWidth / (state.page.widthPt || 1);
    return (event.clientY - base.startY) / pxPerPt;
  }

  const onUp = (event) => {
    if (!drag) return;
    drag = null;
    box.classList.remove("active");
    if (event.target.releasePointerCapture) {
      try { event.target.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    }
  };

  box.addEventListener("pointermove", onMove);
  box.addEventListener("pointerup", onUp);
  box.addEventListener("pointercancel", onUp);
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);

  $("pageImg").addEventListener("click", (event) => {
    if (!state.hasSignature) return;
    const image = $("pageImg");
    const bounds = image.getBoundingClientRect();
    const pxPerPt = bounds.width / (state.page.widthPt || 1);
    const rect = layoutRect();
    const clickX = (event.clientX - bounds.left) / pxPerPt;
    const clickY = (event.clientY - bounds.top) / pxPerPt;
    if (state.layout.mode === "fraction") {
      pushLayout({
        fx: Math.min(Math.max((clickX - rect.w / 2) / state.page.widthPt, 0), 1),
        fy: Math.min(Math.max((clickY - rect.h / 2) / state.page.heightPt, 0), 1),
      });
    } else {
      pushLayout({
        x: Math.min(Math.max(clickX - rect.w / 2, 0), state.page.widthPt - rect.w) / PT_PER_CM,
        y: Math.min(Math.max(clickY - rect.h / 2, 0), state.page.heightPt - rect.h) / PT_PER_CM,
      });
    }
  });
}

function bindNumber(id, apply) {
  $(id).addEventListener("input", (event) => {
    const value = parseFloat(event.target.value);
    if (!Number.isNaN(value)) apply(value);
  });
}

async function startSigning() {
  if (!state.hasSignature) return toast("Carga la imagen de la firma", "bad");
  if (!state.docs.length) return toast("Carga al menos un PDF", "bad");
  if (state.busy) return;

  const password = $("pdfPassword").value;
  if (password) {
    try { await api("/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }); }
    catch (error) { return toast(error.message, "bad"); }
  }

  const documents = {};
  state.docs.forEach((doc) => { documents[doc.id] = { pages_spec: selectedSpec(doc.id) }; });
  const payload = {
    documents,
    optimize: $("optimize").checked,
  };

  state.busy = true;
  $("btnSign").disabled = true;
  $("resultList").innerHTML = "";
  $("signProgress").hidden = false;
  $("signBar").style.width = "0%";

  try {
    const started = await api("/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.job = started.job;
    pollJob();
  } catch (error) {
    toast(error.message, "bad");
    finishSigning();
  }
}

function pollJob() {
  clearInterval(state.polling);
  state.polling = setInterval(async () => {
    try {
      const data = await api(`/job/${state.job.id}`);
      const job = data.job;
      const percent = job.total ? Math.min(100, (job.done / job.total) * 100) : 100;
      $("signBar").style.width = `${percent}%`;
      $("signSummary").textContent =
        `${job.state === "done" ? "Terminado" : "Procesando"} · ${job.done}/${job.total} documentos · ${job.done_pages} páginas · ${job.workers} proceso(s)`;
      renderResults(job);
      if (job.state !== "running") {
        clearInterval(state.polling);
        state.polling = null;
        if (job.state === "done") toast(`Listo: ${job.total - job.failed} firmados, ${job.failed} con error`, job.failed ? "" : "good");
        else toast(job.error || "Error en el proceso", "bad");
        refreshDocs();
        finishSigning();
      }
    } catch (error) {
      clearInterval(state.polling);
      state.polling = null;
      toast(error.message, "bad");
      finishSigning();
    }
  }, 500);
}

function renderResults(job) {
  const list = $("resultList");
  list.innerHTML = job.results
    .slice()
    .reverse()
    .map((result) => {
      const ok = result.state === "ok";
      const info = ok
        ? `${result.pages} pág. · ${(result.bytes / 1024).toFixed(0)} KB · ${result.elapsed}s`
        : result.msg;
      const link = ok ? ` <a href="/api/session/${state.sid}/file/${result.id}?inline=true" target="_blank" rel="noopener">abrir</a>` : "";
      return `<div class="resItem"><span class="name">${escapeHtml(result.name)}${link}</span><span class="${ok ? "ok" : "bad"}">${escapeHtml(info)}</span></div>`;
    })
    .join("");
  $("btnZip").hidden = !job.results.some((r) => r.state === "ok");
  $("btnZip").href = `/api/session/${state.sid}/zip`;
}

function finishSigning() {
  state.busy = false;
  $("btnSign").disabled = false;
  setTimeout(() => { $("signProgress").hidden = true; }, 1200);
}

async function refreshDocs() {
  try {
    const session = await api("");
    state.docs = session.documents;
    renderDocs();
  } catch { /* ignore */ }
}

function bindUi() {
  bindDrop("sigBox", "sigInput", uploadSignature);
  bindDrop("pdfBox", "pdfInput", uploadPdfs);

  $("btnClearSig").onclick = async () => {
    await api("/signature", { method: "DELETE" }).catch(() => {});
    state.hasSignature = false;
    $("sigPreview").hidden = true;
    $("sigBox").querySelector(".dropText").hidden = false;
    $("sigOverlay").hidden = true;
    $("btnClearSig").hidden = true;
    $("sigBox2").hidden = true;
    $("btnSign").disabled = true;
  };

  $("btnClearPdfs").onclick = async () => {
    const list = state.docs.slice();
    for (const doc of list) {
      await api(`/documents/${doc.id}`, { method: "DELETE" }).catch(() => {});
    }
    state.docs = [];
    state.selectedPages = {};
    renderDocs();
    clearStage();
  };

  $("docSelect").onchange = (event) => openDoc(event.target.value, 1);
  $("prevPage").onclick = () => {
    if (state.page.index > 1) { state.page.index -= 1; loadPage(); }
  };
  $("nextPage").onclick = () => {
    if (state.page.index < state.page.total) { state.page.index += 1; loadPage(); }
  };
  $("pageInput").onchange = (event) => {
    const value = parseInt(event.target.value, 10);
    if (!Number.isNaN(value)) { state.page.index = value; loadPage(); }
  };

  $("modeSelect").onchange = (event) => pushLayout({ mode: event.target.value });
  bindNumber("fx", (v) => pushLayout({ fx: Math.min(v / 100, 1 - state.layout.fw) }));
  bindNumber("fy", (v) => pushLayout({ fy: Math.min(v / 100, 1) }));
  bindNumber("fw", (v) => pushLayout({ fw: Math.min(Math.max(v / 100, 0.01), 1) }));
  bindNumber("absX", (v) => pushLayout({ x: v }));
  bindNumber("absY", (v) => pushLayout({ y: v }));
  bindNumber("absW", (v) => pushLayout({ w: v }));

  $("btnSign").onclick = startSigning;

  $("btnReset").onclick = async () => {
    try { await api("", { method: "DELETE" }); } catch { /* ignore */ }
    location.reload();
  };

  window.addEventListener("resize", drawSignature);
}

bindUi();
initDrag();
init().catch((error) => toast(error.message, "bad"));
