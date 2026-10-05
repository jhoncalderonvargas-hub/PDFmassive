from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional

import pymupdf

_SIGNATURE_CACHE: Dict[str, bytes] = {}


def signature_stream(path: str) -> bytes:
    cached = _SIGNATURE_CACHE.get(path)
    if cached is None:
        with open(path, "rb") as handle:
            cached = handle.read()
        _SIGNATURE_CACHE.clear()
        _SIGNATURE_CACHE[path] = cached
    return cached


def clamp_rect(rect: pymupdf.Rect, page_rect: pymupdf.Rect) -> Optional[pymupdf.Rect]:
    width = rect.width
    height = rect.height
    if width > page_rect.width:
        width = page_rect.width
        height = width * (rect.height / rect.width) if rect.width else height
    if height > page_rect.height:
        height = page_rect.height
        width = height * (rect.width / rect.height) if rect.height else width
    x0 = min(max(rect.x0, page_rect.x0), page_rect.x1 - width)
    y0 = min(max(rect.y0, page_rect.y0), page_rect.y1 - height)
    if width <= 0 or height <= 0:
        return None
    return pymupdf.Rect(x0, y0, x0 + width, y0 + height)


def target_rect(task: Dict[str, Any], page_rect: pymupdf.Rect) -> Optional[pymupdf.Rect]:
    aspect = float(task["aspect"]) or 1.0
    if task.get("mode") == "absolute":
        width = float(task["w"])
        rect = pymupdf.Rect(
            page_rect.x0 + float(task["x"]),
            page_rect.y0 + float(task["y"]),
            page_rect.x0 + float(task["x"]) + width,
            page_rect.y0 + float(task["y"]) + width * aspect,
        )
    else:
        width = page_rect.width * float(task["fw"])
        height = width * aspect
        x = page_rect.x0 + page_rect.width * float(task["fx"])
        y = page_rect.y0 + page_rect.height * float(task["fy"])
        rect = pymupdf.Rect(x, y, x + width, y + height)
    return clamp_rect(rect, page_rect)


def sign_one(task: Dict[str, Any]) -> Dict[str, Any]:
    started = time.perf_counter()
    result: Dict[str, Any] = {
        "id": task["id"],
        "name": task["name"],
        "state": "error",
        "pages": 0,
        "msg": "",
    }
    document = None
    try:
        stream = signature_stream(task["signature"])
        document = pymupdf.open(task["src"])
        if document.needs_pass:
            if not document.authenticate(task.get("password") or ""):
                result["msg"] = "El PDF está protegido con contraseña"
                return result
        if document.page_count == 0:
            result["msg"] = "El PDF no tiene páginas"
            return result

        pages: Optional[List[int]] = task.get("pages")
        if pages is None:
            pages = list(range(document.page_count))

        signed = 0
        for index in pages:
            if index < 0 or index >= document.page_count:
                continue
            page = document[index]
            rect = target_rect(task, page.rect)
            if rect is None:
                continue
            page.insert_image(rect, stream=stream, keep_proportion=False, overlay=True)
            signed += 1

        if signed == 0:
            result["msg"] = "Ninguna página válida seleccionada"
            return result

        document.save(
            task["dst"],
            garbage=int(task.get("garbage", 0)),
            deflate=bool(task.get("deflate")),
            deflate_images=bool(task.get("deflate")),
            deflate_fonts=bool(task.get("deflate")),
            clean=bool(task.get("deflate")),
        )
        result["state"] = "ok"
        result["pages"] = signed
        result["bytes"] = os.path.getsize(task["dst"])
    except Exception as error:
        result["msg"] = f"{type(error).__name__}: {error}"
    finally:
        if document is not None:
            try:
                document.close()
            except Exception:
                pass
    result["elapsed"] = round(time.perf_counter() - started, 3)
    return result


def task_sort_key(task: Dict[str, Any]):
    return -int(task.get("size", 0))
