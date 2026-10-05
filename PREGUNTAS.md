# Guía de preguntas y respuestas — Proyecto "Firma masiva de documentos"

Material de estudio para Análisis y Desarrollo de Software. Las respuestas citan el código real del proyecto.

---

## A. Conceptos del proyecto

**1. ¿Qué hace la aplicación?**
Toma una imagen de firma y varios PDF, estampa la firma en las páginas seleccionadas de cada documento y entrega los archivos firmados (individuales o en ZIP), con posición configurable.

**2. ¿Cuáles son los 5 pasos de la interfaz?**
1) cargar firma · 2) cargar PDF · 3) elegir páginas y previsualizar · 4) ubicar la firma · 5) firmar y descargar.

**3. ¿Qué diferencia hay entre la versión Python y la web?**
Python era cliente–servidor (FastAPI + pymupdf + `.exe` con PyInstaller); la web es 100 % cliente: pdf.js para leer, pdf-lib para escribir, JSZip para empaquetar, sin servidor ni instalación.

**4. ¿Por qué se pasó de Python a navegador?**
Para eliminar servidor, instalación y controles de Windows/antivirus que podían bloquear la herramienta, y para que los archivos nunca salgan del equipo.

**5. ¿La app guarda información en una base de datos?**
No. En web el estado vive en un objeto `state` en memoria; en Python eran `dataclasses` (`Session`, `DocumentItem`, `Layout`, `Job`) barridas periódicamente. Al cerrar, todo desaparece.

**6. ¿Cuál es el límite de archivos?**
No hay límite fijo en código; los prácticos son ~200 MB por PDF y ~1 GB por tanda porque el ZIP se arma en memoria.

---

## B. PDF y geometría

**7. ¿Qué es un punto (pt) en PDF?**
1/72 de pulgada. Carta = 612×792 pt. 1 pulgada = 2,54 cm = 72 pt → 1 cm ≈ 28,35 pt (constante `PT_PER_CM`).

**8. ¿Desde dónde cuenta el PDF las coordenadas?**
Desde la esquina **inferior izquierda** hacia arriba/derecha. CSS y canvas cuentan desde la **superior izquierda**. Por eso la vista previa y el archivo necesitan conversiones distintas.

**9. ¿Qué diferencia hay entre leer un PDF y escribirlo?**
Leer/renderizar lo hace **pdf.js** (decodifica y pinta en `<canvas>`); escribir lo hace **pdf-lib** (modifica objetos del PDF y serializa con `save({useObjectStreams})`). Son librerías complementarias, no intercambiables.

**10. ¿Qué es la relación de aspecto y por qué importa?**
`aspect = alto ÷ ancho` de la imagen. El alto de la firma en el PDF se calcula `alto = ancho × aspect`. Si se invierte la fórmula, la firma sale estampada estirada; fue un bug real corregido en este proyecto (prueba `test7`: desviación 0,00 %).

**11. ¿Qué tipos de contraseña tiene un PDF?**
- **Propietario**: solo restringe permisos (copiar/imprimir); el fork `cantoo` de pdf-lib la ignora y el archivo abre sin clave.
- **Usuario**: protege la apertura; hay que pedirla al usuario (campo "Contraseña PDF", paso 5) y reintentar la carga.

**12. ¿Qué significa que un PDF tenga "permisos restringidos"?**
Que el dueño bloqueó imprimir/copiar/editar. Eso no impide firmarlo, siempre que la herramienta respete el formato.

---

## C. Código concreto del proyecto

**13. ¿Dónde se calcula la posición de la firma?**
En `layoutRect()` / `computePdfRect()` (`web/app.js`), que devuelven el rectángulo en puntos del PDF según el modo (fracción o centímetros).

**14. ¿Cómo se interpreta "1,3,5-8"?**
`parsePages()` tokeniza por comas, expande rangos con guion, valida números y devuelve errores legibles (`Página no válida: 'zz'`).

**15. ¿Cómo se renderiza una página en pantalla?**
`loadPage()` pide la página a pdf.js, calcula un `viewport` con escala 1.6, pinta en el `<canvas id="pageCanvas">` y reposiciona la caja de la firma con `drawSignature()` (porcentajes respecto de la página).

**16. ¿Qué hace `startSigning()`?**
Valida firma, documentos y selección; por cada PDF: `load → embedPng → drawImage(rect) en cada página elegida → save → Blob`; actualiza barra de progreso y resultados; finalmente permite descargar o generar ZIP.

**17. ¿Qué es `state.busy` y para qué sirve?**
Bandera que impide ejecutar dos firmados simultáneos y deshabilita el botón mientras se procesa el lote.

**18. ¿Cómo se evita inyectar código con nombres de archivo raros?**
Con `escapeHtml()` antes de insertar cualquier dato del usuario en el HTML (prevención de XSS).

**19. ¿Por qué se usan `async/await` y `tick()`?**
Porque leer PDF, renderizar y guardar son operaciones largas; sin `await` la interfaz se congelaría. `tick()` cede el hilo para que la barra de progreso se pinte entre archivos.

**20. ¿Qué es el "modo corregir página por página"?**
Que cada página pueda tener su propio rectángulo (`state.pageLayouts`), heredando la posición general si no se tocó; se puede copiar a un rango o restablecer.

---

## D. Firma: aspecto legal y técnico

**21. ¿Esto genera una firma digital legalmente válida?**
No. Estampa una **imagen** de firma. La firma digital (Ley 527 de 1999) exige un certificado y criptografía (hash + clave privada); la electrónica avanzada agrega sello de tiempo y detección de alteración.

**22. ¿Qué se necesitaría para firmar criptográficamente?**
En Python: `pyhanko`/`endesive` con certificado `.p12`. En web: `WebCrypto` más un proveedor de certificado; el flujo sería hash del documento + firma PKCS#7/CMS + sello de tiempo.

**23. ¿Cuál es el riesgo de solo una firma visual?**
Que cualquiera con la imagen puede estamparla en otro documento: no hay integridad ni no repudio. Se compensa con controles administrativos (radicado, seguimiento).

---

## E. Pruebas y calidad

**24. ¿Qué tipo de pruebas tiene el proyecto?**
E2E de caja negra: Puppeteer controla Edge headless, usa la interfaz real y verifica salidas; además se abre el PDF firmado con pymupdf para medir coordenadas.

**25. ¿Por qué los archivos de prueba son `.b64` (base64)?**
Para que los fixtures sean texto pequeños y no crezcan el repositorio; los scripts los decodifican en memoria y los suben como `File`.

**26. ¿Qué bugs descubrieron las pruebas?**
- Aspecto invertido (firma estropiciada en otras PCs).
- PDF con contraseña de propietario no abría.
- La firma quedaba fuera del área visible del visor.
- Codificación UTF-8 dañada por una operación por lotes.

**27. ¿Cómo verificarías que la firma quedó en el lugar correcto?**
Abriendo el PDF con pymupdf/lectores de anotaciones o comparando el rectángulo esperado (`fx × anchoPágina`) con el insertado; en `test8` se exigen valores exactos (61,2 pt y 79,2 pt).

**28. ¿Qué es una prueba de regresión?**
Volver a correr la suite completa tras cada cambio para asegurar que lo nuevo no rompió lo anterior (aquí: `test4` a `test8`).

---

## F. Seguridad, usabilidad y mejora

**29. ¿Los archivos suben a internet?**
No en la versión web: se leen con la File API y se procesan en memoria. Eso es el argumento de privacidad de la app.

**30. ¿Qué es la usabilidad y cómo se mejoró aquí?**
Facilidad de uso para personas poco técnicas: avisos en lenguaje llano, etiquetas claras, visor que muestra la página completa, botón grande de "Firmar", identidad visual consistente y (propuesto) presets de posición en vez de porcentajes.

**31. ¿Qué mejoras propondrías y por qué?**
Presets de posición (elimina el 60/80/26 %), contraseña junto al archivo rechazado (evita volver al paso 5), confirmación antes de reiniciar (evita perder el lote), barra de progreso de pasos y firma criptográfica.

**32. Si te preguntan "¿por qué no usaste una base de datos?", ¿contestas?**
Porque el proceso es por sesión y de corta duración: los datos viven en memoria mientras el usuario trabaja; persistirlos obligaría a guardar PDF en disco y a gestionar limpieza y privacidad sin necesidad real.

---

## Preguntas "incómodas" típicas

- **¿Escalable a miles de PDF?** Sí, pero secuencial y con memoria limitada; conviene cola con progreso (ya existe) y, en Python, los hilos de `run_job`.
- **¿Y si el usuario cierra la pestaña?** Se pierde todo: es una decisión de diseño (sin persistencia) aceptable para un lote corto.
- **¿Por qué dos librerías de PDF en web?** Porque ninguna hace ambas cosas: pdf.js renderiza con calidad y soporta claves; pdf-lib modifica el archivo.
- **¿Cómo sabes que no dañas el PDF original?** Nunca se sobrescribe: se genera un Blob nuevo con sufijo `_firmado`.
- **¿Qué pasa si una página no se firma?** `pageIsSelected()` oculta la caja en la vista previa y avisa: "Esta página no se firma (selección actual: …)".
