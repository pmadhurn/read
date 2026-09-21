"""Shared text handling for every parser.

Chapter text is stored as paragraphs joined by "\n", each paragraph being words
joined by single spaces. The reader tokenises with exactly those two
separators, so server and client word indexes always agree.
"""
import re
import unicodedata
from dataclasses import dataclass, field

FIXED_PART_WORDS = 5000
MIN_CHAPTER_WORDS = 40

# Zero-width joiner / non-joiner are kept: Hindi and Gujarati shaping needs them.
_DROP = dict.fromkeys(map(ord, "­​⁠﻿￼"), None)
_SPACE = re.compile(r"[\s   -     　\x1c-\x1f\x85]+")

_NUMBER_WORDS = (r"one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|"
                 r"sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty")
_HEADING = re.compile(
    rf"^\s*((chapter|part|book|section|act|canto)\s+(\d+|[ivxlcdm]+|{_NUMBER_WORDS})\b.{{0,80}}"
    r"|(prologue|epilogue|preface|foreword|introduction|afterword|acknowledge?ments|appendix(\s+\w+)?)\s*"
    r"|(अध्याय|भाग|खंड|खण्ड|परिच्छेद|प्रकरण)\s*[\d०-९]+.{0,80}"
    # Sanskrit: "अध्यायः १", "प्रथमः सर्गः", "द्वितीयोऽध्यायः", "बालकाण्डम्", "आदिपर्व" ...
    r"|(अध्यायः|सर्गः|काण्डम्|काण्डः|स्कन्धः|पर्व|मण्डलम्|सूक्तम्|अङ्कः|उल्लासः|पादः|वल्ली|प्रपाठकः)\s*[\d०-९]+.{0,60}"
    r"|\S{2,25}(ोऽध्यायः|\s+अध्यायः|\s+सर्गः|\s+स्कन्धः|\s+अङ्कः|काण्डम्|काण्डः|पर्व)\s*[।॥]?"
    r"|(પ્રકરણ|ભાગ|અધ્યાય|ખંડ)\s*[\d૦-૯]+.{0,80})\s*$",
    re.IGNORECASE)


@dataclass
class Section:
    title: str
    paragraphs: list[str] = field(default_factory=list)


@dataclass
class Parsed:
    title: str = ""
    author: str = ""
    cover: bytes | None = None
    sections: list[Section] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)


class ImportError_(Exception):
    """A problem the uploader should be told about in plain words (IM-7)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def clean(text: str) -> str:
    text = unicodedata.normalize("NFC", text.translate(_DROP))
    return _SPACE.sub(" ", text).strip()


def word_count(paragraph: str) -> int:
    return paragraph.count(" ") + 1 if paragraph else 0


def looks_like_heading(text: str) -> bool:
    return len(text) <= 120 and bool(_HEADING.match(text))


def sections_from_blocks(blocks: list[tuple[bool, str]]) -> list[Section]:
    """Split a flat run of (is_heading, text) blocks into chapters (IM-5 fallback chain):
    marked or detected headings first, fixed-size parts when there are none."""
    sections: list[Section] = [Section("")]
    for is_heading, raw in blocks:
        text = clean(raw)
        if not text:
            continue
        if is_heading or looks_like_heading(text):
            if sections[-1].paragraphs or sections[-1].title:
                sections.append(Section(text))
            else:
                sections[-1].title = text
            continue
        sections[-1].paragraphs.append(text)
    return sections


def finalize(sections: list[Section]) -> list[Section]:
    """Clean, merge stubs into neighbours, split when no structure was found, name the untitled."""
    cleaned: list[Section] = []
    for s in sections:
        paras = [p for p in (clean(x) for x in s.paragraphs) if p]
        title = clean(s.title)[:200]
        words = sum(word_count(p) for p in paras)
        if cleaned and words < MIN_CHAPTER_WORDS:
            # Title pages, dedications and the like are folded into the previous chapter.
            if title:
                cleaned[-1].paragraphs.append(title)
            cleaned[-1].paragraphs.extend(paras)
            continue
        if paras or title:
            cleaned.append(Section(title, paras))
    cleaned = [s for s in cleaned if s.paragraphs]

    total = sum(word_count(p) for s in cleaned for p in s.paragraphs)
    if len(cleaned) <= 1 and total > FIXED_PART_WORDS * 1.5:
        cleaned = _fixed_parts([p for s in cleaned for p in s.paragraphs])
    for i, s in enumerate(cleaned):
        if not s.title:
            s.title = f"Part {i + 1}" if len(cleaned) > 1 else "Full text"
    return cleaned


def _fixed_parts(paragraphs: list[str]) -> list[Section]:
    parts, current, size = [], [], 0
    for p in paragraphs:
        current.append(p)
        size += word_count(p)
        if size >= FIXED_PART_WORDS:
            parts.append(Section("", current))
            current, size = [], 0
    if current:
        if parts and size < FIXED_PART_WORDS // 4:
            parts[-1].paragraphs.extend(current)
        else:
            parts.append(Section("", current))
    return parts


def detect_script(sections: list[Section]) -> str:
    counts = {"deva": 0, "gujr": 0, "latin": 0}
    for s in sections[:30]:
        for p in s.paragraphs[:40]:
            for ch in p:
                o = ord(ch)
                if 0x0900 <= o <= 0x097F:
                    counts["deva"] += 1
                elif 0x0A80 <= o <= 0x0AFF:
                    counts["gujr"] += 1
                elif ch.isalpha():
                    counts["latin"] += 1
    return max(counts, key=counts.get) if any(counts.values()) else "latin"


def garbled_ratio(sections: list[Section]) -> float:
    """Share of characters that are private-use, replacement or control glyphs."""
    bad = total = 0
    for s in sections[:30]:
        for p in s.paragraphs[:40]:
            for ch in p:
                if ch == " ":
                    continue
                total += 1
                if ch == "�" or unicodedata.category(ch) in ("Co", "Cn", "Cc"):
                    bad += 1
    return bad / total if total else 0.0
