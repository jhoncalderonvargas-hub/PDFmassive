from __future__ import annotations

import base64
import multiprocessing
import os
import re
import secrets
import shutil
import socket
import sys
import threading
import time
import uuid
import webbrowser
import zipfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import pymupdf
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from signer import sign_one, task_sort_key

BASE_DIR = Path(getattr(sys, "_MEIPASS", None) or Path(__file__).resolve().parent)
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.environ.get("FIRMAR_DATA") or (Path(os.environ.get("LOCALAPPDATA") or BASE_DIR) / "FirmarPDF"))
SESSIONS_DIR = DATA_DIR / "sessions"

MAX_FILE_MB = int(os.environ.get("FIRMAR_MAX_FILE_MB", "400"))
MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024
MAX_FILES_PER_UPLOAD = int(os.environ.get("FIRMAR_MAX_FILES", "2000"))
MAX_SESSION_BYTES = int(os.environ.get("FIRMAR_MAX_SESSION_GB", "20")) * 1024 * 1024 * 1024
SESSION_TTL_SECONDS = int(os.environ.get("FIRMAR_TTL_HOURS", "12")) * 3600
CHUNK = 1024 * 1024
PT_PER_CM = 28.3465
CPU_COUNT = os.cpu_count() or 4
MAX_WORKERS = max(1, min(16, CPU_COUNT))

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp", ".pnm", ".pgm", ".ppm"}
SAFE_NAME = re.compile(r"[^\w\s.\-()\[\]]", re.UNICODE)
PAGES_ALL = {"", "todas", "todos", "all", "*"}
PAGES_FIRST = {"primera", "first"}
PAGES_LAST = {"ultima", "última", "last"}


def clean_name(name: str, fallback: str = "documento") -> str:
    base = Path(name or "").name
    base = SAFE_NAME.sub("_", base).strip(" ._")
    return base or fallback


@dataclass
class DocumentItem:
    id: str
    name: str
    path: str
    pages: int
    size: int
    pages_spec: str = "todas"
    suffix: str = "_firmado"
    password: str = ""

    @property
    def stem(self) -> str:
        return Path(self.name).stem

    @property
    def output_path(self) -> Path:
        suffix = self.suffix if (not self.suffix or self.suffix.startswith("_")) else f"_{self.suffix}"
        return Path(self.path).parent.parent / "output" / f"{self.stem}{suffix}.pdf"

    def public(self) -> Dict[str, Any]:
        done = self.output_path.exists()
        return {
            "id": self.id,
            "name": self.name,
            "pages": self.pages,
            "size": self.size,
            "pages_spec": self.pages_spec,
            "signed": done,
            "signed_name": self.output_path.name if done else None,
            "signed_size": self.output_path.stat().st_size if done else None,
        }


@dataclass
class Layout:
    mode: str = "fraction"
    fx: float = 0.60
    fy: float = 0.80
    fw: float = 0.26
    x: float = 0.0
    y: float = 0.0
    w: float = 6.0
    aspect: float = 3.0


@dataclass
class Job:
    id: str
    total: int = 0
    total_pages: int = 0
    done: int = 0
    done_pages: int = 0
    workers: int = 2
    state: str = "running"
    error: str = ""
    results: List[Dict[str, Any]] = field(default_factory=list)

    def public(self) -> Dict[str, Any]:
        failed = [r for r in self.results if r["state"] != "ok"]
        return {
            "id": self.id,
            "state": self.state,
            "total": self.total,
            "total_pages": self.total_pages,
            "done": self.done,
            "done_pages": self.done_pages,
            "workers": self.workers,
            "failed": len(failed),
            "results": self.results,
            "error": self.error,
        }


@dataclass
class Session:
    id: str
    root: Path
    created: float
    touched: float
    signature: Optional[Path] = None
    documents: List[DocumentItem] = field(default_factory=list)
    layout: Layout = field(default_factory=Layout)
    jobs: Dict[str, Job] = field(default_factory=dict)
    password: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def uploads_dir(self) -> Path:
        return self.root / "uploads"

    @property
    def output_dir(self) -> Path:
        return self.root / "output"

    def used_bytes(self) -> int:
        total = 0
        for path in self.root.rglob("*"):
            try:
                if path.is_file():
                    total += path.stat().st_size
            except OSError:
                continue
        return total

    def public(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "has_signature": self.signature is not None,
            "signature_aspect": self.layout.aspect,
            "documents": [doc.public() for doc in self.documents],
            "layout": asdict(self.layout),
            "used_mb": round(self.used_bytes() / (1024 * 1024), 1),
            "max_workers": MAX_WORKERS,
        }


SESSIONS: Dict[str, Session] = {}
SESSIONS_LOCK = threading.Lock()

app = FastAPI(title="Firma masiva de documentos", docs_url=None, redoc_url=None)


def get_session(sid: str) -> Session:
    with SESSIONS_LOCK:
        session = SESSIONS.get(sid)
    if session is None:
        raise HTTPException(status_code=404, detail="Sesión no encontrada o vencida. Recarga la página.")
    session.touched = time.time()
    return session


def create_session() -> Session:
    sid = secrets.token_urlsafe(16)
    root = SESSIONS_DIR / sid
    root.joinpath("uploads").mkdir(parents=True, exist_ok=True)
    root.joinpath("output").mkdir(parents=True, exist_ok=True)
    session = Session(id=sid, root=root, created=time.time(), touched=time.time())
    with SESSIONS_LOCK:
        SESSIONS[sid] = session
    return session


def parse_pages(spec: str, page_count: int) -> Optional[List[int]]:
    text = (spec or "").strip().lower()
    if text in PAGES_ALL:
        return None
    if text in PAGES_FIRST:
        return [0]
    if text in PAGES_LAST:
        return [page_count - 1]
    pages: List[int] = []
    for chunk in text.replace(";", ",").replace(" ", "").split(","):
        if not chunk:
            continue
        if "-" in chunk:
            head, _, tail = chunk.partition("-")
            if not head.isdigit() or not tail.isdigit():
                raise HTTPException(status_code=400, detail=f"Rango de páginas no válido: '{chunk}'")
            start, end = int(head), int(tail)
            if start > end:
                start, end = end, start
            pages.extend(range(start - 1, end))
        else:
            if not chunk.isdigit():
                raise HTTPException(status_code=400, detail=f"Página no válida: '{chunk}'")
            pages.append(int(chunk) - 1)
    return [page for page in pages if 0 <= page < page_count]


async def store_upload(upload: UploadFile, destination: Path) -> int:
    total = 0
    try:
        with destination.open("wb") as handle:
            while True:
                chunk = await upload.read(CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_FILE_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"'{upload.filename}' supera el límite de {MAX_FILE_MB} MB por archivo",
                    )
                handle.write(chunk)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()
    return total


def inspect_pdf(path: Path, password: str = "") -> Dict[str, Any]:
    document = None
    try:
        document = pymupdf.open(path)
        if document.needs_pass:
            if not (password and document.authenticate(password)):
                return {"ok": False, "reason": "protegido", "pages": 0}
        if document.page_count < 1:
            return {"ok": False, "reason": "sin páginas", "pages": 0}
        return {"ok": True, "pages": document.page_count}
    except Exception as error:
        return {"ok": False, "reason": f"{type(error).__name__}", "pages": 0}
    finally:
        if document is not None:
            try:
                document.close()
            except Exception:
                pass


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    return HTMLResponse(STATIC_DIR.joinpath("index.html").read_text(encoding="utf-8"))


@app.post("/api/session")
def new_session() -> Dict[str, Any]:
    return create_session().public()


@app.get("/api/session/{sid}")
def read_session(sid: str) -> Dict[str, Any]:
    return get_session(sid).public()


@app.delete("/api/session/{sid}")
def drop_session(sid: str) -> Dict[str, Any]:
    with SESSIONS_LOCK:
        session = SESSIONS.pop(sid, None)
    if session is not None:
        shutil.rmtree(session.root, ignore_errors=True)
    return {"ok": True}


@app.post("/api/session/{sid}/signature")
async def upload_signature(sid: str, file: UploadFile = File(...)) -> Dict[str, Any]:
    session = get_session(sid)
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in IMAGE_SUFFIXES:
        raise HTTPException(status_code=400, detail="La firma debe ser una imagen (PNG, JPG, BMP, TIFF, WEBP)")
    destination = session.root / f"firma{suffix}"
    size = await store_upload(file, destination)
    try:
        pixmap = pymupdf.Pixmap(str(destination))
        if pixmap.width < 1 or pixmap.height < 1:
            raise ValueError("imagen vacía")
        aspect = pixmap.width / pixmap.height
    except Exception as error:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"No se pudo leer la imagen: {error}")
    with session.lock:
        if session.signature is not None:
            session.signature.unlink(missing_ok=True)
        session.signature = destination
        session.layout.aspect = aspect
    return {"ok": True, "size": size, "aspect": aspect}


@app.delete("/api/session/{sid}/signature")
def clear_signature(sid: str) -> Dict[str, Any]:
    session = get_session(sid)
    with session.lock:
        if session.signature is not None:
            session.signature.unlink(missing_ok=True)
            session.signature = None
    return {"ok": True}


@app.post("/api/session/{sid}/documents")
async def upload_documents(sid: str, files: List[UploadFile] = File(...)) -> Dict[str, Any]:
    session = get_session(sid)
    if not files:
        raise HTTPException(status_code=400, detail="No se recibieron archivos")
    if len(files) > MAX_FILES_PER_UPLOAD:
        raise HTTPException(
            status_code=413,
            detail=f"Seleccionaste {len(files)} archivos; el máximo por carga es {MAX_FILES_PER_UPLOAD}",
        )

    password = session.password
    used = session.used_bytes()
    added: List[Dict[str, Any]] = []
    skipped: List[Dict[str, str]] = []

    for upload in files:
        original = clean_name(upload.filename or "", "documento.pdf")
        if not original.lower().endswith(".pdf"):
            skipped.append({"name": original, "reason": "no es un PDF"})
            await upload.close()
            continue

        staged = session.uploads_dir / f"stg_{uuid.uuid4().hex}.pdf"
        used += await store_upload(upload, staged)
        if used > MAX_SESSION_BYTES:
            staged.unlink(missing_ok=True)
            skipped.append({"name": original, "reason": f"límite de {MAX_SESSION_BYTES // 1024 ** 3} GB de sesión"})
            break

        info = inspect_pdf(staged, password)
        if not info["ok"]:
            staged.unlink(missing_ok=True)
            skipped.append({"name": original, "reason": info["reason"]})
            continue

        final = session.uploads_dir / f"{uuid.uuid4().hex}.pdf"
        staged.rename(final)
        item = DocumentItem(
            id=uuid.uuid4().hex,
            name=original,
            path=str(final),
            pages=info["pages"],
            size=final.stat().st_size,
            password=password,
        )
        with session.lock:
            session.documents.append(item)
        added.append(item.public())

    session.touched = time.time()
    return {"ok": True, "added": added, "skipped": skipped, "session": session.public()}


@app.delete("/api/session/{sid}/documents/{doc_id}")
def delete_document(sid: str, doc_id: str) -> Dict[str, Any]:
    session = get_session(sid)
    with session.lock:
        item = next((d for d in session.documents if d.id == doc_id), None)
        if item is None:
            raise HTTPException(status_code=404, detail="Documento no encontrado")
        session.documents.remove(item)
    Path(item.path).unlink(missing_ok=True)
    item.output_path.unlink(missing_ok=True)
    return {"ok": True, "session": session.public()}


@app.patch("/api/session/{sid}/documents/{doc_id}")
def update_document(sid: str, doc_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    session = get_session(sid)
    with session.lock:
        item = next((d for d in session.documents if d.id == doc_id), None)
        if item is None:
            raise HTTPException(status_code=404, detail="Documento no encontrado")
        if "pages_spec" in payload:
            item.pages_spec = str(payload["pages_spec"] or "todas")
        if "suffix" in payload:
            item.suffix = str(payload["suffix"] or "_firmado")
    return {"ok": True, "document": item.public()}


@app.get("/api/session/{sid}/page")
def page_preview(
    sid: str,
    doc_id: str = Query(...),
    page: int = Query(1),
    zoom: float = Query(1.6),
    annotated: bool = Query(False),
) -> Dict[str, Any]:
    session = get_session(sid)
    item = next((d for d in session.documents if d.id == doc_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="Documento no encontrado")

    document = None
    try:
        document = pymupdf.open(item.path)
        if document.needs_pass and not document.authenticate(item.password or session.password or ""):
            raise HTTPException(status_code=400, detail="El PDF está protegido con contraseña")
        index = max(0, min(page - 1, document.page_count - 1))
        pdf_page = document[index]
        scale = max(0.5, min(3.0, zoom))
        pixmap = pdf_page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        png = pixmap.tobytes("png")
        info = {
            "doc_id": doc_id,
            "name": item.name,
            "page": index + 1,
            "total_pages": document.page_count,
            "width_pt": round(pdf_page.rect.width, 2),
            "height_pt": round(pdf_page.rect.height, 2),
            "zoom": scale,
            "png_width": pixmap.width,
            "png_height": pixmap.height,
            "png": base64.b64encode(png).decode("ascii"),
        }
        return info
    finally:
        if document is not None:
            try:
                document.close()
            except Exception:
                pass


@app.put("/api/session/{sid}/layout")
def save_layout(sid: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    session = get_session(sid)
    layout = session.layout
    with session.lock:
        mode = str(payload.get("mode", layout.mode))
        if mode not in {"fraction", "absolute"}:
            raise HTTPException(status_code=400, detail="Modo de ubicación no válido")
        layout.mode = mode
        layout.fx = min(max(float(payload.get("fx", layout.fx)), 0.0), 1.0)
        layout.fy = min(max(float(payload.get("fy", layout.fy)), 0.0), 1.0)
        layout.fw = min(max(float(payload.get("fw", layout.fw)), 0.001), 1.0)
        layout.x = max(float(payload.get("x", layout.x)), 0.0)
        layout.y = max(float(payload.get("y", layout.y)), 0.0)
        layout.w = min(max(float(payload.get("w", layout.w)), 1.0), 5000.0)
    return {"ok": True, "layout": asdict(layout)}


@app.post("/api/session/{sid}/password")
def set_password(sid: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    session = get_session(sid)
    session.password = str(payload.get("password") or "")
    return {"ok": True, "password_required": bool(session.password)}


@app.get("/api/session/{sid}/file/{doc_id}")
def download_signed(sid: str, doc_id: str, inline: bool = Query(False)) -> FileResponse:
    session = get_session(sid)
    item = next((d for d in session.documents if d.id == doc_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="Documento no encontrado")
    path = item.output_path
    if not path.exists():
        raise HTTPException(status_code=404, detail="Ese documento aún no está firmado")
    return FileResponse(path, media_type="application/pdf", filename=item.output_path.name, inline=inline)


@app.get("/api/session/{sid}/zip")
def download_zip(sid: str) -> FileResponse:
    session = get_session(sid)
    files = sorted(session.output_dir.glob("*.pdf"))
    if not files:
        raise HTTPException(status_code=404, detail="Todavía no hay documentos firmados")
    archive = session.root / "firmados.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as zf:
        used: Dict[str, int] = {}
        for path in files:
            name = path.name
            if name in used:
                used[name] += 1
                stem, suffix = path.stem, path.suffix
                name = f"{stem} ({used[name]}){suffix}"
            else:
                used[name] = 1
            zf.write(path, arcname=name)
    return FileResponse(archive, media_type="application/zip", filename="documentos_firmados.zip")


def build_tasks(session: Session, payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    if session.signature is None:
        raise HTTPException(status_code=400, detail="Primero carga la imagen de la firma")
    if not session.documents:
        raise HTTPException(status_code=400, detail="Carga al menos un PDF")

    optimize = bool(payload.get("optimize", False))
    layout = asdict(session.layout)
    layout["x"] = layout["x"] * PT_PER_CM
    layout["y"] = layout["y"] * PT_PER_CM
    layout["w"] = layout["w"] * PT_PER_CM
    tasks: List[Dict[str, Any]] = []

    specs = payload.get("documents") or {}
    for item in session.documents:
        spec = specs.get(item.id) or {}
        pages_spec = str(spec.get("pages_spec") or item.pages_spec or "todas")
        if "suffix" in spec:
            item.suffix = str(spec["suffix"] or "_firmado")
        pages = parse_pages(pages_spec, item.pages)
        if pages is not None and not pages:
            continue
        tasks.append(
            {
                "id": item.id,
                "name": item.name,
                "src": item.path,
                "dst": str(item.output_path),
                "signature": str(session.signature),
                "password": item.password or session.password,
                "pages": pages,
                "page_count": item.pages,
                "size": item.size,
                "garbage": 3 if optimize else 0,
                "deflate": optimize,
                **layout,
            }
        )

    if not tasks:
        raise HTTPException(status_code=400, detail="Ningún documento tiene páginas seleccionadas")
    return sorted(tasks, key=task_sort_key)


def run_job(session: Session, job: Job, tasks: List[Dict[str, Any]]) -> None:
    workers = max(1, min(job.workers, len(tasks)))
    try:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(sign_one, task): task for task in tasks}
            for future in as_completed(futures):
                try:
                    result = future.result()
                except Exception as error:
                    task = futures[future]
                    result = {
                        "id": task["id"],
                        "name": task["name"],
                        "state": "error",
                        "pages": 0,
                        "msg": f"{type(error).__name__}: {error}",
                    }
                with session.lock:
                    job.results.append(result)
                    job.done += 1
                    if result["state"] == "ok":
                        job.done_pages += result["pages"]
        with session.lock:
            job.state = "done"
    except Exception as error:
        with session.lock:
            job.state = "error"
            job.error = f"{type(error).__name__}: {error}"


@app.post("/api/session/{sid}/process")
def start_processing(sid: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    session = get_session(sid)
    with session.lock:
        if any(j.state == "running" for j in session.jobs.values()):
            raise HTTPException(status_code=409, detail="Ya hay un proceso en curso")
        tasks = build_tasks(session, payload)
        workers = MAX_WORKERS
        job = Job(
            id=uuid.uuid4().hex,
            total=len(tasks),
            total_pages=sum(
                len(t["pages"]) if t["pages"] is not None else t["page_count"] for t in tasks
            ),
            workers=workers,
        )
        session.jobs[job.id] = job
    threading.Thread(target=run_job, args=(session, job, tasks), daemon=True).start()
    return {"ok": True, "job": job.public()}


@app.get("/api/session/{sid}/job/{job_id}")
def job_status(sid: str, job_id: str) -> Dict[str, Any]:
    session = get_session(sid)
    with session.lock:
        job = session.jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Proceso no encontrado")
        return {"ok": True, "job": job.public()}


def sweep_sessions() -> None:
    now = time.time()
    with SESSIONS_LOCK:
        expired = [s for s in SESSIONS.values() if now - s.touched > SESSION_TTL_SECONDS]
        for session in expired:
            SESSIONS.pop(session.id, None)
    for session in expired:
        shutil.rmtree(session.root, ignore_errors=True)


def sweep_loop() -> None:
    while True:
        time.sleep(900)
        try:
            sweep_sessions()
        except Exception:
            continue


def purge_data_dir() -> None:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    for entry in SESSIONS_DIR.iterdir():
        if entry.is_dir() and time.time() - entry.stat().st_mtime > SESSION_TTL_SECONDS:
            shutil.rmtree(entry, ignore_errors=True)


def lan_ip() -> str:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        address = probe.getsockname()[0]
    except OSError:
        address = "127.0.0.1"
    finally:
        probe.close()
    return address


def free_port(preferred: int, attempts: int = 20) -> int:
    for offset in range(attempts):
        candidate = preferred + offset
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("0.0.0.0", candidate))
            return candidate
        except OSError:
            continue
        finally:
            probe.close()
    return preferred


@app.on_event("startup")
def startup() -> None:
    purge_data_dir()
    threading.Thread(target=sweep_loop, daemon=True).start()


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    multiprocessing.freeze_support()

    host = os.environ.get("FIRMAR_HOST", "0.0.0.0")
    port = free_port(int(os.environ.get("FIRMAR_PORT", "8000")))
    local = "http://127.0.0.1:{port}".format(port=port)
    network = "http://{ip}:{port}".format(ip=lan_ip(), port=port)

    print("=" * 52)
    print("  Firma masiva de documentos")
    print("  En esta PC:   " + local)
    print("  En la red:    " + network)
    print("  Datos:        " + str(DATA_DIR))
    print("  Cerrar esta ventana para detener el programa.")
    print("=" * 52, flush=True)

    if os.environ.get("FIRMAR_NO_BROWSER") != "1":
        threading.Timer(1.2, lambda: webbrowser.open(local)).start()
    try:
        uvicorn.run(app, host=host, port=port, log_level="warning")
    except KeyboardInterrupt:
        pass
    print("\nPrograma detenido.", flush=True)

