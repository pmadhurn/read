"""End-to-end API check against a running stack. Usage: smoke.py BASE PASSCODE PIN"""
import json, sys, time, uuid
from pathlib import Path
import urllib.request, urllib.error, http.cookiejar

BASE, PASSCODE, PIN = sys.argv[1:4]
FX = Path(__file__).parent / "fixtures"
cookies = {}   # kept by hand: the cookies are Secure and this test may run over plain http
profile = None
results = []

def call(method, path, body=None, raw=None, headers=None, anon=False):
    h = {"CF-Connecting-IP": "203.0.113.9", **(headers or {})}
    data = raw
    if body is not None:
        data = json.dumps(body).encode(); h["Content-Type"] = "application/json"
    if profile: h["X-Profile-Id"] = str(profile)
    if cookies and not anon: h["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        r = urllib.request.urlopen(req, timeout=300)
        txt = r.read(); code = r.status; hdr = r.headers
        if not anon:
            for sc in hdr.get_all("Set-Cookie") or []:
                k, v = sc.split(";")[0].split("=", 1); cookies[k] = v
    except urllib.error.HTTPError as e:
        txt = e.read(); code = e.code; hdr = e.headers
    try: return code, json.loads(txt), hdr
    except Exception: return code, txt, hdr

def check(name, ok, info=""):
    results.append(ok); print(("PASS" if ok else "FAIL"), name, info if not ok else "")

def upload(name):
    data = (FX / name).read_bytes()
    code, up, _ = call("POST", "/api/uploads", {"filename": name, "size": len(data)})
    assert code == 200, up
    n = up["chunk_bytes"]
    for i in range(0, max(1, -(-len(data) // n))):
        call("PUT", f"/api/uploads/{up['id']}/{i}", raw=data[i * n:(i + 1) * n])
    code, done, _ = call("POST", f"/api/uploads/{up['id']}/complete")
    assert code == 200, done
    for _ in range(120):
        code, b, _ = call("GET", f"/api/books/{done['book_id']}")
        if b["status"] != "processing": return b
        time.sleep(0.5)
    return b

# AC-1 / AC-4
code, _, hdr = call("GET", "/api/books", anon=True); check("AC-1 api blocked", code == 401)
code, body, hdr = call("GET", "/", anon=True, headers={"Accept": "text/html"})
check("AC-1 page blocked, gate served", code == 401 and b"Family passcode" in body)
check("AC-4 noindex header", "noindex" in hdr.get("X-Robots-Tag", ""))
check("no-transform header", "no-transform" in hdr.get("Cache-Control", ""))
code, body, _ = call("GET", "/robots.txt", anon=True); check("AC-4 robots.txt", code == 200 and b"Disallow: /" in body)
code, body, _ = call("GET", "/js/app.js", anon=True); check("AC-1 static blocked", code == 401)

# AC-3 rate limit (separate IP so the main run is unaffected)
ip = "198.51.100.%d" % (int(time.time()) % 250)
codes = [call("POST", "/api/access/passcode", {"passcode": "nope"}, headers={"CF-Connecting-IP": ip}, anon=True)[0] for _ in range(6)]
check("AC-3 lockout after 5", codes[:5] == [401] * 5 and codes[5] == 429, codes)
code, _, _ = call("POST", "/api/access/passcode", {"passcode": PASSCODE}, headers={"CF-Connecting-IP": ip}, anon=True)
check("AC-3 locked even with right passcode", code == 429)

code, _, hdr = call("POST", "/api/access/passcode", {"passcode": PASSCODE}); check("AC-2 passcode ok", code == 200)
ck = hdr.get("Set-Cookie", ""); check("AC-2 long-lived cookie", "Max-Age=31536000" in ck and "HttpOnly" in ck, ck)

# profiles
name = "Tester" + uuid.uuid4().hex[:4]
code, p, _ = call("POST", "/api/profiles", {"name": name, "avatar": "🦊", "color": "#22aa66"}); check("AC-6 create profile", code == 200, p)
profile = p["id"]
code, lst, _ = call("GET", "/api/profiles"); check("AC-5 picker data", any(x["id"] == profile and "current_streak" in x for x in lst["profiles"]))
code, me, _ = call("PATCH", "/api/me", {"goal_type": "words", "goal_value": 200, "settings": {"theme": "sepia", "wpm": 450}})
check("AP/GM-1 settings saved server-side", me["settings"]["theme"] == "sepia" and me["goal_value"] == 200)

# imports
epub = upload("test.epub")
check("IM-1 epub ready", epub["status"] == "ready", epub)
check("IM-4 epub metadata", epub["title"] == "Test Book of Foxes" and epub["author"] == "Asha Author")
check("IM-5 epub chapters from TOC", [c["title"] for c in epub["chapters"]] == ["Chapter 1: The Fox", "Chapter 2: The Dog", "Chapter 3: The End"], epub["chapters"])
check("IM-10 uploader recorded", epub["uploader"] == name)
pdf = upload("test.pdf")
check("IM-1 pdf ready", pdf["status"] == "ready", pdf)
check("IM-5 pdf chapters from outline", [c["title"] for c in pdf["chapters"]] == ["Chapter One", "Chapter Two"], pdf["chapters"])
code, ch, _ = call("GET", f"/api/books/{pdf['id']}/chapters/0")
check("IM-6 header/page numbers dropped", "Running Header" not in ch["text"] and not any(l.strip().isdigit() for l in ch["text"].split("\n")), ch["text"][:200])
check("IM-6 hyphenation rejoined", "hyphenated" in ch["text"] and "hyphen- ated" not in ch["text"])
check("IM-6 lines merged into paragraphs", ch["text"].count("\n") < 12, ch["text"].count("\n"))
check("cover extracted", pdf["has_cover"] and call("GET", f"/api/books/{pdf['id']}/cover")[0] == 200)
for f, title in (("test.txt", None), ("test.docx", "Docx Book"), ("test.html", "Html Book"), ("test.md", None)):
    b = upload(f); check(f"IM-1/2 {f}", b["status"] == "ready" and len(b["chapters"]) >= 2 and (title is None or b["title"] == title), b)
b = upload("scanned.pdf"); check("IM-7 scanned pdf error", b["status"] == "error" and b["error_code"] == "scanned", b)
scanned_id = b["id"]
b = upload("locked.pdf"); check("IM-7 protected pdf error", b["status"] == "error" and b["error_code"] == "drm", b)
call("DELETE", f"/api/books/{b['id']}")
b = upload("corrupt.epub"); check("IM-7 corrupt error", b["status"] == "error" and b["error_code"] == "corrupt", b)
call("DELETE", f"/api/books/{b['id']}")
dup = upload("test.epub"); check("IM-9 duplicate warned", dup["status"] == "duplicate" and dup["duplicate"]["id"] == epub["id"], dup)
call("POST", f"/api/books/{dup['id']}/duplicate", {"action": "discard"})
code, ch2, _ = call("GET", f"/api/books/{epub['id']}/chapters/1"); check("IM-11 hindi text intact", "क्षत्रिय" in ch2["text"])
code, b, _ = call("GET", f"/api/books/{epub['id']}"); 
code, r, _ = call("POST", "/api/books/paste", {"title": "Pasted", "text": "word " * 300}); check("IM-3 paste", code == 200, r)
code, r, _ = call("POST", "/api/books/url", {"url": "http://127.0.0.1:8000/"}); check("IM-3 url blocks private hosts", code == 400, r)

# OCR
call("POST", f"/api/books/{scanned_id}/ocr")
for _ in range(240):
    code, b, _ = call("GET", f"/api/books/{scanned_id}")
    if b["status"] != "processing": break
    time.sleep(1)
check("IM-8 OCR of scanned pdf", b["status"] == "ready" and b["word_count"] > 50, {k: b[k] for k in ("status", "word_count", "error_msg")})

# reading + gamification
sid = uuid.uuid4().hex
wc = epub["chapters"][0]["word_count"]
code, r, _ = call("POST", "/api/reading/beat", {"session_id": sid, "book_id": epub["id"], "chapter_ord": 0, "ranges": [[0, 60]], "active_ms": 5000, "position": {"chapter_ord": 0, "word_index": 60}})
check("beat counts words", code == 200 and r["me"]["today"]["words"] == 60, r)
code, r, _ = call("POST", "/api/reading/beat", {"session_id": sid, "book_id": epub["id"], "chapter_ord": 0, "ranges": [[0, 60]], "active_ms": 5000, "position": {"chapter_ord": 0, "word_index": 60}})
check("§7 re-read within 10 min not counted", r["me"]["today"]["words"] == 60, r["me"]["today"])
code, r, _ = call("POST", "/api/reading/beat", {"session_id": sid, "book_id": epub["id"], "chapter_ord": 1, "ranges": [[0, 1400]], "active_ms": 1000, "position": {"chapter_ord": 0, "word_index": 100}})
check("§7 impossible speed capped", r["me"]["today"]["words"] <= 60 + 25, r["me"]["today"])
pos = 0; ev = []
for i in range(40):
    code, r, _ = call("POST", "/api/reading/beat", {"session_id": sid, "book_id": epub["id"], "chapter_ord": 0, "ranges": [[100 + i * 80, 180 + i * 80]], "active_ms": 5000, "position": {"chapter_ord": 0, "word_index": 180 + i * 80}})
    ev += r["events"]
me = r["me"]
check("GM-2 goal met -> streak 1", me["today"]["met"] and me["current_streak"] == 1, me["today"])
check("GM-8 goal bonus event", any(e["type"] == "goal_met" for e in ev), ev)
check("GM-7 xp from words", me["xp"] >= 10 + me["today"]["words"] // 100 - 1, me["xp"])
code, bk, _ = call("GET", f"/api/books/{epub['id']}"); check("NV-6 position saved", bk["chapter_ord"] == 0 and bk["word_index"] == 180 + 39 * 80 and bk["my_status"] == "reading", bk["word_index"])
check("LB-5 readers listed", any(x["id"] == profile for x in bk["readers"]))
code, r, _ = call("POST", "/api/bookmarks", {"book_id": epub["id"], "chapter_ord": 0, "word_index": 5, "snippet": "quick brown", "note": "nice"}); check("NV-8 bookmark", code == 200)
code, r, _ = call("GET", f"/api/stats/{profile}"); check("ST-1/2 stats", r["totals"]["words"] > 0 and r["totals"]["sessions"] == 1 and len(r["days"]) == 1, r["totals"])
code, r, _ = call("GET", "/api/leaderboard?period=week"); check("GM-11 leaderboard", any(x["id"] == profile and x["xp"] > 0 for x in r["rows"]))
code, r, _ = call("PATCH", "/api/me", {"hidden": True}); code, r, _ = call("GET", "/api/leaderboard?period=week")
check("GM-18 hidden profile excluded", not any(x["id"] == profile for x in r["rows"])); call("PATCH", "/api/me", {"hidden": False})
code, r, _ = call("GET", "/api/badges"); check("GM-16 badges with progress", len(r["badges"]) == 15 and any(0 < b["progress"] < 1 for b in r["badges"]))
code, r, _ = call("GET", "/api/feed"); check("GM-14 feed", any(i["kind"] == "started" for i in r["items"]), r)
code, r, _ = call("GET", "/api/league"); check("GM-12 league", code == 200 and "ends_at" in r)
code, r, _ = call("GET", f"/api/stats/{profile}/year/2026"); check("ST-7 year review", code == 200 and r["totals"]["words"] > 0)

# admin
code, r, _ = call("GET", "/api/admin/overview"); check("AC-8 admin blocked without PIN", code == 403)
code, r, _ = call("DELETE", f"/api/books/{pdf['id']}"); check("AD-1 delete needs admin", code == 403)
code, r, _ = call("POST", "/api/access/admin", {"pin": PIN}); check("AC-8 PIN accepted", code == 200, r)
code, r, _ = call("GET", "/api/admin/overview"); check("AD-5 overview", code == 200 and r["books"] >= 6 and r["files_bytes"] > 0, r)
code, r, _ = call("PATCH", f"/api/books/{pdf['id']}", {"title": "Renamed PDF", "tags": ["Test", "fiction"]}); check("AD-2 edit book", code == 200)
code, r, _ = call("POST", f"/api/admin/books/{pdf['id']}/reprocess"); check("AD-6 reprocess", code == 200)
time.sleep(3); code, b, _ = call("GET", f"/api/books/{pdf['id']}"); check("AD-6 reprocess keeps edits", b["status"] == "ready" and b["title"] == "Renamed PDF", b["title"])
code, r, _ = call("POST", "/api/admin/backups"); check("NF-5 backup runs", code == 200 and r["file"].startswith("read-db-"), r)
code, body, hdr = call("GET", "/api/admin/backup/download"); check("AD-7 full backup download", code == 200 and body[:2] == b"\x1f\x8b" and len(body) > 10000)
code, r, _ = call("PUT", "/api/admin/rules", {"xp": {"goal_bonus": 15}, "badges": {"words_100k": 90000}}); code, r, _ = call("GET", "/api/admin/rules")
check("AD-8 rules editable", r["xp"]["goal_bonus"] == 15 and any(b["id"] == "words_100k" and b["threshold"] == 90000 for b in r["badges"]))
call("PUT", "/api/admin/rules", {"xp": {"goal_bonus": 10}, "badges": {"words_100k": 100000}})
code, r, _ = call("DELETE", f"/api/books/{epub['id']}"); check("AD-1 delete book", code == 200)
code, r, _ = call("GET", f"/api/stats/{profile}"); check("AD-1 history kept as deleted book", any(b["title"] == "Deleted book" for b in r["books"]) and r["totals"]["words"] > 0)
code, r, _ = call("POST", f"/api/admin/profiles/{profile}/reset"); code, me, _ = call("GET", "/api/me"); check("AD-3 reset", me["xp"] == 0 and me["current_streak"] == 0)

# cleanup
code, lst, _ = call("GET", "/api/books")
for b in lst["books"]: call("DELETE", f"/api/books/{b['id']}")
code, r, _ = call("DELETE", f"/api/admin/profiles/{profile}"); check("AD-3 delete profile", code == 200)
print(f"\n{sum(results)}/{len(results)} passed"); sys.exit(0 if all(results) else 1)
