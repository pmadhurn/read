"""Time-dependent rules, run inside the app container against the live DB with throwaway profiles."""
from datetime import timedelta
from read import game, push
from read.db import tx, q1, ex, set_setting, get_setting
from read.importer.simple import _mobi_encrypted, fetch_article
ok = []
def check(n, c, info=""): ok.append(c); print("PASS" if c else "FAIL", n, "" if c else info)
T = game.today()
with tx() as c:
    ids = [q1(c, "INSERT INTO profiles (name, last_reconciled, current_streak, best_streak, freezes) VALUES (%s,%s,%s,%s,%s) RETURNING id",
              f"zz-logic-{i}", T - timedelta(days=4), s, s, f)["id"] for i, (s, f) in enumerate([(6, 1), (6, 0), (13, 2)])]
    # profile 0: missed 3 days, 1 freeze -> freeze burns on day 1, streak resets on day 2
    p = game.load_profile(c, ids[0]); check("GM-4 one freeze then reset", p["current_streak"] == 0 and p["freezes"] == 0, p)
    fr = q1(c, "SELECT count(*) n FROM daily_activity WHERE profile_id=%s AND freeze_used", ids[0])["n"]; check("GM-4 freeze day recorded", fr == 1, fr)
    # profile 2: goal met two of three days, one miss -> one freeze used, streak kept
    for d in (3, 1): ex(c, "INSERT INTO daily_activity (profile_id, day, goal_met) VALUES (%s,%s,true)", ids[2], T - timedelta(days=d))
    p = game.load_profile(c, ids[2]); check("GM-4 freeze preserves streak", p["current_streak"] == 13 and p["freezes"] == 1, p)
    # goal met today -> 14 -> freeze earned (max 2)
    ev = []; book = {"id": 0, "title": "x", "word_count": 10}; ch = {"id": None}
    ex(c, "UPDATE profiles SET goal_type='words', goal_value=50 WHERE id=%s", ids[2]); p = game.load_profile(c, ids[2], lock=True)
    ex(c, "INSERT INTO daily_activity (profile_id, day, words) VALUES (%s,%s,60)", ids[2], T)
    game.record_reading(c, p, book, ch, 0, 1.0, "zz-logic-session", ev)
    check("GM-2/4 streak 14 earns a freeze", p["current_streak"] == 14 and p["freezes"] == 2 and any(e["type"] == "freeze_earned" for e in ev), (p["current_streak"], p["freezes"], ev))
    check("GM-9 multiplier", game.streak_multiplier(game.xp_rules(c), 7) == 1.1 and game.streak_multiplier(game.xp_rules(c), 30) == 1.25 and game.streak_multiplier(game.xp_rules(c), 6) == 1.0)
    check("GM-10 levels", [game.level_for(x) for x in (0, 99, 100, 399, 400, 900)] == [1, 1, 2, 2, 3, 4])
    check("GM-3 IST day", game.day_start_utc(T).utcoffset() == timedelta(hours=5, minutes=30))
    # league: last week's XP -> trophies + tier moves
    saved = get_setting(c, "league_through"); last = game.week_start(T) - timedelta(days=7)
    for pid, xp in zip(ids, (300, 200, 100)):
        ex(c, "INSERT INTO xp_events (profile_id, at, amount, reason) VALUES (%s,%s,%s,'test')", pid, game.day_start_utc(last) + timedelta(hours=30), xp)
    set_setting(c, "league_through", (last - timedelta(days=7)).isoformat()); game.finalize_leagues(c)
    rows = {r["profile_id"]: r for r in c.execute("SELECT * FROM league_weeks WHERE week_start=%s", (last,)).fetchall()}
    check("GM-12 trophies for top 3", [rows[i]["trophy"] for i in ids] == ["gold", "silver", "bronze"], rows)
    check("GM-13 top finishers move up a tier", all(rows[i]["tier"] == 1 for i in ids))
    check("GM-12 week closed once", get_setting(c, "league_through") == last.isoformat())
    ex(c, "DELETE FROM reading_sessions WHERE id='zz-logic-session'"); ex(c, "DELETE FROM profiles WHERE id = ANY(%s)", ids)
    if saved: set_setting(c, "league_through", saved)
check("GM-6 VAPID key generated", len(push.public_key()) > 80)
import struct, tempfile
hdr = bytearray(86); hdr[60:68] = b"BOOKMOBI"; hdr[78:82] = struct.pack(">I", 86)
f = tempfile.NamedTemporaryFile(delete=False); f.write(bytes(hdr) + b"\0" * 12 + struct.pack(">H", 2) + b"\0" * 20); f.close()
check("IM-7 MOBI DRM flag detected", _mobi_encrypted(f.name) is True)
import mobi; check("IM-2 mobi unpacker importable", hasattr(mobi, "extract"))
try:
    a = fetch_article("https://en.wikipedia.org/wiki/Rapid_serial_visual_presentation")
    check("IM-3 real article import", sum(len(p.split()) for s in a.sections for p in s.paragraphs) > 200 and bool(a.title), a.title)
except Exception as e: check("IM-3 real article import", False, repr(e))
print(f"\n{sum(ok)}/{len(ok)} passed")
