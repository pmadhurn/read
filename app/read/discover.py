"""Search free, legally downloadable books online and pull them into the library.

Sources: Project Gutenberg (through the Gutendex catalogue) and the Internet
Archive's openly downloadable texts. Lending-only and access-restricted items are
filtered out. The client only ever names a source, an id and a format: every
download address is built here and must stay on the sources' own hosts.
"""
import re
import threading
from pathlib import Path
from urllib.parse import quote, urlparse

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import Response

from . import config, importer
from .db import tx, q1, ex
from .security import current_profile

router = APIRouter(prefix="/api/discover")

UA = {"User-Agent": f"read-family-library ({config.PUBLIC_URL})"}
ALLOWED_HOSTS = ("gutendex.com", "gutenberg.org", "pglaf.org", "archive.org")
_ID = re.compile(r"^[A-Za-z0-9._-]{1,120}$")

GUTENBERG_FORMATS = [("epub", "application/epub+zip"), ("txt", "text/plain; charset=utf-8"), ("txt", "text/plain"),
                     ("html", "text/html; charset=utf-8"), ("html", "text/html")]
# Archive.org file "format" names, best reading quality first. Its EPUBs and DjVuTXT are machine OCR.
ARCHIVE_FORMATS = [("pdf", "Text PDF", "PDF with text"), ("pdf", "Additional Text PDF", "PDF with text"), ("epub", "EPUB", "EPUB (from OCR)"),
                   ("txt", "DjVuTXT", "Plain text (from OCR)"), ("pdf", "Image Container PDF", "Scanned PDF (needs OCR)")]


def _allowed(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return urlparse(url).scheme == "https" and any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS)


def _get(url: str, **kw) -> httpx.Response:
    """GET that follows redirects by hand so every hop is checked against the allow-list."""
    with httpx.Client(timeout=kw.pop("timeout", 20), headers=UA, follow_redirects=False) as client:
        for _ in range(6):
            if not _allowed(url):
                raise HTTPException(502, "The source redirected somewhere unexpected.")
            resp = client.get(url, **kw)
            if resp.is_redirect:
                url = str(resp.next_request.url).replace("http://", "https://", 1)
                continue
            return resp
    raise HTTPException(502, "Too many redirects.")


def _first(value) -> str:
    if isinstance(value, list):
        return ", ".join(str(v) for v in value[:3])
    return str(value or "")


def _flip(name: str) -> str:
    # Gutenberg lists authors as "Doyle, Arthur Conan".
    parts = [p.strip() for p in name.split(",")]
    return f"{parts[1]} {parts[0]}" if len(parts) == 2 else name


def search_gutenberg(query: str, lang: str) -> list[dict]:
    url = f"https://gutendex.com/books/?search={quote(query)}" + (f"&languages={quote(lang)}" if lang else "")
    resp = _get(url, timeout=40)      # the Gutendex catalogue is often slow
    if resp.status_code != 200:
        return []
    out = []
    for b in resp.json().get("results", [])[:20]:
        formats, seen = [], set()
        for fmt, mime in GUTENBERG_FORMATS:
            if mime in b["formats"] and fmt not in seen:
                seen.add(fmt)
                formats.append({"key": fmt, "label": {"epub": "EPUB", "txt": "Plain text", "html": "HTML"}[fmt]})
        if not formats or b.get("copyright") is True or b.get("media_type", "Text") != "Text":    # skip audiobooks
            continue
        out.append({"source": "gutenberg", "source_label": "Project Gutenberg", "id": str(b["id"]), "title": b["title"],
                    "author": ", ".join(_flip(a["name"]) for a in b.get("authors", [])[:2]),
                    "language": ", ".join(b.get("languages", [])), "downloads": b.get("download_count", 0),
                    "formats": formats, "has_cover": "image/jpeg" in b["formats"],
                    "page": f"https://www.gutenberg.org/ebooks/{b['id']}"})
    return out


def search_archive(query: str, lang: str) -> list[dict]:
    terms = " ".join(re.findall(r"[\w'-]+", query))
    if not terms:
        return []
    clause = f"(title:({terms}) OR creator:({terms})) AND mediatype:texts AND NOT collection:inlibrary " \
             "AND NOT collection:printdisabled AND NOT access-restricted-item:true"
    if lang:
        clause += f" AND language:({lang})"
    fields = "".join(f"&fl[]={f}" for f in ("identifier", "title", "creator", "language", "format", "downloads"))
    resp = _get(f"https://archive.org/advancedsearch.php?q={quote(clause)}{fields}&rows=25&output=json&sort[]=downloads+desc")
    if resp.status_code != 200:
        return []
    out = []
    for d in resp.json().get("response", {}).get("docs", []):
        have = set(d.get("format") or [])
        formats, seen = [], set()
        for fmt, name, label in ARCHIVE_FORMATS:
            if name in have and label not in seen:
                seen.add(label)
                formats.append({"key": name, "label": label})
        if not formats or not _ID.match(d["identifier"]):
            continue
        out.append({"source": "archive", "source_label": "Internet Archive", "id": d["identifier"], "title": _first(d.get("title")),
                    "author": _first(d.get("creator")), "language": _first(d.get("language")), "downloads": d.get("downloads", 0),
                    "formats": formats, "has_cover": True, "page": f"https://archive.org/details/{d['identifier']}"})
    return out


# Archive.org items carry either the language name or its ISO 639-2 code.
ARCHIVE_LANG = {"en": "English OR eng", "hi": "Hindi OR hin", "gu": "Gujarati OR guj", "sa": "Sanskrit OR san"}


@router.get("")
def search(q: str, source: str = "all", lang: str = "", _: dict = Depends(current_profile)):
    query = " ".join(q.split())[:120]
    if len(query) < 2:
        raise HTTPException(400, "Type at least two letters.")
    if lang not in ("", "en", "hi", "gu", "sa"):
        raise HTTPException(400, "Bad language")
    results, errors = [], []
    for name, fn, arg in (("gutenberg", search_gutenberg, lang), ("archive", search_archive, ARCHIVE_LANG.get(lang, ""))):
        if source not in ("all", name):
            continue
        try:
            results.extend(fn(query, arg))
        except (httpx.HTTPError, HTTPException, ValueError, KeyError):
            errors.append(name)
    with tx() as c:
        for r in results:
            hit = q1(c, "SELECT id FROM books WHERE deleted_at IS NULL AND lower(title)=lower(%s) LIMIT 1", r["title"])
            r["in_library"] = hit["id"] if hit else None
    return {"results": results, "unreachable": errors}


@router.get("/cover")
def cover(source: str, id: str):
    if not _ID.match(id) or source not in ("gutenberg", "archive"):
        raise HTTPException(404)
    url = (f"https://www.gutenberg.org/cache/epub/{id}/pg{id}.cover.medium.jpg" if source == "gutenberg"
           else f"https://archive.org/services/img/{id}")
    try:
        resp = _get(url, timeout=10)
    except httpx.HTTPError:
        raise HTTPException(404)
    if resp.status_code != 200 or not resp.headers.get("content-type", "").startswith("image/") or len(resp.content) > 3_000_000:
        raise HTTPException(404)
    return Response(resp.content, media_type=resp.headers["content-type"],
                    headers={"Cache-Control": "private, max-age=86400, no-transform"})


def _resolve(source: str, item_id: str, fmt: str) -> tuple[str, str, str, str]:
    """-> (download url, file extension, title, author)"""
    if source == "gutenberg":
        if not item_id.isdigit():
            raise HTTPException(400, "Bad id")
        resp = _get(f"https://gutendex.com/books/{item_id}/")
        if resp.status_code != 200:
            raise HTTPException(404, "That book was not found at Project Gutenberg.")
        book = resp.json()
        for ext, mime in GUTENBERG_FORMATS:
            if ext == fmt and mime in book["formats"]:
                return (book["formats"][mime].replace("http://", "https://", 1), ext, book["title"],
                        ", ".join(_flip(a["name"]) for a in book.get("authors", [])[:2]))
        raise HTTPException(404, "That format is not available.")
    if source == "archive":
        if not _ID.match(item_id):
            raise HTTPException(400, "Bad id")
        resp = _get(f"https://archive.org/metadata/{item_id}")
        meta = resp.json() if resp.status_code == 200 else {}
        if not meta.get("files") or meta.get("is_dark") or meta.get("metadata", {}).get("access-restricted-item") == "true":
            raise HTTPException(404, "That item is not freely downloadable.")
        ext = next((e for e, name, _ in ARCHIVE_FORMATS if name == fmt), None)
        file = next((f for f in meta["files"] if f.get("format") == fmt and f.get("private") != "true"), None)
        if not ext or not file:
            raise HTTPException(404, "That format is not available.")
        if int(file.get("size") or 0) > config.MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"That file is larger than {config.MAX_UPLOAD_BYTES // 1024 // 1024} MB.")
        md = meta.get("metadata", {})
        return (f"https://archive.org/download/{item_id}/{quote(file['name'])}", ext, _first(md.get("title")), _first(md.get("creator")))
    raise HTTPException(400, "Unknown source")


def _download(book_id: int, url: str, dest: Path, ocr: bool) -> None:
    conn = importer.connect()
    try:
        size = 0
        with httpx.Client(timeout=60, headers=UA, follow_redirects=False) as client:
            for _ in range(6):
                if not _allowed(url):
                    raise ValueError("redirected off the source")
                with client.stream("GET", url) as resp:
                    if resp.is_redirect:
                        url = str(resp.next_request.url).replace("http://", "https://", 1)
                        continue
                    resp.raise_for_status()
                    total = int(resp.headers.get("content-length") or 0)
                    with open(dest, "wb") as out:
                        for chunk in resp.iter_bytes(256 * 1024):
                            size += len(chunk)
                            if size > config.MAX_UPLOAD_BYTES:
                                raise ValueError("too large")
                            out.write(chunk)
                            if total:
                                ex(conn, "UPDATE books SET progress=%s WHERE id=%s", int(size / total * 100), book_id)
                break
        ex(conn, "UPDATE books SET file_size=%s, stage='queued', progress=0 WHERE id=%s", size, book_id)
        importer.submit(book_id, ocr=ocr)
    except Exception as e:
        message = ("That file is larger than the 100 MB limit." if str(e) == "too large"
                   else "The download failed. The source may be busy; try again, or pick another format.")
        ex(conn, "UPDATE books SET status='error', stage='failed', error_code='download', error_msg=%s WHERE id=%s", message, book_id)
    finally:
        conn.close()


@router.post("/add")
def add(body: dict = Body(...), p: dict = Depends(current_profile)):
    source, item_id, fmt = str(body.get("source", "")), str(body.get("id", "")), str(body.get("format", ""))
    try:
        url, ext, title, author = _resolve(source, item_id, fmt)
    except httpx.HTTPError:
        raise HTTPException(502, "The source did not answer. Try again in a moment.")
    page = f"https://www.gutenberg.org/ebooks/{item_id}" if source == "gutenberg" else f"https://archive.org/details/{item_id}"
    with tx() as c:
        book_id = q1(c, "INSERT INTO books (title, author, format, uploaded_by, source_url, stage) "
                        "VALUES (%s,%s,%s,%s,%s,'downloading') RETURNING id",
                     title[:300] or "Untitled", author[:200], ext, p["id"], page)["id"]
        dest = importer.book_dir(book_id) / f"original.{ext}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        ex(c, "UPDATE books SET file_path=%s WHERE id=%s", str(dest), book_id)
    threading.Thread(target=_download, args=(book_id, url, dest, fmt == "Image Container PDF"), daemon=True).start()
    return {"book_id": book_id}
