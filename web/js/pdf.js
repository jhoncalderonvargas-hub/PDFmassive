pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

function friendlyError(error) {
  const message = String((error && error.message) || error);
  if (/encrypt/i.test(message)) return "PDF cifrado que no se pudo abrir";
  if (/invalid|corrupt|parse/i.test(message)) return "El PDF está dañado o no es válido";
  return message.slice(0, 180);
}

function currentPassword() {
  return ($("pdfPassword").value || "").trim();
}

async function loadPdf(buffer, password) {
  const attempts = password ? [password, ""] : [""];
  let passwordError = false;
  for (const attempt of attempts) {
    try {
      return await PDFLib.PDFDocument.load(buffer, {
        throwOnInvalidObject: false,
        updateMetadata: false,
        password: attempt,
      });
    } catch (error) {
      const message = String((error && error.message) || error);
      if (/NEEDS PASSWORD|wrong password|password/i.test(message)) {
        passwordError = true;
        continue;
      }
      throw new Error(friendlyError(error));
    }
  }
  if (passwordError) {
    throw new Error(
      password
        ? "La contraseña no es correcta"
        : "Requiere contraseña: escríbela en la fila del archivo y pulsa Reintentar"
    );
  }
  throw new Error("No se pudo abrir el PDF");
}

async function openWithPdfJs(getBytes, password) {
  try {
    return await pdfjsLib.getDocument({ data: await getBytes(), password: password || "" }).promise;
  } catch (error) {
    const name = String((error && error.name) || "");
    if (password && name.includes("Password")) {
      return await pdfjsLib.getDocument({ data: await getBytes(), password: "" }).promise;
    }
    if (name.includes("Password")) {
      throw new Error("Requiere contraseña: escríbela en la fila del archivo y pulsa Reintentar");
    }
    throw error;
  }
}

async function inspectPdf(buffer, password) {
  const doc = await loadPdf(buffer, password);
  const pages = doc.getPageCount();
  if (pages < 1) throw new Error("El PDF no tiene páginas");
  return { pages };
}
