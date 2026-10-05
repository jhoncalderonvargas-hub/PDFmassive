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

function selectedSpecOf(docId) {
  return state.selectedPages[docId] ?? "todas";
}

function selectedPagesOf(docId, pageCount) {
  const parsed = parsePages(selectedSpecOf(docId), pageCount);
  if (parsed.error || !parsed.pages) return null;
  return parsed.pages;
}

function pageIsSelected(docId, index, total) {
  const pages = selectedPagesOf(docId, total);
  return pages === null || pages.includes(index - 1);
}

function hasPageOverride(docId, index) {
  return !!(docId && state.pageLayouts[docId] && state.pageLayouts[docId][index]);
}

function effectiveLayout(docId, index) {
  if (state.positionMode === "page" && hasPageOverride(docId, index)) {
    return state.pageLayouts[docId][index];
  }
  return state.layout;
}

function currentPageLayout() {
  return effectiveLayout(state.page.docId, state.page.index);
}

function currentEditLayout() {
  if (state.positionMode === "page" && state.page.docId) {
    const map = (state.pageLayouts[state.page.docId] = state.pageLayouts[state.page.docId] || {});
    if (!map[state.page.index]) map[state.page.index] = { ...effectiveLayout(state.page.docId, state.page.index) };
    return map[state.page.index];
  }
  return state.layout;
}

function currentDoc() {
  return state.docs.find((d) => d.id === state.page.docId) || null;
}

function rawRect(layout, pageWidth, pageHeight) {
  let x, yTop, w;
  if (layout.mode === "fraction") {
    w = pageWidth * layout.fw;
    x = pageWidth * layout.fx;
    yTop = pageHeight * layout.fy;
  } else {
    w = layout.w * PT_PER_CM;
    x = layout.x * PT_PER_CM;
    yTop = layout.y * PT_PER_CM;
  }
  return { x, yTop, w, h: w * (state.aspect || 1) };
}

function layoutRect(layout = currentPageLayout()) {
  const widthPt = state.page.widthPt || 612;
  const heightPt = state.page.heightPt || 792;
  const { x, yTop, w, h } = rawRect(layout, widthPt, heightPt);
  return { x, y: yTop, w, h, widthPt, heightPt };
}

const PRESETS = [
  { key: "bl", label: "Abajo izquierda", v: "b", h: "l" },
  { key: "br", label: "Abajo derecha", v: "b", h: "r" },
  { key: "tr", label: "Arriba derecha", v: "t", h: "r" },
  { key: "c", label: "Centrado", v: "c", h: "c" },
];

function computePdfRect(pageWidth, pageHeight, layout = state.layout) {
  const aspect = state.aspect || 1;
  let { x, yTop, w, h } = rawRect(layout, pageWidth, pageHeight);
  if (w > pageWidth) { w = pageWidth; h = w * aspect; }
  if (h > pageHeight) { h = pageHeight; w = h / aspect; }
  x = Math.min(Math.max(x, 0), Math.max(pageWidth - w, 0));
  yTop = Math.min(Math.max(yTop, 0), Math.max(pageHeight - h, 0));
  return { x, y: pageHeight - yTop - h, width: w, height: h };
}

function signPlanInfo() {
  let pages = 0;
  let bad = "";
  for (const doc of state.docs) {
    const parsed = parsePages(selectedSpecOf(doc.id), doc.pages);
    if (parsed.error) {
      bad = `${doc.name}: ${parsed.error}`;
      continue;
    }
    pages += parsed.pages === null ? doc.pages : parsed.pages.length;
  }
  return { docs: state.docs.length, pages, bad };
}
