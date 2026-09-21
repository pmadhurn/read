"""Book processing. Uploads return at once; parsing runs in worker processes and
the client polls the book's status (IM-7)."""
import io
import multiprocessing
import re
import shutil
import traceback
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from .. import config
from ..db import connect, q, q1, ex, Jsonb
from .textutil import Parsed, ImportError_, finalize, detect_script, garbled_ratio, word_count, clean

_executor: ProcessPoolExecutor | None = None

FORMAT_ALIASES = {"htm": "html", "markdown": "md", "azw": "mobi", "azw3": "mobi"}


def executor() -> ProcessPoolExecutor:
    global _executor
    if _executor is None:
        _executor = ProcessPoolExecutor(max_workers=2, mp_context=multiprocessing.get_context("spawn"))
    return _executor


def submit(book_id: int, ocr: bool = False, force: bool = False) -> None:
    executor().submit(process_book, book_id, ocr, force)


def resume_pending() -> None:
    conn = connect()
    try:
        ex(conn, "UPDATE books SET status='error', stage='failed', error_code='download', "
                 "error_msg='The download was interrupted. Add the book again.' "
                 "WHERE status='processing' AND stage='downloading'")
        for row in q(conn, "SELECT id FROM books WHERE status='processing' AND deleted_at IS NULL"):
            submit(row["id"])
    finally:
        conn.close()


def book_dir(book_id: int) -> Path:
    return config.BOOKS_DIR / str(book_id)


def title_from_filename(name: str) -> tuple[str, str]:
    stem = re.sub(r"[_\s]+", " ", Path(name).stem).strip()
    if " - " in stem:
        left, right = stem.split(" - ", 1)
        return right.strip(), left.strip()
    return stem, ""


def _parse(fmt: str, path: str, ocr: bool, progress) -> Parsed:
    from . import epub, pdf, simple
    fmt = FORMAT_ALIASES.get(fmt, fmt)
    if fmt == "epub":
        return epub.parse(path)
    if fmt == "pdf":
        return pdf.parse(path, ocr=ocr, progress=progress)
    if fmt == "txt":
        return simple.parse_txt(path)
    if fmt == "html":
        return simple.parse_html(path)
    if fmt == "md":
        return simple.parse_markdown(path)
    if fmt == "docx":
        return simple.parse_docx(path)
    if fmt == "mobi":
        return simple.parse_mobi(path)
    raise ImportError_("unsupported", f"“.{fmt}” files are not supported.")


def save_cover(book_id: int, data: bytes) -> bool:
    from PIL import Image
    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return False
    d = book_dir(book_id)
    d.mkdir(parents=True, exist_ok=True)
    full = img.copy()
    full.thumbnail((900, 1350))
    full.save(d / "cover.jpg", "JPEG", quality=85)
    img.thumbnail((300, 450))      # small grid image keeps the library fast (NF-2)
    img.save(d / "thumb.jpg", "JPEG", quality=80)
    return True


def store_parsed(conn, book_id: int, parsed: Parsed, force: bool, keep_meta: bool = False) -> None:
    book = q1(conn, "SELECT * FROM books WHERE id=%s", book_id)
    sections = finalize(parsed.sections)
    total = sum(word_count(p) for s in sections for p in s.paragraphs)
    if total < 20:
        raise ImportError_("empty", "No readable text was found in this file.")

    title = book["title"] if keep_meta and book["title"] else clean(parsed.title) or book["title"] or "Untitled"
    author = book["author"] if keep_meta and book["author"] else clean(parsed.author) or book["author"]
    warnings = list(parsed.warnings)
    if garbled_ratio(sections) > 0.08 and not any(w["code"] == "legacy_font" for w in warnings):
        warnings.append({"code": "garbled", "message": "Much of this text extracted as unreadable symbols. "
                                                        "The file probably uses non-Unicode fonts."})

    if not force and not keep_meta:
        dup = q1(conn, "SELECT id FROM books WHERE id<>%s AND deleted_at IS NULL AND status='ready' "
                       "AND lower(title)=lower(%s) AND lower(author)=lower(%s)", book_id, title, author)
        if dup:
            ex(conn, "UPDATE books SET title=%s, author=%s, status='duplicate', duplicate_of=%s, "
                     "stage='duplicate' WHERE id=%s", title, author, dup["id"], book_id)
            return

    has_cover = book["has_cover"]
    if parsed.cover and not (keep_meta and has_cover):
        has_cover = save_cover(book_id, parsed.cover)

    with conn.transaction():
        ex(conn, "DELETE FROM chapters WHERE book_id=%s", book_id)
        for i, s in enumerate(sections):
            text = "\n".join(s.paragraphs)
            ex(conn, "INSERT INTO chapters (book_id, ord, title, text, word_count) VALUES (%s,%s,%s,%s,%s)",
               book_id, i, s.title, text, sum(word_count(p) for p in s.paragraphs))
        ex(conn, "UPDATE books SET title=%s, author=%s, word_count=%s, script=%s, warnings=%s, has_cover=%s, "
                 "status='ready', stage='done', progress=100, error_code=NULL, error_msg=NULL, duplicate_of=NULL "
                 "WHERE id=%s", title, author, total, detect_script(sections), Jsonb(warnings), has_cover, book_id)
        ex(conn, "UPDATE reading_progress SET chapter_ord = least(chapter_ord, %s) WHERE book_id=%s",
           len(sections) - 1, book_id)


def process_book(book_id: int, ocr: bool = False, force: bool = False) -> None:
    conn = connect()
    try:
        book = q1(conn, "SELECT * FROM books WHERE id=%s", book_id)
        if not book or not book["file_path"]:
            return
        reprocess = book["word_count"] > 0

        def progress(pct: int):
            ex(conn, "UPDATE books SET progress=%s WHERE id=%s", pct, book_id)

        ex(conn, "UPDATE books SET status='processing', stage=%s, progress=0 WHERE id=%s",
           "ocr" if ocr else "parsing", book_id)
        parsed = _parse(book["format"], book["file_path"], ocr, progress)
        ex(conn, "UPDATE books SET stage='chapters', progress=92 WHERE id=%s", book_id)
        store_parsed(conn, book_id, parsed, force=force or reprocess, keep_meta=reprocess)
    except ImportError_ as e:
        ex(conn, "UPDATE books SET status='error', stage='failed', error_code=%s, error_msg=%s WHERE id=%s",
           e.code, e.message, book_id)
    except Exception:
        traceback.print_exc()
        ex(conn, "UPDATE books SET status='error', stage='failed', error_code='corrupt', error_msg=%s WHERE id=%s",
           "This file could not be processed. It may be corrupt.", book_id)
    finally:
        conn.close()


def remove_files(book_id: int) -> None:
    shutil.rmtree(book_dir(book_id), ignore_errors=True)
