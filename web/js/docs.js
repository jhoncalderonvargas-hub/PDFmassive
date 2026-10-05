function renderDocs() {
  const list = $("docList");
  $("docCount").textContent = state.docs.length;
  $("btnClearPdfs").hidden = state.docs.length === 0;
  $("btnZip").hidden = !state.results.some((r) => r.state === "ok");

  if (!state.docs.length) {
    list.innerHTML = '<div class="note">Aún no hay documentos.</div>';
    $("docSummary").textContent = "";
    $("docSelect").innerHTML = "";
    updateSignButton();
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
      <div class="file">
        <span class="fileIcon" aria-hidden="true">PDF</span>
        <div class="fileMeta">
          <div class="name" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</div>
          <div class="sub"><span>${doc.pages} página(s) · ${(doc.size / 1048576).toFixed(2)} MB</span></div>
        </div>
      </div>
      <div class="pagesBox">
        <span class="pagesLbl">Páginas a firmar</span>
        <input class="pagesInput" value="${escapeHtml(state.selectedPages[doc.id] ?? "todas")}" placeholder="todas" title="Páginas a firmar (todas, primera, ultima, 1,3,5-8)">
      </div>
      <div class="actions">
        <button class="ghost open" type="button">Ver</button>
        <button class="ghost del" type="button" title="Quitar documento">✕</button>
      </div>`;
    row.querySelector(".open").onclick = () => openDoc(doc.id);
    row.querySelector(".del").onclick = () => removeDoc(doc.id);
    row.querySelector(".pagesInput").oninput = (event) => {
      state.selectedPages[doc.id] = event.target.value;
      updateSignButton();
      if (state.page.docId === doc.id) drawSignature();
    };
    list.appendChild(row);
  }

  const select = $("docSelect");
  const previous = select.value;
  select.innerHTML = state.docs
    .map((d) => `<option value="${d.id}">${escapeHtml(d.name)} (${d.pages} pág.)</option>`)
    .join("");
  select.value = state.docs.some((d) => d.id === previous) ? previous : current;
  updateSignButton();
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
    state.aspect = canvas.height / canvas.width;

    $("sigPreview").src = displayUrl;
    $("sigPreview").hidden = false;
    $("sigBox").querySelector(".dropText").hidden = true;
    $("sigOverlay").src = displayUrl;
    $("sigOverlay").hidden = false;
    $("btnClearSig").hidden = false;
    $("sigBox2").hidden = false;
    $("btnSign").disabled = false;
    toast(`Firma cargada (${file.name})`, "good");
    updateSignButton();
    drawSignature();
  } catch (error) {
    toast(`No se pudo cargar la firma: ${error.message}`, "bad");
  }
}

function renderRejected() {
  const list = $("rejectList");
  if (!list) return;
  list.hidden = !state.rejected.length;
  list.innerHTML = state.rejected
    .map((item) => `
      <div class="rejectItem${item.needsPassword ? " pass" : ""}" data-id="${item.id}">
        <div class="rejectTxt">
          <strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
          <span>${item.needsPassword ? "Pide contraseña: escríbela y pulsa Reintentar" : escapeHtml(item.reason)}</span>
        </div>
        <div class="rejectAct">
          ${item.needsPassword ? `<input type="password" class="rejectPwd" placeholder="Contraseña" aria-label="Contraseña de ${escapeHtml(item.name)}">` : ""}
          ${item.needsPassword ? '<button class="small retry" type="button">Reintentar</button>' : ""}
          <button class="ghost small remove" type="button" title="Quitar de la lista">✕</button>
        </div>
      </div>`)
    .join("");

  list.querySelectorAll(".rejectItem").forEach((row) => {
    const item = state.rejected.find((entry) => entry.id === row.dataset.id);
    if (!item) return;
    const pwd = row.querySelector(".rejectPwd");
    const retry = row.querySelector(".retry");
    if (retry) retry.onclick = () => retryRejected(item, pwd ? pwd.value : "");
    if (pwd) {
      pwd.onkeydown = (event) => { if (event.key === "Enter") retryRejected(item, pwd.value); };
      if (!pwd.value) pwd.focus();
    }
    row.querySelector(".remove").onclick = () => {
      state.rejected = state.rejected.filter((entry) => entry.id !== item.id);
      renderRejected();
    };
  });
}

async function retryRejected(item, password) {
  if (!item) return;
  try {
    const buffer = await item.file.arrayBuffer();
    const info = await inspectPdf(buffer, password || "");
    state.docs.push({
      id: genId(),
      file: item.file,
      name: cleanName(item.file.name),
      pages: info.pages,
      size: item.file.size,
    });
    state.rejected = state.rejected.filter((entry) => entry.id !== item.id);
    $("uploadNote").textContent = `${cleanName(item.file.name)} cargado correctamente`;
    renderRejected();
    renderDocs();
    if (state.docs.length === 1) await openDoc(state.docs[0].id);
    toast(`${cleanName(item.file.name)} cargado`, "good");
  } catch (error) {
    item.reason = error.message;
    item.needsPassword = /contrase|password/i.test(error.message);
    renderRejected();
    toast(error.message, "bad");
  }
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
      const info = await inspectPdf(buffer, currentPassword());
      state.docs.push({
        id: genId(),
        file,
        name: cleanName(file.name),
        pages: info.pages,
        size: file.size,
      });
      state.rejected = state.rejected.filter((entry) => entry.file.name !== file.name);
      added++;
    } catch (error) {
      const needsPassword = /contrase|password/i.test(error.message);
      skipped.push({ name: file.name, reason: error.message, needsPassword });
      const exists = state.rejected.find((entry) => entry.file.name === file.name);
      const record = {
        id: exists ? exists.id : genId(),
        file,
        name: file.name,
        reason: error.message,
        needsPassword,
      };
      if (exists) Object.assign(exists, record);
      else state.rejected.push(record);
    }
    const done = index + 1;
    $("uploadBar").style.width = `${(done / pdfs.length) * 100}%`;
    $("uploadNote").textContent = `Leyendo ${done}/${pdfs.length} · ${added} cargados`;
    if (done % 5 === 0 || done === pdfs.length) renderDocs();
    await tick();
  }

  $("uploadProgress").hidden = true;
  $("uploadBar").style.width = "0%";
  const conClave = skipped.filter((item) => item.needsPassword);
  const conError = skipped.filter((item) => !item.needsPassword);
  const partes = [];
  if (added) partes.push(`${added} documento(s) cargados`);
  if (conClave.length) partes.push(`${conClave.length} pide(n) contraseña: escríbela en la fila y pulsa Reintentar`);
  if (conError.length) {
    const detail = conError.slice(0, 3).map((s) => `${s.name} → ${s.reason}`).join(" · ");
    partes.push(`${conError.length} omitido(s): ${detail}${conError.length > 3 ? " …" : ""}`);
  }
  $("uploadNote").textContent = partes.length
    ? partes.join(" · ")
    : "No se cargó ningún PDF";
  state.busy = false;

  renderRejected();
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
