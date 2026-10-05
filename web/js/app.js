function updateSignButton() {
  const button = $("btnSign");
  const help = $("signHelp");
  if (!button) return;
  const plan = signPlanInfo();
  button.textContent = plan.docs
    ? `Firmar ${plan.docs} documento(s) · ${plan.pages} página(s)`
    : "Firmar documentos";
  let message = "";
  if (!state.signature) message = "Falta cargar tu firma (paso 1).";
  else if (!plan.docs) message = "Carga al menos un PDF (paso 2).";
  else if (!plan.pages) message = "Ningún documento tiene páginas seleccionadas (paso 3).";
  else if (plan.bad) message = plan.bad;
  button.disabled = !!message;
  if (help) {
    help.hidden = !message;
    help.textContent = message;
  }
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
      const pdf = await loadPdf(buffer, currentPassword());
      const image = await pdf.embedPng(state.signature.bytes);
      const all = pages === null;
      const targets = all ? Array.from({ length: pdf.getPageCount() }, (_, n) => n) : pages;
      let signed = 0;
      for (const index of targets) {
        if (index < 0 || index >= pdf.getPageCount()) continue;
        const page = pdf.getPage(index);
        const { width, height } = page.getSize();
        const rect = computePdfRect(width, height, effectiveLayout(doc.id, index + 1));
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
  updateSignButton();
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
  renderRejected();
  updatePageHint();
}

function bindSignatureUi() {
  bindDrop("sigBox", "sigInput", uploadSignature);

  $("btnClearSig").onclick = () => {
    if (state.signature) URL.revokeObjectURL(state.signature.url);
    state.signature = null;
    $("sigPreview").hidden = true;
    $("sigBox").querySelector(".dropText").hidden = false;
    $("sigOverlay").hidden = true;
    $("btnClearSig").hidden = true;
    $("sigBox2").hidden = true;
    $("btnSign").disabled = true;
    updateSignButton();
  };
}

function bindDocsUi() {
  bindDrop("pdfBox", "pdfInput", uploadPdfs);

  $("btnClearPdfs").onclick = async () => {
    state.docs = [];
    state.selectedPages = {};
    state.results = [];
    state.rejected = [];
    state.selectedDoc = null;
    await closePdf();
    renderRejected();
    renderDocs();
    clearStage();
    $("signSummary").textContent = "";
    $("resultList").innerHTML = "";
  };

  $("docSelect").onchange = (event) => openDoc(event.target.value, 1);
}

function bindViewerUi() {
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
}

function bindPositionUi() {
  $("modeSelect").onchange = (event) => applyMode(event.target.value);
  bindNumber("fx", (v) => pushLayout({ fx: Math.min(v / 100, 1 - currentEditLayout().fw) }));
  bindNumber("fy", (v) => pushLayout({ fy: Math.min(Math.max(v / 100, 0), 1) }));
  bindNumber("fw", (v) => pushLayout({ fw: Math.min(Math.max(v / 100, 0.01), 1) }));
  bindNumber("absX", (v) => pushLayout({ x: Math.max(v, 0) }));
  bindNumber("absY", (v) => pushLayout({ y: Math.max(v, 0) }));
  bindNumber("absW", (v) => pushLayout({ w: Math.min(Math.max(v, 1), 5000) }));

  $("posMode").onchange = (event) => setPositionMode(event.target.value);
  $("btnApplyAll").onclick = applyToAllPages;
  $("btnApplyRange").onclick = applyToRange;
  $("btnResetPage").onclick = resetPageLayout;

  const presetRow = $("presetRow");
  if (presetRow) {
    presetRow.querySelectorAll("[data-preset]").forEach((button) => {
      button.onclick = () => applyPreset(button.dataset.preset);
    });
  }
}

function bindSignUi() {
  $("btnSign").onclick = startSigning;
  $("btnZip").onclick = downloadZip;
  $("btnReset").onclick = () => {
    const hayTrabajo = state.docs.length || state.signature || state.rejected.length;
    if (hayTrabajo && !confirm("Se perderán la firma y los documentos cargados.\n¿Empezar de nuevo?")) return;
    location.reload();
  };

  window.addEventListener("resize", drawSignature);
}

function bindUi() {
  bindSignatureUi();
  bindDocsUi();
  bindViewerUi();
  bindPositionUi();
  bindSignUi();
}

bindUi();
initDrag();
init().catch((error) => toast(error.message, "bad"));
