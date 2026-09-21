# Requirements status

Source: *read.madhur.dev — Software Requirements Specification*, 2026-09-22. Every phase (v1, v1.1, v1.2, Later) is built.

**How verified** — `API` = `tests/smoke.py` (65 checks), `E2E` = `tests/e2e.mjs` in Chromium, run against the live
site through Cloudflare (38 checks), `LOGIC` = `tests/logic.py` (14 checks), `E2E2` = `tests/e2e2.mjs` (15 checks), `TAPS` = `tests/taps.mjs`,
`CODE` = implemented and exercised by hand or indirectly, with no dedicated automated check.

## Not verified, or deviating from the text

| Item | Note |
|---|---|
| Browsers | Only Chromium was tested. Safari and Firefox are untested. `Intl.Segmenter` (RD-6) needs Firefox 125+; older ones fall back to code points. |
| GM-6 | Push reminders: key generation, subscribe API, 20:00 IST loop and service-worker handler are in place, but no real notification has been delivered end to end. iOS needs the app added to the Home Screen. |
| IM-2 MOBI/AZW3 | DRM detection is tested; unpacking uses the `mobi` library and was not run on a real Kindle file. |
| IM-8 OCR | Verified on an English scan only. Hindi and Gujarati tesseract packs are installed but untested. |
| IM-11 | Legacy-font warning is a font-name and garbled-character heuristic; not tested on a real Kruti Dev PDF. |
| NF-3 | 50 MB PDF in 60 s not measured. A 500,000-word TXT processes in 1 s. |
| NF-2 | 200 books render in ~0.5 s under Chromium's emulated 4G on the server itself; not measured on a real phone network. |
| NF-10 | Keyboard control, focus rings, labels and theme contrast were designed to WCAG AA; no screen-reader or automated contrast audit was run. |
| SP-6 | Measured in headless Chromium at 1000 WPM: mean 0.1–0.5 ms late, p99 under 4 ms. On a heavily loaded machine an isolated word can still slip further. |
| GM-10 | Everyone starts at level 1, so level *n*+1 needs 100 × *n*² XP. |
| §7 / NV-7 | Normal (scrolling) mode saves position but earns no words or XP: only words flashed while playing count, as the spec says. |
| NF-13 / NF-6 | The compose proxy speaks plain HTTP; HTTPS terminates at the Cloudflare tunnel in front of it. |
| NF-5 | Backups sit on the same disk as the data. Offsite copy is not set up. |
| AC-6 | Profiles trust the `X-Profile-Id` header; anyone past the passcode can act as any profile. That is the spec's trust model. |

## Access and profiles
| ID | Status | Verified |
|---|---|---|
| AC-1 every page and API call blocked | done | API, E2E |
| AC-2 one-year device cookie | done | API |
| AC-3 5 tries then 15-minute wait, keyed on the real client IP | done | API |
| AC-4 noindex header and robots.txt | done | API |
| AC-5 picker with name, avatar, streak | done | API, E2E |
| AC-6 create profile, max 10 | done | API, E2E |
| AC-7 last profile remembered, Switch always visible | done | E2E |
| AC-8 admin PIN per browser session | done | API, E2E |
| AC-9 passcode change signs out every device | done | E2E2 |

## Import and library
| ID | Status | Verified |
|---|---|---|
| IM-1 EPUB, text PDF, TXT up to 100 MB (8 MB parts) | done | API, E2E |
| IM-2 DOCX, HTML, Markdown, MOBI/AZW3 | done | API (MOBI: see above) |
| IM-3 paste text, import article from URL (private hosts refused) | done | API, LOGIC |
| IM-4 title, author, cover, TOC; manual edit | done | API |
| IM-5 chapters: TOC/outline → headings → fixed parts | done | API |
| IM-6 PDF cleanup | done | API |
| IM-7 progress, clear DRM/scanned/corrupt errors | done | API, E2E |
| IM-8 OCR for scanned PDFs | done | API |
| IM-9 duplicate warning (keep both / discard) | done | API |
| IM-10 uploader recorded | done | API |
| IM-11 Hindi and Gujarati, legacy-font warning | done | API, E2E |
| LB-1 grid or list | done | E2E |
| LB-2 search and four sorts | done | E2E |
| LB-3 per-profile status | done | API |
| LB-4 Continue reading row | done | E2E2 |
| LB-5 book detail page | done | API, E2E |
| LB-6 tags filter | done | CODE |
| LB-7 favourites and shared collections | done | CODE |

## Reader
| ID | Status | Verified |
|---|---|---|
| RD-1 ORP letter, configurable colour, fixed position | done | E2E (pivot x constant to 1 px) |
| RD-2 ORP by word length | done | E2E |
| RD-3 guide lines | done | E2E screenshot |
| RD-4 WPM, chapter, progress bar, time left | done | E2E screenshot |
| RD-5 chunk mode 1–3 | done | E2E2 |
| RD-6 grapheme-cluster splitting | done | E2E |
| SP-1 100–1000 WPM, slider and ±25 | done | E2E |
| SP-2 customisable presets | done | CODE |
| SP-3 punctuation pauses ×1.5 / ×2 / ×3 with strength | done | CODE |
| SP-4 longer for long words and numbers | done | CODE |
| SP-5 ramp-up from 60% over 2 s | done | CODE |
| SP-6 ±5 ms at 1000 WPM | done | E2E (see above) |
| NV-1 word / sentence / chapter steps | done | E2E |
| NV-2 keyboard map | done | E2E |
| NV-3 tap centre, tap edges, swipe for speed | done | CODE |
| NV-4 paused context, tap a word to jump | done | E2E |
| NV-5 table of contents panel | done | E2E |
| NV-6 position saved every 5 s, on pause and close | done | API, E2E |
| NV-7 normal scrolling mode | done | E2E |
| NV-8 bookmarks with note | done | API |
| NV-9 dictionary definition (Wiktionary, fetched by the server and cached) | done | E2E2 |
| NV-10 focus mode | done | E2E |

## Appearance
| ID | Status | Verified |
|---|---|---|
| AP-1 Dark, Light, Sepia, Follow system | done | E2E |
| AP-2 serif, sans, mono, OpenDyslexic, Atkinson (self-hosted) | done | CODE |
| AP-3 24–96 px | done | CODE |
| AP-4 ORP colour picker | done | CODE |
| AP-5 guides and WPM label toggles | done | CODE |
| AP-6 default speed and pause strength per profile | done | API |
| AP-7 live preview | done | E2E |
| AP-8 profile accent colour | done | CODE |
| AP-9 sounds with mute | done | CODE |
| AP-10 360 px to 4K | done | E2E, TAPS |
| AP-11 bundled Noto Devanagari and Gujarati, chosen automatically | done | E2E |

## Gamification and stats
| ID | Status | Verified |
|---|---|---|
| GM-1 goal presets or custom words | done | API |
| GM-2 goal extends streak, miss resets | done | API, LOGIC |
| GM-3 midnight IST | done | LOGIC |
| GM-4 freezes: earn per 7, hold 2, auto-use | done | LOGIC |
| GM-5 ring, streaks, 30-day calendar | done | E2E |
| GM-6 evening reminder | built | see above |
| GM-7 1 XP per 100 words | done | API |
| GM-8 bonuses +10 / +50 / +200 | done | API |
| GM-9 streak multiplier | done | LOGIC |
| GM-10 levels and level-up pop-up | done | LOGIC |
| GM-11 leaderboard week / month / all | done | API, E2E |
| GM-12 weekly reset, trophies | done | LOGIC |
| GM-13 tiers | done | LOGIC |
| GM-14 activity feed | done | API |
| GM-15 launch badge set (15) | done | API |
| GM-16 badges page with progress | done | API, E2E |
| GM-17 celebration pop-up | done | E2E2 |
| GM-18 hide from boards | done | API |
| §7 only shown words count; 10-minute re-read rule; speed cap | done | API |
| ST-1 session log | done | API |
| ST-2 totals | done | API |
| ST-3 charts | done | E2E |
| ST-4 yearly heatmap | done | E2E |
| ST-5 per-book stats | done | API |
| ST-6 compare two profiles | done | E2E2 |
| ST-7 year in review | done | API, E2E |

## Admin and non-functional
| ID | Status | Verified |
|---|---|---|
| AD-1 delete book, history kept as "deleted book" | done | API |
| AD-2 edit any book | done | API |
| AD-3 rename, reset, delete profile | done | API |
| AD-4 change passcode and PIN | done | E2E2 |
| AD-5 storage and counts | done | API |
| AD-6 re-process a book | done | API |
| AD-7 full backup download | done | API |
| AD-8 XP values and badge thresholds editable | done | API |
| NF-1 reader opens < 2 s for 500k words | done | measured: 62 ms API, ~0.3 s in browser |
| NF-2 library < 2 s with 200 books | done | see above |
| NF-3 50 MB PDF in 60 s | not measured | |
| NF-4 progress local first, synced when online | done | E2E2 |
| NF-5 daily backup, 14 days | done | API |
| NF-6 HTTPS only, argon2 hashes | done | CODE |
| NF-7 book files only behind the cookie, `private` cache headers | done | API |
| NF-8 no third-party analytics, fonts self-hosted, CSP `self` | done | E2E (no external requests) |
| NF-9 installable PWA, current book offline | done | E2E2 (offline reload); install prompt not tested |
| NF-10 accessibility | done | see above |
| NF-11 10 GB plan shown in admin | done | API |
| NF-12 one parser module per format | done | CODE |
| NF-13 Docker Compose: app, db, proxy; volumes; env config | done | restart test |
