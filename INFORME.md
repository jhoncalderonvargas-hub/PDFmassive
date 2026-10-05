# Informe técnico — Firma masiva de documentos

Proyecto: aplicación para firmar lotes de PDF colocando una imagen de firma en páginas seleccionadas.
Repositorio: carpeta del proyecto (git) · Versión vigente: **web** (100 % cliente) · Versión anterior: **Python** (congelada).

---

## 1. Planteamiento

**Problema.** Firmar manualmente decenas de PDF (abrir, insertar imagen, ubicar, guardar) es lento, repetitivo y sujeto a errores de ubicación.

**Solución.** Una herramienta que recibe una imagen de firma y varios PDF, estampa la firma en las páginas elegidas con una posición consistente y devuelve los archivos firmados (individuales o en ZIP).

**Objetivo general.** Automatizar la firma visual de documentos PDF por lotes, garantizando una posición consistente y un proceso sin instalación.

**Objetivos específicos**
1. Permitir cargar una imagen de firma y múltiples PDF.
2. Seleccionar qué páginas de cada documento se firman (`todas`, `primera`, `ultima`, `1,3,5-8`).
3. Previsualizar cada página y ubicar la firma de forma manual o parametrizada.
4. Producir los PDF firmados y descargarlos (archivo o ZIP).
5. Procesar todo en el equipo del usuario, sin enviar archivos a internet.
6. Manejar PDF con permisos restringidos y, opcionalmente, con contraseña.

---

## 2. Alcance y restricciones

| Tipo | Restricción |
|---|---|
| Funcional | Lote ilimitado de PDF en una tanda; selección de páginas por documento; posición general o por página; sufijo de nombre configurable; contraseña PDF opcional. |
| No funcional | ~200 MB por archivo y ~1 GB por tanda (el ZIP vive en memoria); sin persistencia entre sesiones; procesamiento secuencial. |
| Distribución | La versión web se abre con doble clic sobre `web/index.html`; sin servidor, sin instalación, sin permisos de Windows. |
| Fuera de alcance | Firma criptográfica con certificado, sello de tiempo, edición de PDF, extracción de texto. |

---

## 3. Arquitectura

### 3.1 Versión Python (legado, congelada)

```
Navegador (static/) ── HTTP/JSON ──► FastAPI (main.py)
                                        │  sesiones con ID (Session, DocumentItem, Layout, Job)
                                        │  run_job() con hilos
                                        ▼
                                    pymupdf (signer.py)  ──►  PDF firmado en disco temporal
                                        │
                          ZIP / descarga / barrido de sesiones (sweep_loop, purge_data_dir)
```

- `main.py` (≈24 KB): API REST con ~20 rutas (`/api/session`, `/signature`, `/documents`, `/page`, `/layout`, `/password`, `/file`, `/zip`, `/process`, `/job`), datos en memoria con limpieza periódica, `free_port()` y `lan_ip()` para uso en red local.
- `signer.py`: `target_rect()` calcula el rectángulo (modo `fraction` o `absolute`), `clamp_rect()` lo mantiene dentro de la página, `sign_one()` inserta la imagen con `page.insert_image(...)`.
- `build_exe.bat`: crea un virtualenv temporal, compila con PyInstaller y deja `dist\Firmar.exe` portable.

### 3.2 Versión Web (vigente)

```
index.html ──┬── styles.css                 (presentación, identidad visual)
             ├── lib/pdf.min.js + worker    (pdf.js: leer y renderizar PDF)
             ├── lib/pdf-lib.min.js         (@cantoo/pdf-lib: escribir PDF)
             ├── lib/jszip.min.js           (ZIP en memoria)
             └── js/                        (lógica, sin frameworks, scripts clásicos)
                 ├── core.js                (estado `state` y utilidades)
                 ├── domain.js              (selección de páginas y geometría)
                 ├── pdf.js                 (apertura de PDF con pdf.js/pdf-lib)
                 ├── docs.js                (carga de PDFs y de la firma)
                 ├── viewer.js              (visor y posición)
                 └── app.js                 (firmado, resultados y enlaces de eventos)
```

- **Sin backend**: no hay peticiones de red; los archivos se leen con la File API y se escriben con `Blob`.
- **Sin build**: no hay npm, bundler ni compilación; JavaScript y CSS nativos.
- **Estado central**: un único objeto `state` (documentos, firma, página visible, modo de posición, layouts por página, resultados, bandera `busy`).

### 3.3 Comparación de decisiones

| Decisión | Python | Web |
|---|---|---|
| Lectura de PDF | pymupdf | pdf.js |
| Escritura de PDF | pymupdf (`insert_image`) | pdf-lib (`drawImage`) |
| Concurrencia | hilos (`run_job`) | `async/await` + event loop |
| Distribución | `.exe` (PyInstaller) | archivo HTML |
| Privacidad | archivos en carpeta temporal local | nunca salen del navegador |

---

## 4. Diseño técnico

### 4.1 Flujo de datos (5 pasos)

1. **Firma** → `uploadSignature()` valida la imagen y calcula `state.aspect = alto / ancho`.
2. **PDFs** → `uploadPdfs()` crea los registros (`name`, `pages`, `size`) con `parsePages`/inspección.
3. **Páginas y vista previa** → `parsePages()` convierte la especificación en índices; `loadPage()` renderiza con pdf.js en un `<canvas>` (escala 1.6) y `drawSignature()` posiciona la caja de la firma.
4. **Ubicación** → modo *todas las páginas* o *página por página* (`state.pageLayouts`), con `applyToAllPages()`, `applyToRange()`, `resetPageLayout()`.
5. **Firma** → `startSigning()` por documento: `PDFDocument.load → embedPng → page.drawImage(rect) → save → Blob`; al final, ZIP con JSZip.

### 4.2 Algoritmos clave

- **Selección de páginas** (`parsePages`): acepta `todas`, `primera`, `ultima` o listas `1,3,5-8`; valida índices y devuelve mensajes de error legibles (`Página no válida: 'zz'`).
- **Geometría de la firma** (`layoutRect` / `computePdfRect`):
  - modo *proporción*: `ancho = anchoPágina × fw`, `x = anchoPágina × fx`, `y = altoPágina × fy`;
  - modo *absoluto*: centímetros convertidos con `PT_PER_CM`;
  - **alto = ancho × aspect**, donde `aspect = alto/imagen ÷ ancho/imagen`.
- **Coordinadas**: el PDF mide desde la esquina **inferior izquierda**; la vista previa (CSS/canvas) desde la **superior izquierda**. Las conversiones permiten que lo que se ve en pantalla coincida con lo grabado en el archivo.
- **Límites** (`clamp_rect` / equivalente web): si el rectángulo se sale, se recala para que siempre quede dentro de la página.

### 4.3 Estructura del código web

- **Dominio** (funciones sin UI): `parsePages`, `selectedPagesOf`, `pageIsSelected`, `layoutRect`, `computePdfRect`, `effectiveLayout`, `outputName`, `friendlyError`, `escapeHtml`.
- **Render/UI**: `renderDocs`, `drawSignature`, `updatePosBar`, `syncLayoutInputs`, `renderResults`, `toast`.
- **Orquestación**: `loadPdf`, `openWithPdfJs`, `loadPage`, `openDoc`, `startSigning`.

---

## 5. Tecnologías y justificación

| Tecnología | Rol | Por qué |
|---|---|---|
| HTML/CSS/JS nativos | interfaz | cero instalación y cero dependencias de build |
| pdf.js (Mozilla) | leer/renderizar | soporta PDF cifrados y con permisos restringidos |
| `@cantoo/pdf-lib` | escribir | fork de pdf-lib tolerante a PDF con permisos restringidos |
| JSZip | empaquetado | ZIP en memoria sin servidor |
| FastAPI + pymupdf (legado) | API y firma | desarrollo rápido y manejo robusto de PDF |
| PyInstaller (legado) | distribución | ejecutable portable en USB |
| Puppeteer + Edge | pruebas E2E | automatización real sobre la interfaz |

---

## 6. ¿Esto es una "firma digital"?

El motor del proyecto ejecuta `page.drawImage(imagenFirma, rectángulo)`: **estampa una imagen**.

| Concepto | Qué aporta | ¿Está en el proyecto? |
|---|---|---|
| Firma manuscrita escaneada / visual | evidencia de intención | **Sí** |
| Firma digital (Ley 527 de 1999) | hash + clave privada con certificado: identidad e integridad | No |
| Firma electrónica avanzada | lo anterior + sello de tiempo y detección de alteración | No |

**Ruta de evolución**: en Python con `pyhanko`/`endesive` y un certificado P12; en web con `WebCrypto` + proveedor de certificado. Cualquier defensa debe declarar esto con claridad.

---

## 7. Seguridad y privacidad

- **Confidencialidad**: ningún archivo abandona el equipo en la versión web (no hay endpoints ni telemetría).
- **Entrada no confiable**: nombres de archivo y datos visibles se escapan con `escapeHtml()` antes de insertarse en el DOM (prevención de XSS).
- **Contraseñas**: se mantienen en memoria, solo para abrir el PDF; no se guardan ni se envían.
- **Límites**: tamaños y tiempos acotados para evitar bloquear el hilo de interfaz.
- **Debilidad heredada**: una imagen de firma puede copiarse y estamparse por terceros; por eso se recomienda acompañar el trámite con controles administrativos o, a futuro, firma criptográfica.

---

## 8. Pruebas (verificación)

Estrategia: **pruebas de caja negra de extremo a extremo** ejecutando la interfaz real en Edge (headless) con Puppeteer, más **verificación del artefacto** abriendo el PDF firmado con pymupdf.

| Prueba | Qué cubre | Resultado |
|---|---|---|
| `test4` | carga de 5 PDF, uno con contraseña (con y sin clave), firma por lote | 5/5 firmados |
| `test5` | etiquetas de UI, `todas/primera/1,3,5-9`, especificación inválida `zz` | OK |
| `test6` | la vista previa respeta la selección de páginas | OK |
| `test7` | deformación de la firma (proporción 3:1 y 1:3) | desviación 0,00 % |
| `test8` | posición general vs página por página, aplicar a rango/restablecer | coordenadas exactas (ej. pág. 3 = 61,2 / 79,2 pt) |

Arquitectura de pruebas: fixtures pequeños en base64 (1, 5 y 15 páginas, PDF con permisos restringidos, PDF con clave `1234`, PNG de firma), navegador headless y verificación numérica de la salida.

**Bugs reales detectados y corregidos por las pruebas**
1. Relación de aspecto invertida → firma estirada en otros equipos.
2. La firma quedaba 125 px bajo el área visible del visor → página ahora ajustada al visor.
3. PDF con contraseña de propietario no abría → fork `cantoo` + reintentos con y sin clave.
4. Codificación UTF-8 dañada por una operación en lote → reparada y revalidada.

---

## 9. Mejoras aplicadas (historial)

- Contraseña PDF opcional en la interfaz y mensajes claros.
- Selección de páginas por documento con pista en la vista previa.
- Modo *corregir página por página* con barra de acciones (sin `prompt()`).
- Corrección del aspecto y del encuadre del visor.
- Identidad visual (estilo OneDrive), icono de cabecera, favicon y `firma.ico`.
- Aviso de bienvenida redactado en lenguaje llano.

---

## 10. Mejoras propuestas (trabajo futuro)

1. **Presets de posición** (abajo-derecha, centrado…) para eliminar porcentajes.
2. Botón **"Firmar N documentos (M páginas)"** con validación en línea.
3. **Contraseña junto al archivo rechazado** con reintento inmediato.
4. **Confirmación** antes de "Empezar de nuevo".
5. **Barra de progreso de pasos** y "modo guiado".
6. Botón **"Probar con un ejemplo"** para nuevos usuarios.
7. Persistir preferencias en `localStorage`.
8. Firma criptográfica con certificado (ver §6).

---

## 11. Conclusiones

- La iteración hacia una arquitectura **100 % cliente** eliminó dependencias de servidor, instalación y permisos de SO, sin sacrificar las capacidades de procesamiento por lote.
- La **separación entre lógica de dominio y render** permitió probar coordenadas y selección de páginas sin depender de la interfaz.
- Las **pruebas automatizadas de extremo a extremo** fueron las que destaparon los defectos críticos (aspecto, contraseñas, encuadre); sin ellas los errores solo se verían en la PC del usuario final.
- El alcance está deliberadamente limitado a **firma visual**; la firma digital certificada queda como evolución natural y documentada.

---

## Anexo A — Estructura de archivos

```
Firmar/
├── main.py              FastAPI (legado)
├── signer.py            inserción con pymupdf (legado)
├── requirements.txt     fastapi, uvicorn, python-multipart, pymupdf, pillow
├── build_exe.bat        PyInstaller → dist\Firmar.exe
├── Usar_app.bat         atajo para ejecutar la versión Python
├── static/              front de la versión Python (congelado)
└── web/                 ← versión vigente
    ├── index.html       estructura (5 pasos)
    ├── styles.css       identidad visual y componentes
    ├── js/              lógica: core, domain, pdf, docs, viewer, app
    ├── firma.ico        icono para acceso directo
    └── lib/             pdf.js, pdf-lib, jszip
```

## Anexo B — Glosario

**pt** punto tipográfico (1/72") · **aspect** alto÷ancho de la imagen · **fracción** posición en % de la página · **modo absoluto** posición en cm desde la esquina superior izquierda · **ZIP en memoria** archivo comprimido generado sin disco intermedio · **E2E** prueba de extremo a extremo sobre la interfaz real.
