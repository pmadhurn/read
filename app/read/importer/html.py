"""HTML to a flat list of blocks. Shared by the EPUB, HTML, Markdown and MOBI parsers."""
import re

import lxml.html
from lxml import etree

BLOCK = {"p", "div", "section", "article", "li", "blockquote", "pre", "tr", "dd", "dt", "figcaption",
         "table", "ul", "ol", "dl", "header", "footer", "main", "aside", "address", "center", "body", "hr"}
HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
SKIP = {"script", "style", "head", "nav", "noscript", "svg", "math", "iframe", "form", "template", "sup"}

# Block kinds: ("h", text) heading, ("p", text) paragraph, ("a", id) anchor that a TOC entry points at.


_XML_DECL = re.compile(r"^\s*<\?xml[^>]*\?>")


def parse_document(data: bytes | str):
    # Decode here: given bytes with no declared charset, lxml assumes Latin-1 and
    # turns Devanagari and Gujarati into mojibake.
    if isinstance(data, bytes):
        try:
            data = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            from charset_normalizer import from_bytes
            best = from_bytes(data).best()
            data = str(best) if best else data.decode("latin-1")
    data = _XML_DECL.sub("", data)
    try:
        return lxml.html.fromstring(data)
    except (etree.ParserError, ValueError):
        return None


def blocks(data: bytes | str, anchors: set[str] | None = None, max_heading_level: int = 3) -> list[tuple[str, str]]:
    root = parse_document(data)
    if root is None:
        return []
    anchors = anchors or set()
    out: list[tuple[str, str]] = []
    buf: list[str] = []

    def flush(kind: str = "p"):
        text = "".join(buf).strip()
        buf.clear()
        if text:
            out.append((kind, text))

    def walk(el):
        if not isinstance(el.tag, str):
            return
        tag = el.tag.rsplit("}", 1)[-1].lower()
        if tag in SKIP:
            return
        el_id = el.get("id") or el.get("name")
        if el_id and el_id in anchors:
            flush()
            out.append(("a", el_id))
        is_heading = tag in HEADINGS
        is_block = is_heading or tag in BLOCK
        if is_block:
            flush()
        if tag == "br":
            buf.append(" ")
        if el.text:
            buf.append(el.text)
        for child in el:
            walk(child)
            if child.tail:
                buf.append(child.tail)
        if is_block:
            flush("h" if is_heading and int(tag[1]) <= max_heading_level else "p")

    walk(root)
    flush()
    return out


def title_of(data: bytes | str) -> str:
    root = parse_document(data)
    if root is None:
        return ""
    found = root.xpath("//title/text()") or root.xpath("//h1//text()")
    return " ".join("".join(found[:1]).split())
