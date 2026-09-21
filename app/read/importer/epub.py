import posixpath
import zipfile
from urllib.parse import unquote

from lxml import etree

from . import html
from .textutil import Parsed, Section, ImportError_, sections_from_blocks

NS = {
    "c": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
    "ncx": "http://www.daisy.org/z3986/2005/ncx/",
    "x": "http://www.w3.org/1999/xhtml",
    "ops": "http://www.idpf.org/2007/ops",
}
# Font obfuscation is listed in encryption.xml too, and is not DRM.
_FONT_OBFUSCATION = ("http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC")


def _xml(zf: zipfile.ZipFile, name: str):
    return etree.fromstring(zf.read(name), etree.XMLParser(recover=True, resolve_entities=False))


def _has_drm(zf: zipfile.ZipFile) -> bool:
    if "META-INF/encryption.xml" not in zf.namelist():
        return False
    try:
        root = _xml(zf, "META-INF/encryption.xml")
    except Exception:
        return True
    algorithms = [el.get("Algorithm", "") for el in root.iter() if el.tag.endswith("EncryptionMethod")]
    return any(a not in _FONT_OBFUSCATION for a in algorithms)


def _resolve(base: str, href: str) -> tuple[str, str]:
    path, _, frag = href.partition("#")
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), unquote(path))), frag


def _toc_ncx(zf, path) -> list[tuple[str, str, str]]:
    root = _xml(zf, path)
    out = []
    for point in root.iterfind(".//ncx:navPoint", NS):
        label = point.find("ncx:navLabel/ncx:text", NS)
        content = point.find("ncx:content", NS)
        if label is not None and content is not None and content.get("src"):
            out.append((" ".join((label.text or "").split()), *_resolve(path, content.get("src"))))
    return out


def _toc_nav(zf, path) -> list[tuple[str, str, str]]:
    root = _xml(zf, path)
    navs = root.findall(".//x:nav", NS)
    nav = next((n for n in navs if n.get(f"{{{NS['ops']}}}type") == "toc"), navs[0] if navs else None)
    if nav is None:
        return []
    out = []
    for a in nav.iterfind(".//x:a", NS):
        if a.get("href"):
            out.append((" ".join("".join(a.itertext()).split()), *_resolve(path, a.get("href"))))
    return out


def parse(path: str) -> Parsed:
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise ImportError_("corrupt", "This EPUB file is damaged and cannot be opened.")
    with zf:
        if _has_drm(zf):
            raise ImportError_("drm", "This EPUB is DRM-protected. Only DRM-free books can be imported.")
        try:
            container = _xml(zf, "META-INF/container.xml")
            opf_path = container.find(".//c:rootfile", NS).get("full-path")
            opf = _xml(zf, opf_path)
        except Exception:
            raise ImportError_("corrupt", "This EPUB is missing its package file and cannot be read.")

        def meta(tag):
            el = opf.find(f".//dc:{tag}", NS)
            return " ".join((el.text or "").split()) if el is not None else ""

        manifest = {}
        for item in opf.iterfind(".//opf:manifest/opf:item", NS):
            manifest[item.get("id")] = {
                "path": _resolve(opf_path, item.get("href", ""))[0],
                "type": item.get("media-type", ""),
                "props": item.get("properties", ""),
            }
        spine_el = opf.find(".//opf:spine", NS)
        spine = [manifest[i.get("idref")]["path"] for i in spine_el.iterfind("opf:itemref", NS)
                 if i.get("idref") in manifest] if spine_el is not None else []
        names = set(zf.namelist())

        toc: list[tuple[str, str, str]] = []
        nav_item = next((m for m in manifest.values() if "nav" in m["props"].split()), None)
        if nav_item and nav_item["path"] in names:
            toc = _toc_nav(zf, nav_item["path"])
        if not toc and spine_el is not None and spine_el.get("toc") in manifest:
            ncx = manifest[spine_el.get("toc")]["path"]
            if ncx in names:
                toc = _toc_ncx(zf, ncx)

        cover = None
        cover_item = next((m for m in manifest.values() if "cover-image" in m["props"].split()), None)
        if cover_item is None:
            ref = opf.find(".//opf:meta[@name='cover']", NS)
            if ref is not None:
                cover_item = manifest.get(ref.get("content"))
        if cover_item is None:
            cover_item = next((m for m in manifest.values()
                               if m["type"].startswith("image/") and "cover" in m["path"].lower()), None)
        if cover_item and cover_item["path"] in names:
            cover = zf.read(cover_item["path"])

        targets: dict[str, dict[str, str]] = {}   # file -> {fragment: title}
        for title, file, frag in toc:
            targets.setdefault(file, {}).setdefault(frag, title)

        nav_path = nav_item["path"] if nav_item else None
        flat: list[tuple[bool, str]] = []
        sections: list[Section] = []
        for file in spine:
            if file not in names or file == nav_path:
                continue
            anchors = targets.get(file, {})
            doc_blocks = html.blocks(zf.read(file), set(a for a in anchors if a))
            if toc:
                if "" in anchors:
                    sections.append(Section(anchors[""]))
                elif not sections:
                    sections.append(Section(""))
                for kind, text in doc_blocks:
                    if kind == "a":
                        sections.append(Section(anchors[text]))
                    else:
                        sections[-1].paragraphs.append(text)
            else:
                flat.extend((kind == "h", text) for kind, text in doc_blocks if kind != "a")

        if not toc:
            sections = sections_from_blocks(flat)
        else:
            # A chapter's own heading usually repeats its TOC title; drop the echo.
            for s in sections:
                if not (s.paragraphs and s.title):
                    continue
                head, title = s.paragraphs[0].strip().lower(), s.title.strip().lower()
                if len(head) < 120 and (head == title or title.startswith(head) or title.endswith(head)):
                    s.paragraphs.pop(0)

    return Parsed(title=meta("title"), author=meta("creator"), cover=cover, sections=sections)
