"""TXT, HTML, Markdown, DOCX, MOBI/AZW3, pasted text and web articles."""
import ipaddress
import re
import shutil
import socket
import struct
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from . import html, epub
from .textutil import Parsed, ImportError_, clean, sections_from_blocks


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16"):
        try:
            return data.decode(enc)
        except UnicodeError:
            continue
    from charset_normalizer import from_bytes
    best = from_bytes(data).best()
    return str(best) if best else data.decode("latin-1")


def parse_text(text: str, title: str = "", author: str = "") -> Parsed:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    chunks = re.split(r"\n\s*\n", text)
    if len(chunks) < max(3, text.count("\n") // 40):
        chunks = text.split("\n")      # no blank lines between paragraphs: one paragraph per line
    blocks = [(False, " ".join(c.split("\n"))) for c in chunks]
    return Parsed(title=title, author=author, sections=sections_from_blocks(blocks))


def parse_txt(path: str) -> Parsed:
    return parse_text(_decode(Path(path).read_bytes()))


def parse_html_bytes(data: bytes | str) -> Parsed:
    blocks = [(kind == "h", text) for kind, text in html.blocks(data, max_heading_level=2)]
    if not blocks:
        raise ImportError_("corrupt", "No readable text was found in this file.")
    return Parsed(title=html.title_of(data), sections=sections_from_blocks(blocks))


def parse_html(path: str) -> Parsed:
    return parse_html_bytes(Path(path).read_bytes())


def parse_markdown(path: str) -> Parsed:
    from markdown_it import MarkdownIt
    rendered = MarkdownIt("commonmark").enable("table").render(_decode(Path(path).read_bytes()))
    return parse_html_bytes(f"<html><body>{rendered}</body></html>")


def parse_docx(path: str) -> Parsed:
    import docx
    try:
        doc = docx.Document(path)
    except Exception:
        raise ImportError_("corrupt", "This Word document is damaged and cannot be opened.")
    blocks = []
    for p in doc.paragraphs:
        style = (p.style.name or "").lower() if p.style is not None else ""
        is_heading = style.startswith("heading") and style[-1:] in "12" or style == "title"
        blocks.append((bool(is_heading), p.text))
    props = doc.core_properties
    return Parsed(title=clean(props.title or ""), author=clean(props.author or ""),
                  sections=sections_from_blocks(blocks))


def _mobi_encrypted(path: str) -> bool:
    with open(path, "rb") as f:
        head = f.read(78 + 8)
        if len(head) < 86 or head[60:68] not in (b"BOOKMOBI", b"TEXtREAd"):
            raise ImportError_("corrupt", "This is not a valid MOBI or AZW3 file.")
        first = struct.unpack(">I", head[78:82])[0]
        f.seek(first + 12)
        return struct.unpack(">H", f.read(2))[0] != 0


def parse_mobi(path: str) -> Parsed:
    if _mobi_encrypted(path):
        raise ImportError_("drm", "This Kindle book is DRM-protected. Only DRM-free books can be imported.")
    import mobi
    try:
        tmpdir, extracted = mobi.extract(path)
    except Exception:
        raise ImportError_("corrupt", "This MOBI/AZW3 file could not be unpacked.")
    try:
        if extracted.lower().endswith(".epub"):
            return epub.parse(extracted)
        if extracted.lower().endswith((".html", ".htm")):
            return parse_html(extracted)
        raise ImportError_("corrupt", "This Kindle file holds no readable text.")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            return False
    return bool(infos)


def fetch_article(url: str) -> Parsed:
    """IM-3. Only public http(s) hosts: the server sits next to private services."""
    import httpx
    import trafilatura
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or not _public_host(parsed.hostname):
        raise ImportError_("bad_url", "That address cannot be fetched.")
    try:
        with httpx.Client(follow_redirects=False, timeout=20,
                          headers={"User-Agent": "Mozilla/5.0 (compatible; read-importer)"}) as client:
            for _ in range(5):
                resp = client.get(url)
                if resp.is_redirect:
                    url = str(resp.next_request.url)
                    if not _public_host(urlparse(url).hostname or ""):
                        raise ImportError_("bad_url", "That address cannot be fetched.")
                    continue
                break
            resp.raise_for_status()
    except httpx.HTTPError:
        raise ImportError_("fetch_failed", "The page could not be downloaded.")
    if len(resp.content) > 15 * 1024 * 1024:
        raise ImportError_("too_large", "That page is too large to import.")
    page = resp.text
    text = trafilatura.extract(page, include_comments=False, include_tables=False, favor_recall=True)
    if not text or len(text.split()) < 50:
        raise ImportError_("no_article", "No article text was found on that page.")
    meta = trafilatura.extract_metadata(page)
    result = parse_text(text.replace("\n", "\n\n"))
    result.title = clean((meta.title if meta else "") or html.title_of(page) or parsed.hostname)
    result.author = clean((meta.author if meta else "") or (meta.sitename if meta else "") or parsed.hostname)
    return result


def scratch_dir() -> str:
    return tempfile.mkdtemp(prefix="read-")
