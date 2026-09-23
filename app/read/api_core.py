"""Access, profiles, library, import and reading endpoints."""
import re
import secrets
import unicodedata
from html import unescape
from urllib.parse import quote
import shutil
import uuid
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse

from . import config, game, importer, security
from .db import tx, q, q1, ex, Jsonb
from .security import current_profile

router = APIRouter(prefix="/api")

AVATAR_MAX = 16
_TAGS = re.compile(r"<[^>]+>")
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
DEFAULT_PROFILE_SETTINGS = {
    "theme": "dark", "font": "serif", "size": 48, "orp_color": "#ff4d4d", "guides": True, "show_wpm": True,
    "wpm": 300, "pause_strength": 1.0, "pause_comma": 1.5, "pause_sentence": 2.0, "pause_paragraph": 3.0,
    "chunk": 1, "ramp": True, "presets": [250, 350, 500], "sound": False, "focus": True, "trail": True, "blink_break": 10, "blink_len": 1000,
}


# ---------------------------------------------------------------- access

def _set_cookie(response: Response, name: str, value: str, max_age: int | None) -> None:
    response.set_cookie(name, value, max_age=max_age, httponly=True, samesite="lax",
                        secure=config.PUBLIC_URL.startswith("https"), path="/")


@router.get("/access")
def access_state(request: Request):
    return {"device": security.device_ok(request), "admin": security.admin_ok(request)}


@router.post("/access/passcode")
def enter_passcode(request: Request, response: Response, body: dict = Body(...)):
    ip = security.client_ip(request)
    wait = security.passcode_limiter.retry_after(ip)
    if wait:
        raise HTTPException(429, f"Too many wrong tries. Wait {-(-wait // 60)} minutes.",
                            headers={"Retry-After": str(wait)})
    with tx() as c:
        stored = q1(c, "SELECT value FROM settings WHERE key='passcode_hash'")["value"]
    if not security.verify_secret(stored, str(body.get("passcode", "")).strip()):
        left = security.passcode_limiter.fail(ip)
        raise HTTPException(401, "Wrong passcode." + (f" {left} tries left." if left else " Locked for 15 minutes."))
    security.passcode_limiter.reset(ip)
    _set_cookie(response, config.DEVICE_COOKIE,
                security.make_token("device", config.DEVICE_COOKIE_DAYS * 86400), config.DEVICE_COOKIE_DAYS * 86400)
    return {"ok": True}


@router.post("/access/logout")
def forget_device(response: Response):
    response.delete_cookie(config.DEVICE_COOKIE, path="/")
    response.delete_cookie(config.ADMIN_COOKIE, path="/")
    return {"ok": True}


@router.post("/access/admin")
def enter_pin(request: Request, response: Response, body: dict = Body(...)):
    ip = "pin:" + security.client_ip(request)
    wait = security.pin_limiter.retry_after(ip)
    if wait:
        raise HTTPException(429, f"Too many wrong tries. Wait {-(-wait // 60)} minutes.")
    with tx() as c:
        stored = q1(c, "SELECT value FROM settings WHERE key='pin_hash'")["value"]
    if not security.verify_secret(stored, str(body.get("pin", "")).strip()):
        security.pin_limiter.fail(ip)
        raise HTTPException(401, "Wrong PIN.")
    security.pin_limiter.reset(ip)
    # No max-age: a session cookie, so the PIN is asked again next browser session (AC-8).
    _set_cookie(response, config.ADMIN_COOKIE, security.make_token("admin", config.ADMIN_SESSION_HOURS * 3600), None)
    return {"ok": True}


@router.post("/access/admin/logout")
def leave_admin(response: Response):
    response.delete_cookie(config.ADMIN_COOKIE, path="/")
    return {"ok": True}


# ---------------------------------------------------------------- profiles

def _validate_profile_fields(body: dict) -> dict:
    out = {}
    if "name" in body:
        name = " ".join(str(body["name"]).split())[:30]
        if not name:
            raise HTTPException(400, "Enter a name.")
        out["name"] = name
    if "avatar" in body:
        out["avatar"] = str(body["avatar"])[:AVATAR_MAX] or "📖"
    if "color" in body:
        if not _COLOR.match(str(body["color"])):
            raise HTTPException(400, "Bad colour.")
        out["color"] = body["color"]
    return out


def public_profile(p: dict) -> dict:
    return {"id": p["id"], "name": p["name"], "avatar": p["avatar"], "color": p["color"],
            "current_streak": p["current_streak"], "level": game.level_for(p["xp"]), "hidden": p["hidden"]}


@router.get("/profiles")
def list_profiles():
    with tx() as c:
        rows = [game.reconcile(c, p) for p in q(c, "SELECT * FROM profiles ORDER BY created_at")]
    return {"profiles": [public_profile(p) for p in rows], "max": config.MAX_PROFILES}


@router.post("/profiles")
def create_profile(body: dict = Body(...)):
    fields = _validate_profile_fields(body)
    if "name" not in fields:
        raise HTTPException(400, "Enter a name.")
    with tx() as c:
        if q1(c, "SELECT count(*) AS n FROM profiles")["n"] >= config.MAX_PROFILES:
            raise HTTPException(409, f"All {config.MAX_PROFILES} profiles are taken.")
        if q1(c, "SELECT 1 FROM profiles WHERE lower(name)=lower(%s)", fields["name"]):
            raise HTTPException(409, "That name is already used.")
        p = q1(c, "INSERT INTO profiles (name, avatar, color, settings, last_reconciled) "
                  "VALUES (%s,%s,%s,%s,%s) RETURNING *",
               fields["name"], fields.get("avatar", "📖"), fields.get("color", "#4f7cff"),
               Jsonb(DEFAULT_PROFILE_SETTINGS), game.today() - timedelta(days=1))
    return public_profile(p)


def me_payload(c, p: dict) -> dict:
    today = game.today()
    day = q1(c, "SELECT * FROM daily_activity WHERE profile_id=%s AND day=%s", p["id"], today)
    calendar = q(c, "SELECT day, goal_met, freeze_used, words FROM daily_activity "
                    "WHERE profile_id=%s AND day > %s ORDER BY day", p["id"], today - timedelta(days=30))
    return {
        **public_profile(p), "settings": {**DEFAULT_PROFILE_SETTINGS, **p["settings"]},
        "goal_type": p["goal_type"], "goal_value": p["goal_value"], "xp": p["xp"],
        "best_streak": p["best_streak"], "freezes": p["freezes"], "tier": game.TIER_NAMES[p["tier"]],
        **game.level_info(p["xp"]), "today": game.goal_progress(p, day), "date": today.isoformat(),
        "calendar": [{"day": r["day"].isoformat(), "met": r["goal_met"], "freeze": r["freeze_used"],
                      "words": r["words"]} for r in calendar],
    }


@router.get("/me")
def me(p: dict = Depends(current_profile)):
    with tx() as c:
        return me_payload(c, game.load_profile(c, p["id"]))


@router.patch("/me")
def update_me(body: dict = Body(...), p: dict = Depends(current_profile)):
    fields = _validate_profile_fields(body)
    with tx() as c:
        if "name" in fields and q1(c, "SELECT 1 FROM profiles WHERE lower(name)=lower(%s) AND id<>%s",
                                   fields["name"], p["id"]):
            raise HTTPException(409, "That name is already used.")
        if "goal_type" in body:
            if body["goal_type"] not in ("minutes", "words"):
                raise HTTPException(400, "Bad goal.")
            fields["goal_type"] = body["goal_type"]
            limit = 100_000 if body["goal_type"] == "words" else 600
            fields["goal_value"] = max(1, min(limit, int(body.get("goal_value", 10))))
        if "hidden" in body:
            fields["hidden"] = bool(body["hidden"])
        if isinstance(body.get("settings"), dict):
            allowed = {k: v for k, v in body["settings"].items() if k in DEFAULT_PROFILE_SETTINGS}
            fields["settings"] = Jsonb({**p["settings"], **allowed})
        for key, value in fields.items():
            ex(c, f"UPDATE profiles SET {key}=%s WHERE id=%s", value, p["id"])
        return me_payload(c, game.load_profile(c, p["id"]))


# ---------------------------------------------------------------- library

BOOK_LIST_SQL = """
    SELECT b.id, b.title, b.author, b.format, b.has_cover, b.word_count, b.script, b.tags, b.warnings,
           b.status, b.stage, b.progress, b.error_code, b.error_msg, b.duplicate_of, b.uploaded_at,
           b.uploaded_by, up.name AS uploader, b.file_size, b.source_url,
           rp.status AS my_status, rp.chapter_ord, rp.word_index, rp.updated_at AS read_at,
           (f.book_id IS NOT NULL) AS favourite,
           CASE WHEN rp.book_id IS NULL OR b.word_count = 0 THEN 0 ELSE
             least(1.0, ((SELECT coalesce(sum(word_count),0) FROM chapters ch
                          WHERE ch.book_id=b.id AND ch.ord < rp.chapter_ord) + rp.word_index)::float / b.word_count)
           END AS fraction
    FROM books b
    LEFT JOIN profiles up ON up.id = b.uploaded_by
    LEFT JOIN reading_progress rp ON rp.book_id = b.id AND rp.profile_id = %s
    LEFT JOIN favourites f ON f.book_id = b.id AND f.profile_id = %s
    WHERE b.deleted_at IS NULL
"""


def _book_json(r: dict) -> dict:
    r = dict(r)
    r["uploaded_at"] = r["uploaded_at"].isoformat()
    r["read_at"] = r["read_at"].isoformat() if r.get("read_at") else None
    r["my_status"] = r["my_status"] or "to_read"
    if r["my_status"] == "finished":
        r["fraction"] = 1
    return r


@router.get("/books")
def list_books(p: dict = Depends(current_profile)):
    with tx() as c:
        rows = q(c, BOOK_LIST_SQL + " ORDER BY b.uploaded_at DESC", p["id"], p["id"])
        colls = q(c, "SELECT c.id, c.name, c.created_by, coalesce(array_agg(cb.book_id) "
                     "FILTER (WHERE cb.book_id IS NOT NULL), '{}') AS book_ids "
                     "FROM collections c LEFT JOIN collection_books cb ON cb.collection_id=c.id "
                     "GROUP BY c.id ORDER BY c.name")
    return {"books": [_book_json(r) for r in rows], "collections": colls}


def get_book(c, book_id: int, ready: bool = False) -> dict:
    b = q1(c, "SELECT * FROM books WHERE id=%s AND deleted_at IS NULL", book_id)
    if not b or (ready and b["status"] != "ready"):
        raise HTTPException(404, "Book not found")
    return b


@router.get("/books/{book_id}")
def book_detail(book_id: int, p: dict = Depends(current_profile)):
    with tx() as c:
        row = q1(c, BOOK_LIST_SQL + " AND b.id=%s", p["id"], p["id"], book_id)
        if not row:
            raise HTTPException(404, "Book not found")
        chapters = q(c, "SELECT ord, title, word_count FROM chapters WHERE book_id=%s ORDER BY ord", book_id)
        readers = q(c, "SELECT pr.id, pr.name, pr.avatar, pr.color, rp.status FROM reading_progress rp "
                       "JOIN profiles pr ON pr.id=rp.profile_id WHERE rp.book_id=%s "
                       "AND rp.status IN ('reading','finished') ORDER BY pr.name", book_id)
        marks = q(c, "SELECT id, chapter_ord, word_index, snippet, note, created_at FROM bookmarks "
                     "WHERE profile_id=%s AND book_id=%s ORDER BY chapter_ord, word_index", p["id"], book_id)
        dup = None
        if row["duplicate_of"]:
            dup = q1(c, "SELECT id, title, author FROM books WHERE id=%s", row["duplicate_of"])
    for m in marks:
        m["created_at"] = m["created_at"].isoformat()
    return {**_book_json(row), "chapters": chapters, "readers": readers, "bookmarks": marks, "duplicate": dup}


def _can_edit(request: Request, book: dict, p: dict) -> bool:
    return security.admin_ok(request) or book["uploaded_by"] == p["id"]


@router.patch("/books/{book_id}")
def edit_book(book_id: int, request: Request, body: dict = Body(...), p: dict = Depends(current_profile)):
    with tx() as c:
        book = get_book(c, book_id)
        if not _can_edit(request, book, p):
            raise HTTPException(403, "Only the uploader or the admin can edit this book.")
        if "title" in body:
            ex(c, "UPDATE books SET title=%s WHERE id=%s", " ".join(str(body["title"]).split())[:300] or "Untitled", book_id)
        if "author" in body:
            ex(c, "UPDATE books SET author=%s WHERE id=%s", " ".join(str(body["author"]).split())[:200], book_id)
        if "tags" in body:
            tags = sorted({" ".join(str(t).lower().split())[:30] for t in body["tags"] if str(t).strip()})[:12]
            ex(c, "UPDATE books SET tags=%s WHERE id=%s", tags, book_id)
    return {"ok": True}


@router.post("/books/{book_id}/cover")
async def replace_cover(book_id: int, request: Request, p: dict = Depends(current_profile)):
    data = await request.body()
    with tx() as c:
        book = get_book(c, book_id)
        if not _can_edit(request, book, p):
            raise HTTPException(403, "Only the uploader or the admin can edit this book.")
        if len(data) > 10 * 1024 * 1024 or not importer.save_cover(book_id, data):
            raise HTTPException(400, "That image could not be read.")
        ex(c, "UPDATE books SET has_cover=true WHERE id=%s", book_id)
    return {"ok": True}


@router.get("/books/{book_id}/cover")
def cover(book_id: int, size: str = "thumb"):
    path = importer.book_dir(book_id) / ("cover.jpg" if size == "full" else "thumb.jpg")
    if not path.exists():
        raise HTTPException(404)
    # "private" keeps covers out of the CDN's shared cache (NF-7) while the browser may keep them.
    return FileResponse(path, media_type="image/jpeg",
                        headers={"Cache-Control": "private, max-age=3600, no-transform"})


@router.get("/books/{book_id}/file")
def original_file(book_id: int):
    with tx() as c:
        book = get_book(c, book_id)
    if not book["file_path"] or not Path(book["file_path"]).exists():
        raise HTTPException(404)
    name = re.sub(r"[^\w\- ]+", "", book["title"])[:80].strip() or "book"
    return FileResponse(book["file_path"], filename=f"{name}.{book['format']}")


@router.get("/books/{book_id}/chapters/{ord_}")
def chapter(book_id: int, ord_: int):
    with tx() as c:
        get_book(c, book_id, ready=True)
        ch = q1(c, "SELECT id, ord, title, text, word_count FROM chapters WHERE book_id=%s AND ord=%s", book_id, ord_)
    if not ch:
        raise HTTPException(404, "Chapter not found")
    return ch


@router.put("/books/{book_id}/status")
def set_status(book_id: int, body: dict = Body(...), p: dict = Depends(current_profile)):
    status = body.get("status")
    if status not in ("to_read", "reading", "finished"):
        raise HTTPException(400, "Bad status")
    with tx() as c:
        get_book(c, book_id)
        ex(c, "INSERT INTO reading_progress (profile_id, book_id, status) VALUES (%s,%s,%s) "
              "ON CONFLICT (profile_id, book_id) DO UPDATE SET status=EXCLUDED.status, updated_at=now(), "
              "finished_at = CASE WHEN EXCLUDED.status='finished' THEN now() ELSE reading_progress.finished_at END",
           p["id"], book_id, status)
    return {"ok": True}


@router.post("/books/{book_id}/favourite")
def toggle_favourite(book_id: int, p: dict = Depends(current_profile)):
    with tx() as c:
        get_book(c, book_id)
        if ex(c, "DELETE FROM favourites WHERE profile_id=%s AND book_id=%s", p["id"], book_id):
            return {"favourite": False}
        ex(c, "INSERT INTO favourites (profile_id, book_id) VALUES (%s,%s)", p["id"], book_id)
    return {"favourite": True}


@router.post("/books/{book_id}/duplicate")
def resolve_duplicate(book_id: int, body: dict = Body(...), p: dict = Depends(current_profile)):
    with tx() as c:
        book = get_book(c, book_id)
        if book["status"] != "duplicate":
            raise HTTPException(409, "Nothing to resolve")
        if body.get("action") == "keep":
            ex(c, "UPDATE books SET status='processing', stage='queued' WHERE id=%s", book_id)
        else:
            ex(c, "DELETE FROM books WHERE id=%s", book_id)
    if body.get("action") == "keep":
        importer.submit(book_id, force=True)
    else:
        importer.remove_files(book_id)
    return {"ok": True}


@router.post("/books/{book_id}/ocr")
def run_ocr(book_id: int, p: dict = Depends(current_profile)):
    with tx() as c:
        book = get_book(c, book_id)
        if book["format"] != "pdf" or book["status"] != "error" or book["error_code"] != "scanned":
            raise HTTPException(409, "OCR is only for scanned PDFs")
        ex(c, "UPDATE books SET status='processing', stage='ocr', progress=0 WHERE id=%s", book_id)
    importer.submit(book_id, ocr=True)
    return {"ok": True}


@router.delete("/books/{book_id}")
def delete_book(book_id: int, request: Request, p: dict = Depends(current_profile)):
    """Soft delete: the book vanishes from the library but its text, files and
    everyone's progress stay for 30 days in the admin's "Recently deleted" bin (AD-1)."""
    with tx() as c:
        book = get_book(c, book_id)
        failed_own = book["uploaded_by"] == p["id"] and book["status"] in ("error", "duplicate")
        if not (security.admin_ok(request) or failed_own):
            raise HTTPException(403, "Admin PIN required")
        if book["status"] == "ready":
            ex(c, "UPDATE books SET deleted_at=now() WHERE id=%s", book_id)
        else:
            ex(c, "DELETE FROM books WHERE id=%s", book_id)
            importer.remove_files(book_id)
    return {"ok": True}


@router.post("/books/recover")
def recover_book(body: dict = Body(...), p: dict = Depends(current_profile)):
    """Rebuild a book from the copy a device kept offline (chapters as the reader received them)."""
    chapters = body.get("chapters") or []
    if not isinstance(chapters, list) or not chapters or len(chapters) > 2000:
        raise HTTPException(400, "No chapters to restore.")
    title = " ".join(str(body.get("title", "")).split())[:300] or "Recovered book"
    author = " ".join(str(body.get("author", "")).split())[:200]
    from .importer.textutil import Parsed, Section
    sections, missing = [], 0
    for ch in chapters:
        text = str(ch.get("text") or "")
        if not text.strip():
            missing += 1
            text = "This chapter was not saved on the device that restored the book. Upload the original file to get it back."
        sections.append(Section(str(ch.get("title") or "")[:200], text.split("\n")))
    parsed = Parsed(title=title, author=author, sections=sections)
    if missing:
        parsed.warnings.append({"code": "partial", "message": f"Restored from a device with {missing} chapter{'s' if missing != 1 else ''} missing. "
                                                                "Upload the original file to complete it."})
    raw = "\n\n".join("\n\n".join([s.title, *s.paragraphs]) for s in sections)
    with tx() as c:
        dup = q1(c, "SELECT id FROM books WHERE deleted_at IS NULL AND status='ready' AND lower(title)=lower(%s)", title)
    if dup:
        return {"book_id": dup["id"], "existing": True}
    book_id = _store_text_book(p, parsed, raw, None, force=True)
    pos = body.get("position") or {}
    if isinstance(pos, dict) and pos.get("chapter_ord") is not None:
        with tx() as c:
            book = get_book(c, book_id)
            _save_position(c, p, book, int(pos.get("chapter_ord", 0)), int(pos.get("word_index", 0)))
    return {"book_id": book_id}


# ---------------------------------------------------------------- collections

@router.post("/collections")
def create_collection(body: dict = Body(...), p: dict = Depends(current_profile)):
    name = " ".join(str(body.get("name", "")).split())[:60]
    if not name:
        raise HTTPException(400, "Enter a name.")
    with tx() as c:
        return q1(c, "INSERT INTO collections (name, created_by) VALUES (%s,%s) RETURNING id, name", name, p["id"])


@router.post("/collections/{cid}/books")
def collection_book(cid: int, body: dict = Body(...), p: dict = Depends(current_profile)):
    with tx() as c:
        if body.get("add", True):
            ex(c, "INSERT INTO collection_books (collection_id, book_id) VALUES (%s,%s) ON CONFLICT DO NOTHING",
               cid, int(body["book_id"]))
        else:
            ex(c, "DELETE FROM collection_books WHERE collection_id=%s AND book_id=%s", cid, int(body["book_id"]))
    return {"ok": True}


@router.delete("/collections/{cid}")
def delete_collection(cid: int, request: Request, p: dict = Depends(current_profile)):
    with tx() as c:
        row = q1(c, "SELECT created_by FROM collections WHERE id=%s", cid)
        if not row:
            raise HTTPException(404)
        if row["created_by"] != p["id"] and not security.admin_ok(request):
            raise HTTPException(403, "Only its creator or the admin can remove a collection.")
        ex(c, "DELETE FROM collections WHERE id=%s", cid)
    return {"ok": True}


# ---------------------------------------------------------------- import

def _new_book(c, p: dict, title: str, author: str, fmt: str, size: int, source_url: str | None = None) -> int:
    return q1(c, "INSERT INTO books (title, author, format, file_size, uploaded_by, source_url) "
                 "VALUES (%s,%s,%s,%s,%s,%s) RETURNING id", title, author, fmt, size, p["id"], source_url)["id"]


def _upload_dir(upload_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", upload_id):
        raise HTTPException(404)
    return config.TMP_DIR / upload_id


@router.post("/uploads")
def start_upload(body: dict = Body(...), p: dict = Depends(current_profile)):
    """Uploads go up in parts: one 100 MB request would hit the CDN's body limit."""
    filename = Path(str(body.get("filename", ""))).name
    size = int(body.get("size", 0))
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in config.ALLOWED_FORMATS:
        raise HTTPException(415, "Supported files: EPUB, PDF, TXT, DOCX, HTML, Markdown, MOBI and AZW3.")
    if size <= 0 or size > config.MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"Files can be up to {config.MAX_UPLOAD_BYTES // 1024 // 1024} MB.")
    upload_id = uuid.uuid4().hex
    d = _upload_dir(upload_id)
    d.mkdir(parents=True)
    (d / "meta").write_text(f"{size}\n{ext}\n{filename}")
    return {"id": upload_id, "chunk_bytes": config.CHUNK_BYTES}


@router.put("/uploads/{upload_id}/{index}")
async def upload_part(upload_id: str, index: int, request: Request, p: dict = Depends(current_profile)):
    d = _upload_dir(upload_id)
    if not d.exists() or not 0 <= index < 64:
        raise HTTPException(404)
    written = 0
    with open(d / f"part{index:03d}", "wb") as f:
        async for piece in request.stream():
            written += len(piece)
            if written > config.CHUNK_BYTES:
                raise HTTPException(413, "Part too large")
            f.write(piece)
    return {"ok": True}


@router.post("/uploads/{upload_id}/complete")
def finish_upload(upload_id: str, p: dict = Depends(current_profile)):
    d = _upload_dir(upload_id)
    if not d.exists():
        raise HTTPException(404)
    size, ext, filename = (d / "meta").read_text().split("\n", 2)
    parts = sorted(d.glob("part*"))
    if sum(x.stat().st_size for x in parts) != int(size):
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, "The upload was incomplete. Try again.")
    title, author = importer.title_from_filename(filename)
    fmt = importer.FORMAT_ALIASES.get(ext, ext)
    with tx() as c:
        book_id = _new_book(c, p, title, author, fmt, int(size))
        target = importer.book_dir(book_id)
        target.mkdir(parents=True, exist_ok=True)
        dest = target / f"original.{ext}"
        with open(dest, "wb") as out:
            for part in parts:
                with open(part, "rb") as src:
                    shutil.copyfileobj(src, out)
        ex(c, "UPDATE books SET file_path=%s WHERE id=%s", str(dest), book_id)
    shutil.rmtree(d, ignore_errors=True)
    importer.submit(book_id)
    return {"book_id": book_id}


def _store_text_book(p: dict, parsed, raw_text: str, source_url: str | None, force: bool = False) -> int:
    with tx() as c:
        book_id = _new_book(c, p, parsed.title or "Untitled", parsed.author, "txt", len(raw_text.encode()), source_url)
        target = importer.book_dir(book_id)
        target.mkdir(parents=True, exist_ok=True)
        dest = target / "original.txt"
        dest.write_text(raw_text, encoding="utf-8")
        ex(c, "UPDATE books SET file_path=%s WHERE id=%s", str(dest), book_id)
    conn = importer.connect()
    try:
        importer.store_parsed(conn, book_id, parsed, force=force)
    except importer.ImportError_ as e:
        ex(conn, "DELETE FROM books WHERE id=%s", book_id)
        importer.remove_files(book_id)
        raise HTTPException(400, e.message)
    finally:
        conn.close()
    return book_id


@router.post("/books/paste")
def paste_text(body: dict = Body(...), p: dict = Depends(current_profile)):
    from .importer.simple import parse_text
    text = str(body.get("text", ""))
    if len(text) > 20_000_000:
        raise HTTPException(413, "That is too much text.")
    parsed = parse_text(text, " ".join(str(body.get("title", "")).split())[:300] or "Pasted text",
                        " ".join(str(body.get("author", "")).split())[:200])
    return {"book_id": _store_text_book(p, parsed, text, None)}


@router.post("/books/url")
def import_url(body: dict = Body(...), p: dict = Depends(current_profile)):
    from .importer.simple import fetch_article
    url = str(body.get("url", "")).strip()
    try:
        parsed = fetch_article(url)
    except importer.ImportError_ as e:
        raise HTTPException(400, e.message)
    raw = "\n\n".join("\n\n".join([s.title, *s.paragraphs]) for s in parsed.sections)
    return {"book_id": _store_text_book(p, parsed, raw, url)}


# ---------------------------------------------------------------- reading

def _save_position(c, p: dict, book: dict, chapter_ord: int, word_index: int) -> None:
    ex(c, "INSERT INTO reading_progress (profile_id, book_id, chapter_ord, word_index, status, started_at) "
          "VALUES (%s,%s,%s,%s,'reading',now()) ON CONFLICT (profile_id, book_id) DO UPDATE SET "
          "chapter_ord=EXCLUDED.chapter_ord, word_index=EXCLUDED.word_index, updated_at=now(), "
          "started_at=coalesce(reading_progress.started_at, now()), "
          "status = CASE WHEN reading_progress.status='to_read' THEN 'reading' ELSE reading_progress.status END",
       p["id"], book["id"], max(0, chapter_ord), max(0, word_index))


@router.put("/reading/position")
def save_position(body: dict = Body(...), p: dict = Depends(current_profile)):
    with tx() as c:
        book = get_book(c, int(body["book_id"]), ready=True)
        first = q1(c, "SELECT 1 FROM reading_progress WHERE profile_id=%s AND book_id=%s", p["id"], book["id"])
        _save_position(c, p, book, int(body.get("chapter_ord", 0)), int(body.get("word_index", 0)))
        if not first:
            game.feed(c, p["id"], "started", book_id=book["id"], title=book["title"])
    return {"ok": True}


@router.post("/reading/beat")
def beat(body: dict = Body(...), p: dict = Depends(current_profile)):
    """One heartbeat from the RSVP reader: where the reader is, which words were
    shown while playing, and for how long. The server alone decides what counts."""
    session_id = str(body.get("session_id", ""))[:64]
    if not session_id:
        raise HTTPException(400, "session_id required")
    events: list[dict] = []
    with tx() as c:
        book = get_book(c, int(body["book_id"]), ready=True)
        ch = q1(c, "SELECT id, ord, title, word_count FROM chapters WHERE book_id=%s AND ord=%s",
                book["id"], int(body.get("chapter_ord", 0)))
        if not ch:
            raise HTTPException(404, "Chapter not found")
        prof = game.load_profile(c, p["id"], lock=True)
        first = q1(c, "SELECT 1 FROM reading_progress WHERE profile_id=%s AND book_id=%s", prof["id"], book["id"])

        pos = body.get("position") or {}
        _save_position(c, prof, book, int(pos.get("chapter_ord", ch["ord"])), int(pos.get("word_index", 0)))
        if not first:
            game.feed(c, prof["id"], "started", book_id=book["id"], title=book["title"])

        seconds = max(0.0, min(float(body.get("active_ms", 0)) / 1000, 90.0))
        ranges = [r for r in (body.get("ranges") or [])[:200] if isinstance(r, list) and len(r) == 2]
        words = game.count_new_words(c, prof["id"], ch["id"], ranges, ch["word_count"]) if ranges else 0
        # Nothing reads faster than the reader's top speed, whatever the client claims.
        words = min(words, int(seconds * 1000 / 60 * 1.15) + 3)
        if words or seconds:
            game.record_reading(c, prof, book, ch, words, seconds, session_id, events)
        if body.get("chapter_end"):
            game.chapter_finished(c, prof, book, ch, events)
        if body.get("book_end"):
            game.book_finished(c, prof, book, events)
        game.check_badges(c, prof, events)
        if secrets.randbelow(200) == 0:
            ex(c, "DELETE FROM read_ranges WHERE seen_at < now() - interval '1 day'")
        return {"events": events, "me": me_payload(c, prof)}


@router.post("/bookmarks")
def add_bookmark(body: dict = Body(...), p: dict = Depends(current_profile)):
    with tx() as c:
        book = get_book(c, int(body["book_id"]), ready=True)
        row = q1(c, "INSERT INTO bookmarks (profile_id, book_id, chapter_ord, word_index, snippet, note) "
                    "VALUES (%s,%s,%s,%s,%s,%s) RETURNING id, chapter_ord, word_index, snippet, note",
                 p["id"], book["id"], int(body["chapter_ord"]), int(body["word_index"]),
                 str(body.get("snippet", ""))[:200], str(body.get("note", ""))[:500])
    return row


@router.patch("/bookmarks/{bid}")
def edit_bookmark(bid: int, body: dict = Body(...), p: dict = Depends(current_profile)):
    with tx() as c:
        ex(c, "UPDATE bookmarks SET note=%s WHERE id=%s AND profile_id=%s", str(body.get("note", ""))[:500], bid, p["id"])
    return {"ok": True}


@router.delete("/bookmarks/{bid}")
def delete_bookmark(bid: int, p: dict = Depends(current_profile)):
    with tx() as c:
        ex(c, "DELETE FROM bookmarks WHERE id=%s AND profile_id=%s", bid, p["id"])
    return {"ok": True}


@router.get("/dictionary/{word}")
def define(word: str):
    import httpx
    # Keep combining marks: \w alone drops Devanagari and Gujarati vowel signs and the virama.
    word = "".join(ch for ch in word if ch in "'-" or unicodedata.category(ch)[0] in "LMN").lower()[:40]
    if not word:
        raise HTTPException(404, "No definition found")
    with tx() as c:
        hit = q1(c, "SELECT data FROM dictionary_cache WHERE word=%s", word)
    if hit:
        data = hit["data"]
    else:
        try:
            resp = httpx.get(f"https://en.wiktionary.org/api/rest_v1/page/definition/{quote(word)}", timeout=8,
                             headers={"User-Agent": f"read-family-library ({config.PUBLIC_URL})"}, follow_redirects=True)
        except httpx.HTTPError:
            raise HTTPException(503, "The dictionary is unreachable right now.")
        if resp.status_code >= 500:
            raise HTTPException(503, "The dictionary is unreachable right now.")
        data = []
        if resp.status_code == 200:
            by_language = resp.json()
            entries = by_language.get("en") or next(iter(by_language.values()), [])
            for entry in entries[:3]:
                definitions = [_TAGS.sub("", unescape(d.get("definition", ""))).strip() for d in entry.get("definitions", [])]
                definitions = [d for d in definitions if d][:2]
                if definitions:
                    data.append({"part": entry.get("partOfSpeech", "").lower(), "definitions": definitions})
        if resp.status_code in (200, 404):      # a throttled or failed lookup must not be remembered as "no definition"
            with tx() as c:
                ex(c, "INSERT INTO dictionary_cache (word, data) VALUES (%s,%s) ON CONFLICT DO NOTHING", word, Jsonb(data))
    if not data:
        raise HTTPException(404, "No definition found")
    return {"word": word, "meanings": data}
