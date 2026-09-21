import re
import subprocess
from collections import Counter

import fitz  # PyMuPDF

from .textutil import Parsed, Section, ImportError_, clean, sections_from_blocks

# Pre-Unicode Indic fonts: text extracts as Latin gibberish even though it looks right on the page (IM-11).
_LEGACY_FONTS = re.compile(
    r"sanskrit ?(98|99|1\.2)|kruti|krutidev|devlys|dev ?lys|shusha|shree-?(dev|guj|lipi)|chanakya|walkman|agra|aps-|4cgandhi|"
    r"lmg|terafont|saumil|gopika|harikrishna|nilkanth|ghanshyam|bhasha|avantika|krishna|shivaji|mangal-legacy",
    re.IGNORECASE)
_PAGE_NUMBER = re.compile(r"^\W*(page\s*)?(\d{1,4}|[ivxlcdm]{1,7})(\s*(of|/)\s*\d{1,4})?\W*$", re.IGNORECASE)
_SENTENCE_END = re.compile(r"[.!?।॥:;\"'”’)\]]\s*$")
_DIGITS = re.compile(r"\d+")


def _signature(text: str) -> str:
    return _DIGITS.sub("#", clean(text).lower())[:80]


def _join_lines(lines: list[str]) -> str:
    """Rejoin words hyphenated across a line break, merge the rest with spaces (IM-6)."""
    out = ""
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if out.endswith("-") and len(out) > 1 and out[-2].isalpha() and line[0].islower():
            out = out[:-1] + line
        else:
            out = f"{out} {line}" if out else line
    return out


def _page_blocks(page, ocr_lang: str | None) -> list[tuple[float, float, str]]:
    if ocr_lang:
        pix = page.get_pixmap(dpi=200)
        res = subprocess.run(["tesseract", "stdin", "stdout", "-l", ocr_lang, "--psm", "3"],
                             input=pix.tobytes("png"), capture_output=True, timeout=300)
        text = res.stdout.decode("utf-8", "replace")
        paras = [_join_lines(p.splitlines()) for p in re.split(r"\n\s*\n", text)]
        height = page.rect.height
        n = max(1, len(paras))
        return [(height * i / n, height * (i + 1) / n, p) for i, p in enumerate(paras) if p]
    out = []
    for b in page.get_text("blocks", sort=True):
        if b[6] != 0:          # image block
            continue
        text = _join_lines(b[4].splitlines())
        if text:
            out.append((b[1], b[3], text))
    return out


def parse(path: str, ocr: bool = False, progress=lambda pct: None) -> Parsed:
    try:
        doc = fitz.open(path)
    except Exception:
        raise ImportError_("corrupt", "This PDF is damaged and cannot be opened.")
    with doc:
        if doc.needs_pass:
            raise ImportError_("drm", "This PDF is password-protected. Remove the protection and upload it again.")
        if doc.page_count == 0:
            raise ImportError_("corrupt", "This PDF has no pages.")

        if not ocr:
            sample = range(0, doc.page_count, max(1, doc.page_count // 30))
            chars = sum(len(doc[i].get_text("text").strip()) for i in sample)
            if chars / len(list(sample)) < 25:
                raise ImportError_("scanned", "This PDF is scanned images with no text layer. "
                                              "Run OCR on it to make it readable.")

        warnings = []
        fonts = {f[3] for i in range(min(doc.page_count, 40)) for f in doc.get_page_fonts(i)}
        legacy = sorted(f for f in fonts if _LEGACY_FONTS.search(f))
        if legacy and not ocr:
            warnings.append({"code": "legacy_font",
                             "message": "This PDF uses old non-Unicode fonts (" + ", ".join(legacy[:3]) +
                                        "). Hindi, Sanskrit or Gujarati text may come out garbled. "
                                        "A Unicode edition, or OCR, will read correctly."})

        ocr_lang = "eng+hin+guj+san" if ocr else None
        pages: list[list[tuple[float, float, str]]] = []
        for i, page in enumerate(doc):
            pages.append(_page_blocks(page, ocr_lang))
            if i % 5 == 0:
                progress(int(90 * (i + 1) / doc.page_count))

        # Running headers and footers: the same text (digits aside) at the edge of many pages.
        edge = Counter()
        for blocks in pages:
            for _, _, text in {*(blocks[:2]), *(blocks[-2:])}:
                edge[_signature(text)] += 1
        threshold = max(3, doc.page_count * 0.3)
        repeated = {sig for sig, n in edge.items() if n >= threshold and len(sig) < 80}

        page_paragraphs: list[list[str]] = []
        for page, blocks in zip(doc, pages):
            height = page.rect.height
            kept = []
            for idx, (y0, y1, text) in enumerate(blocks):
                at_edge = idx < 2 or idx >= len(blocks) - 2
                in_margin = y1 < height * 0.12 or y0 > height * 0.88
                if at_edge and _signature(text) in repeated:
                    continue
                if (at_edge or in_margin) and _PAGE_NUMBER.match(text):
                    continue
                kept.append(text)
            page_paragraphs.append(kept)

        def merged(page_range) -> list[str]:
            """Blocks to paragraphs, healing ones broken by a page or column end."""
            paras: list[str] = []
            for p in page_range:
                for text in page_paragraphs[p]:
                    if (paras and not _SENTENCE_END.search(paras[-1]) and text[:1].islower()
                            and len(paras[-1]) > 40):
                        paras[-1] = _join_lines([paras[-1], text])
                    else:
                        paras.append(text)
            return paras

        outline = [(lvl, clean(title), page - 1) for lvl, title, page in doc.get_toc(simple=True)
                   if 0 < page <= doc.page_count and clean(title)]
        top = [e for e in outline if e[0] == 1]
        if len(top) < 3:
            top = [e for e in outline if e[0] <= 2]

        sections: list[Section] = []
        if len(top) >= 2:
            starts = []
            for _, title, page in top:
                if starts and starts[-1][1] == page:
                    continue            # two entries on one page: keep the first
                starts.append((title, page))
            if starts[0][1] > 0:
                starts.insert(0, ("Front matter", 0))
            for i, (title, page) in enumerate(starts):
                end = starts[i + 1][1] if i + 1 < len(starts) else doc.page_count
                paras = merged(range(page, end))
                if paras and paras[0].strip().lower() == title.lower():
                    paras.pop(0)
                sections.append(Section(title, paras))
        else:
            sections = sections_from_blocks([(False, p) for p in merged(range(doc.page_count))])

        meta = doc.metadata or {}
        cover = None
        try:
            page = doc[0]
            zoom = 800 / max(page.rect.width, 1)
            cover = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False).tobytes("png")
        except Exception:
            pass

    return Parsed(title=clean(meta.get("title") or ""), author=clean(meta.get("author") or ""),
                  cover=cover, sections=sections, warnings=warnings)
