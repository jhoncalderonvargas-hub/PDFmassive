const PT_PER_CM = 28.3465;

pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

const state = {
  signature: null,
  aspect: 3,
  docs: [],
  selectedPages: {},
  layout: { mode: "fraction", fx: 0.6, fy: 0.8, fw: 0.26, x: 0, y: 0, w: 6 },
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

function parsePages(spec, pageCount) {
  const text = String(spec || "").trim().toLowerCase();
  if (["", "todas", "todos", "all", "*"].includes(text)) return { pages: null };
  if (["primera", "first"].includes(text)) return { pages: [0] };
  if (["ultima", "última", "last"].includes(text)) return { pages: [pageCount - 1] };

  const pages = [];
  for (const chunk of text.replace(/;/g, ",").replace(/\s/g, "").split(",")) {
    if (!chunk) continue;
    if (chunk.includes("-")) {
      const [head, tail] = chunk.split("-");
      if (!/^\d+$/.test(head) || !/^\d+$/.test(tail)) return { error: `Rango de páginas no válido: '${chunk}'` };
      let start = Number(head);
      let end = Number(tail);
      if (start > end) [start, end] = [end, start];
      for (let p = start - 1; p < end; p++) pages.push(p);
    } else {
      if (!/^\d+$/.test(chunk)) return { error: `Página no válida: '${chunk}'` };
      pages.push(Number(chunk) - 1);
    }
  }
  const valid = pages.filter((p) => p >= 0 && p < pageCount);
  if (!valid.length) return { pages: [] };
  return { pages: valid };
}

function applyMode(mode) {
  state.layout.mode = mode;
  $("modeSelect").value = mode;
  $("fractionBox").hidden = mode !== "fraction";
  $("absoluteBox").hidden = mode !== "absolute";
}

function renderDocs() {
  const list = $("docList");
  $("docCount").textContent = state.docs.length;
  $("btnClearPdfs").hidden = state.docs.length === 0;
  $("btnZip").hidden = !state.results.some((r) => r.state === "ok");

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
    row.innerHTML = `
      <div>
        <div class="name" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</div>
        <div class="sub"><span>${doc.pages} página(s) · ${(doc.size / 1048576).toFixed(2)} MB</span></div>
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

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ url, img });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("no se pudo leer la imagen")); };
    img.src = url;
  });
}

async function uploadSignature(files) {
  const file = files[0];
  if (!file) return;
  try {
    const { url, img } = await loadImageElement(file);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    if (!canvas.width || !canvas.height) throw new Error("imagen vacía");
    canvas.getContext("2d").drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("no se pudo convertir la imagen");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const displayUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));

    if (state.signature) URL.revokeObjectURL(state.signature.url);
    state.signature = { bytes, url: displayUrl };
    state.aspect = canvas.width / canvas.height;

    $("sigPreview").src = displayUrl;
    $("sigPreview").hidden = false;
    $("sigBox").querySelector(".dropText").hidden = true;
    $("sigOverlay").src = displayUrl;
    $("sigOverlay").hidden = false;
    $("btnClearSig").hidden = false;
    $("sigBox2").hidden = false;
    $("btnSign").disabled = false;
    toast(`Firma cargada (${file.name})`, "good");
    drawSignature();
  } catch (error) {
    toast(`No se pudo cargar la firma: ${error.message}`, "bad");
  }
}

function friendlyError(error) {
  const message = String((error && error.message) || error);
  if (/encrypt/i.test(message)) return "PDF protegido con contraseña (no compatible con esta versión)";
  if (/invalid|corrupt|parse/i.test(message)) return "El PDF está dañado o no es válido";
  return message.slice(0, 180);
}

async function inspectPdf(buffer) {
  let doc;
  try {
    doc = await PDFLib.PDFDocument.load(buffer, { throwOnInvalidObject: false, updateMetadata: false });
  } catch (error) {
    throw new Error(friendlyError(error));
  }
  const pages = doc.getPageCount();
  if (pages < 1) throw new Error("El PDF no tiene páginas");
  return { pages };
}

async function uploadPdfs(files) {
  const pdfs = Array.from(files).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) return toast("Selecciona archivos PDF", "bad");
  if (state.busy) return toast("Espera a que termine la carga anterior", "bad");

  state.busy = true;
  $("uploadProgress").hidden = false;
  $("uploadNote").textContent = `Leyendo ${pdfs.length} archivo(s)...`;

  const skipped = [];
  let added = 0;
  for (let index = 0; index < pdfs.length; index++) {
    const file = pdfs[index];
    try {
      const buffer = await file.arrayBuffer();
      const info = await inspectPdf(buffer);
      state.docs.push({
        id: genId(),
        file,
        name: cleanName(file.name),
        pages: info.pages,
        size: file.size,
      });
      added++;
    } catch (error) {
      skipped.push({ name: file.name, reason: error.message });
    }
    const done = index + 1;
    $("uploadBar").style.width = `${(done / pdfs.length) * 100}%`;
    $("uploadNote").textContent = `Leyendo ${done}/${pdfs.length} · ${added} cargados`;
    if (done % 5 === 0 || done === pdfs.length) renderDocs();
    await tick();
  }

  $("uploadProgress").hidden = true;
  $("uploadBar").style.width = "0%";
  $("uploadNote").textContent = added
    ? `${added} documento(s) cargados${skipped.length ? ` · ${skipped.length} omitidos: ${skipped.slice(0, 3).map((s) => s.name).join(", ")}` : ""}`
    : "No se cargó ningún PDF";
  state.busy = false;

  renderDocs();
  if (state.docs.length && !state.page.docId) await openDoc(state.docs[0].id);
}

async function removeDoc(docId) {
  const index = state.docs.findIndex((d) => d.id === docId);
  if (index < 0) return;
  const wasCurrent = state.selectedDoc === docId;
  state.docs.splice(index, 1);
  delete state.selectedPages[docId];
  if (wasCurrent) {
    await closePdf();
    state.selectedDoc = null;
    state.page.docId = null;
  }
  renderDocs();
  if (!state.docs.length) clearStage();
  else if (wasCurrent) await openDoc(state.docs[0].id);
}

async function closePdf() {
  if (state.pdfDoc) {
    try { await state.pdfDoc.destroy(); } catch { /* ignore */ }
  }
  state.pdfDoc = null;
  state.pdfDocId = null;
}

function clearStage() {
  state.page = { docId: null, index: 1, total: 0, widthPt: 0, heightPt: 0 };
  const canvas = $("pageCanvas");
  canvas.width = 0;
  canvas.height = 0;
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
  const doc = state.docs.find((d) => d.id === state.selectedDoc);
  if (!doc) return clearStage();
  const hasImage = state.page.widthPt > 0;
  if (hasImage) $("pageWrap").classList.add("loading");
  else $("stageEmptyInner").classList.add("loading");

  try {
    if (state.pdfDocId !== doc.id) {
      await closePdf();
      const buffer = await doc.file.arrayBuffer();
      state.pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
      state.pdfDocId = doc.id;
    }
    const total = state.pdfDoc.numPages;
    const index = Math.min(Math.max(state.page.index || 1, 1), total);
    const page = await state.pdfDoc.getPage(index);
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = $("pageCanvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

    const base = page.getViewport({ scale: 1 });
    state.page = { docId: doc.id, index, total, widthPt: base.width, heightPt: base.height };
    $("pageInput").max = total;
    $("pageInput").value = index;
    $("pageTotal").textContent = `/ ${total}`;
    $("stage").hidden = false;
    $("stageEmpty").hidden = true;
    $("sigBox2").hidden = !state.signature;
    $("btnSign").disabled = !state.signature;
    drawSignature();
  } catch (error) {
    toast(friendlyError(error), "bad");
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
  if (!state.signature || !state.page.widthPt) {
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
    `página ${state.page.index}/${state.page.total} · ${rect.widthPt.toFixed(0)}×${rect.heightPt.toFixed(0)} pt`,
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
}

function initDrag() {
  const box = $("sigBox2");
  const handle = $("sigHandle");
  const canvas = $("pageCanvas");
  let drag = null;

  box.addEventListener("pointerdown", (event) => {
    if (event.target === handle) return;
    event.preventDefault();
    drag = { type: "move", startX: event.clientX, startY: event.clientY, rect: layoutRect() };
    box.classList.add("active");
    box.setPointerCapture(event.pointerId);
  });

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    drag = { type: "resize", startX: event.clientX, rect: layoutRect() };
    box.classList.add("active");
    handle.setPointerCapture(event.pointerId);
  });

  const pxPerPt = () => (canvas.clientWidth / (state.page.widthPt || 1)) || 1;

  const onMove = (event) => {
    if (!drag) return;
    const scale = pxPerPt();
    const dxPt = (event.clientX - drag.startX) / scale;
    const dyPt = (event.clientY - drag.startY) / scale;
    const widthPt = state.page.widthPt;
    const heightPt = state.page.heightPt;

    if (drag.type === "move") {
      if (state.layout.mode === "fraction") {
        const fx = Math.min(Math.max((drag.rect.x + dxPt) / widthPt, 0), 1 - drag.rect.w / widthPt);
        const fy = Math.min(Math.max((drag.rect.y + dyPt) / heightPt, 0), 1 - drag.rect.h / heightPt);
        pushLayout({ fx, fy });
      } else {
        const x = Math.min(Math.max(drag.rect.x + dxPt, 0), widthPt - drag.rect.w);
        const y = Math.min(Math.max(drag.rect.y + dyPt, 0), heightPt - drag.rect.h);
        pushLayout({ x: x / PT_PER_CM, y: y / PT_PER_CM });
      }
    } else {
      const width = Math.min(Math.max(drag.rect.w + dxPt, 12), widthPt);
      if (state.layout.mode === "fraction") pushLayout({ fw: width / widthPt });
      else pushLayout({ w: width / PT_PER_CM });
    }
  };

  const onUp = (event) => {
    if (!drag) return;
    drag = null;
    box.classList.remove("active");
    try { event.target.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
  };

  box.addEventListener("pointermove", onMove);
  box.addEventListener("pointerup", onUp);
  box.addEventListener("pointercancel", onUp);
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);

  canvas.addEventListener("click", (event) => {
    if (!state.signature || !state.page.widthPt) return;
    const bounds = canvas.getBoundingClientRect();
    const scale = bounds.width / (state.page.widthPt || 1);
    const rect = layoutRect();
    const clickX = (event.clientX - bounds.left) / scale;
    const clickY = (event.clientY - bounds.top) / scale;
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

function computePdfRect(pageWidth, pageHeight) {
  const aspect = state.aspect || 1;
  let x, yTop, w;
  if (state.layout.mode === "fraction") {
    w = pageWidth * state.layout.fw;
    x = pageWidth * state.layout.fx;
    yTop = pageHeight * state.layout.fy;
  } else {
    w = state.layout.w * PT_PER_CM;
    x = state.layout.x * PT_PER_CM;
    yTop = state.layout.y * PT_PER_CM;
  }
  let h = w * aspect;
  if (w > pageWidth) { w = pageWidth; h = w * aspect; }
  if (h > pageHeight) { h = pageHeight; w = h / aspect; }
  x = Math.min(Math.max(x, 0), Math.max(pageWidth - w, 0));
  yTop = Math.min(Math.max(yTop, 0), Math.max(pageHeight - h, 0));
  return { x, y: pageHeight - yTop - h, width: w, height: h };
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

async function startSigning() {
  if (!state.signature) return toast("Carga la imagen de la firma", "bad");
  if (!state.docs.length) return toast("Carga al menos un PDF", "bad");
  if (state.busy) return;

  const plan = [];
  for (const doc of state.docs) {
    const spec = state.selectedPages[doc.id] ?? "todas";
    const parsed = parsePages(spec, doc.pages);
    if (parsed.error) return toast(`${doc.name}: ${parsed.error}`, "bad");
    if (parsed.pages && !parsed.pages.length) continue;
    plan.push({ doc, pages: parsed.pages });
  }
  if (!plan.length) return toast("Ningún documento tiene páginas seleccionadas", "bad");

  state.busy = true;
  $("btnSign").disabled = true;
  state.results = [];
  $("resultList").innerHTML = "";
  $("btnZip").hidden = true;
  $("signProgress").hidden = false;
  $("signBar").style.width = "0%";

  const suffixValue = ($("suffix").value || "").replace(/[\\/:*?"<>|]/g, "");
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < plan.length; i++) {
    const { doc, pages } = plan[i];
    try {
      const buffer = await doc.file.arrayBuffer();
      const pdf = await PDFLib.PDFDocument.load(buffer, { throwOnInvalidObject: false, updateMetadata: false });
      const image = await pdf.embedPng(state.signature.bytes);
      const all = pages === null;
      const targets = all ? Array.from({ length: pdf.getPageCount() }, (_, n) => n) : pages;
      let signed = 0;
      for (const index of targets) {
        if (index < 0 || index >= pdf.getPageCount()) continue;
        const page = pdf.getPage(index);
        const { width, height } = page.getSize();
        const rect = computePdfRect(width, height);
        page.drawImage(image, rect);
        signed++;
      }
      if (!signed) throw new Error("Ninguna página válida seleccionada");
      const bytes = await pdf.save({ useObjectStreams: true });
      const blob = new Blob([bytes], { type: "application/pdf" });
      state.results.push({
        id: doc.id,
        name: outputName(doc.name, suffixValue),
        state: "ok",
        pages: signed,
        size: blob.size,
        blob,
      });
      ok++;
    } catch (error) {
      state.results.push({ id: doc.id, name: doc.name, state: "error", msg: friendlyError(error) });
      failed++;
    }
    $("signBar").style.width = `${((i + 1) / plan.length) * 100}%`;
    $("signSummary").textContent = `Procesando ${i + 1}/${plan.length} · ${ok} firmados · ${failed} con error`;
    renderResults();
    await tick();
  }

  $("signSummary").textContent = `Terminado · ${ok} firmados · ${failed} con error · ${plan.length} procesados`;
  renderResults();
  toast(failed ? `Listo: ${ok} firmados, ${failed} con error` : `Listo: ${ok} documentos firmados`, failed ? "" : "good");
  state.busy = false;
  setTimeout(() => { $("signProgress").hidden = true; }, 1200);
  $("btnSign").disabled = false;
}

function renderResults() {
  const list = $("resultList");
  list.innerHTML = state.results
    .slice()
    .reverse()
    .map((result) => {
      if (result.state === "ok") {
        const info = `${result.pages} pág. · ${(result.size / 1024).toFixed(0)} KB · <a href="#" class="dl" data-id="${escapeHtml(result.id)}">guardar</a>`;
        return `<div class="resItem"><span class="name">${escapeHtml(result.name)}</span><span class="ok">${info}</span></div>`;
      }
      return `<div class="resItem"><span class="name">${escapeHtml(result.name)}</span><span class="bad">${escapeHtml(result.msg)}</span></div>`;
    })
    .join("");
  list.querySelectorAll("a.dl").forEach((link) => {
    link.onclick = (event) => {
      event.preventDefault();
      const result = state.results.find((r) => r.id === link.dataset.id);
      if (result && result.blob) saveBlob(result.blob, result.name);
    };
  });
  $("btnZip").hidden = !state.results.some((r) => r.state === "ok");
}

async function downloadZip() {
  const ok = state.results.filter((r) => r.state === "ok");
  if (!ok.length) return;
  const button = $("btnZip");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Preparando ZIP...";
  try {
    const zip = new JSZip();
    const used = {};
    for (const result of ok) {
      let name = result.name;
      if (used[name]) {
        used[name] += 1;
        name = `${name.replace(/\.pdf$/i, "")} (${used[name]}).pdf`;
      } else {
        used[name] = 1;
      }
      zip.file(name, result.blob);
    }
    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    saveBlob(blob, "documentos_firmados.zip");
  } catch (error) {
    toast(`Error al crear el ZIP: ${error.message}`, "bad");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function init() {
  applyMode(state.layout.mode);
  pushLayout({});
  renderDocs();
  updateReadout();
}

function bindUi() {
  bindDrop("sigBox", "sigInput", uploadSignature);
  bindDrop("pdfBox", "pdfInput", uploadPdfs);

  $("btnClearSig").onclick = () => {
    if (state.signature) URL.revokeObjectURL(state.signature.url);
    state.signature = null;
    $("sigPreview").hidden = true;
    $("sigBox").querySelector(".dropText").hidden = false;
    $("sigOverlay").hidden = true;
    $("btnClearSig").hidden = true;
    $("sigBox2").hidden = true;
    $("btnSign").disabled = true;
  };

  $("btnClearPdfs").onclick = async () => {
    state.docs = [];
    state.selectedPages = {};
    state.results = [];
    state.selectedDoc = null;
    await closePdf();
    renderDocs();
    clearStage();
    $("signSummary").textContent = "";
    $("resultList").innerHTML = "";
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

  $("modeSelect").onchange = (event) => applyMode(event.target.value);
  bindNumber("fx", (v) => pushLayout({ fx: Math.min(v / 100, 1 - state.layout.fw) }));
  bindNumber("fy", (v) => pushLayout({ fy: Math.min(Math.max(v / 100, 0), 1) }));
  bindNumber("fw", (v) => pushLayout({ fw: Math.min(Math.max(v / 100, 0.01), 1) }));
  bindNumber("absX", (v) => pushLayout({ x: Math.max(v, 0) }));
  bindNumber("absY", (v) => pushLayout({ y: Math.max(v, 0) }));
  bindNumber("absW", (v) => pushLayout({ w: Math.min(Math.max(v, 1), 5000) }));

  $("btnSign").onclick = startSigning;
  $("btnZip").onclick = downloadZip;
  $("btnReset").onclick = () => location.reload();

  window.addEventListener("resize", drawSignature);
}

bindUi();
initDrag();
init().catch((error) => toast(error.message, "bad"));
