function applyMode(mode) {
  const target = currentEditLayout();
  target.mode = mode;
  syncLayoutInputs(target);
  updatePosBar();
  drawSignature();
}

function updatePosBar() {
  const bar = $("posPageBar");
  if (!bar) return;
  bar.hidden = state.positionMode !== "page";
  const doc = currentDoc();
  const info = $("posInfo");
  if (!info) return;
  if (!doc) {
    info.textContent = "Abre un documento para corregir la posición página por página.";
    return;
  }
  const custom = hasPageOverride(doc.id, state.page.index);
  info.innerHTML = `Página <strong>${state.page.index}/${state.page.total || doc.pages}</strong> de <strong>${escapeHtml(doc.name)}</strong> · posición: <strong>${custom ? "personalizada" : "heredada de la general"}</strong>`;
}

function syncLayoutInputs(layout) {
  $("modeSelect").value = layout.mode;
  $("fractionBox").hidden = layout.mode !== "fraction";
  $("absoluteBox").hidden = layout.mode !== "absolute";
  const presets = $("presetRow");
  if (presets) presets.hidden = layout.mode !== "fraction";
  $("fx").value = (layout.fx * 100).toFixed(1);
  $("fy").value = (layout.fy * 100).toFixed(1);
  $("fw").value = (layout.fw * 100).toFixed(1);
  $("absX").value = layout.x.toFixed(2);
  $("absY").value = layout.y.toFixed(2);
  $("absW").value = layout.w.toFixed(2);
}

function applyToAllPages() {
  const doc = currentDoc();
  if (!doc) return toast("Abre un documento en el visor", "bad");
  const layout = { ...currentPageLayout() };
  const map = (state.pageLayouts[doc.id] = state.pageLayouts[doc.id] || {});
  for (let i = 1; i <= doc.pages; i++) map[i] = { ...layout };
  updatePosBar();
  drawSignature();
  toast(`Posición aplicada a las ${doc.pages} página(s) de ${doc.name}`, "good");
}

function applyToRange() {
  const doc = currentDoc();
  if (!doc) return toast("Abre un documento en el visor", "bad");
  const spec = $("rangeInput").value;
  const parsed = parsePages(spec, doc.pages);
  if (parsed.error) return toast(parsed.error, "bad");
  const pages = parsed.pages === null
    ? Array.from({ length: doc.pages }, (_, i) => i)
    : parsed.pages;
  if (!pages.length) return toast("Ese rango no incluye páginas válidas de este documento", "bad");
  const layout = { ...currentPageLayout() };
  const map = (state.pageLayouts[doc.id] = state.pageLayouts[doc.id] || {});
  pages.forEach((i) => { map[i + 1] = { ...layout }; });
  updatePosBar();
  drawSignature();
  toast(`Posición aplicada a ${pages.length} página(s) de ${doc.name}`, "good");
}

function resetPageLayout() {
  const doc = currentDoc();
  if (!doc) return toast("Abre un documento en el visor", "bad");
  if (state.pageLayouts[doc.id]) delete state.pageLayouts[doc.id][state.page.index];
  syncLayoutInputs(currentPageLayout());
  updatePosBar();
  drawSignature();
  toast("Esta página vuelve a la posición general", "good");
}

function setPositionMode(mode) {
  state.positionMode = mode === "page" ? "page" : "all";
  syncLayoutInputs(currentPageLayout());
  updatePosBar();
  drawSignature();
  toast(
    state.positionMode === "page"
      ? "Página por página: cada corrección se guarda solo en la página que estés viendo"
      : "Una sola posición para todas las páginas",
    "good"
  );
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
  updatePageHint();
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
      state.pdfDoc = await openWithPdfJs(() => doc.file.arrayBuffer(), currentPassword());
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
    syncLayoutInputs(currentPageLayout());
    updatePosBar();
    drawSignature();
  } catch (error) {
    toast(friendlyError(error), "bad");
  } finally {
    $("pageWrap").classList.remove("loading");
    $("stageEmptyInner").classList.remove("loading");
  }
}

function drawSignature() {
  if (!state.signature || !state.page.widthPt) {
    $("sigBox2").hidden = true;
    return;
  }
  const box = $("sigBox2");
  const visible = pageIsSelected(state.page.docId, state.page.index, state.page.total);
  box.hidden = !visible;
  if (visible) {
    const rect = layoutRect();
    box.style.left = `${(rect.x / rect.widthPt) * 100}%`;
    box.style.top = `${(rect.y / rect.heightPt) * 100}%`;
    box.style.width = `${(rect.w / rect.widthPt) * 100}%`;
    box.style.height = `${(rect.h / rect.heightPt) * 100}%`;
  }
  updatePageHint();
}

function updatePageHint() {
  const node = $("pageSignHint");
  if (!node) return;
  if (!state.page.widthPt) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  const falta = !pageIsSelected(state.page.docId, state.page.index, state.page.total);
  node.hidden = !falta;
  node.textContent = falta
    ? `Esta página no se firma (selección actual: ${selectedSpecOf(state.page.docId)}).`
    : "";
}

function pushLayout(patch, keepPreset = false) {
  const target = currentEditLayout();
  Object.assign(target, patch);
  if (!keepPreset) state.preset = null;
  syncLayoutInputs(target);
  renderPresets();
  updatePosBar();
  drawSignature();
}

function renderPresets() {
  const row = $("presetRow");
  if (!row) return;
  row.querySelectorAll("[data-preset]").forEach((button) => {
    button.classList.toggle("active", button.dataset.preset === state.preset);
  });
}

function applyPreset(key) {
  const preset = PRESETS.find((item) => item.key === key);
  if (!preset) return;
  if (currentEditLayout().mode !== "fraction") applyMode("fraction");
  const margin = 0.02;
  const pageW = state.page.widthPt || 612;
  const pageH = state.page.heightPt || 792;
  const layout = currentEditLayout();
  const w = layout.fw;
  const h = (pageW * w * (state.aspect || 1)) / pageH;
  const fx = preset.h === "r" ? Math.max(1 - margin - w, 0)
    : preset.h === "c" ? Math.max((1 - w) / 2, 0)
    : margin;
  const fy = preset.v === "b" ? Math.max(1 - margin - h, 0)
    : preset.v === "c" ? Math.max((1 - h) / 2, 0)
    : margin;
  state.preset = preset.key;
  pushLayout({ fx, fy }, true);
  toast(`Posición: ${preset.label}`, "good");
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
      if (currentPageLayout().mode === "fraction") {
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
      if (currentPageLayout().mode === "fraction") pushLayout({ fw: width / widthPt });
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
    if (currentPageLayout().mode === "fraction") {
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
