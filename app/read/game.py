"""Streaks, XP, levels, badges, leagues and the activity feed.

Everything time-based is reconciled lazily when a profile is read or written,
so there is no scheduled job whose failure could cost someone a streak.
"""
import math
from datetime import date, datetime, timedelta, time as dtime

from . import config
from .db import q, q1, ex, get_setting, set_setting, Jsonb

TIER_NAMES = ["Bronze", "Silver", "Gold", "Diamond"]
STREAK_MILESTONES = (7, 30, 100, 365)

DEFAULT_BADGES = [
    # id, name, description, icon, kind, threshold
    ("first_book", "First Book", "Finish your first book", "📗", "books", 1),
    ("books_5", "Bookworm", "Finish 5 books", "📚", "books", 5),
    ("books_10", "Shelf Filler", "Finish 10 books", "🏛️", "books", 10),
    ("books_25", "Librarian", "Finish 25 books", "🎓", "books", 25),
    ("streak_7", "One Week", "Reach a 7-day streak", "🔥", "streak", 7),
    ("streak_30", "One Month", "Reach a 30-day streak", "🌋", "streak", 30),
    ("streak_100", "Centurion", "Reach a 100-day streak", "💯", "streak", 100),
    ("streak_365", "Full Orbit", "Reach a 365-day streak", "🌍", "streak", 365),
    ("words_100k", "100k Words", "Read 100,000 words", "✍️", "words", 100_000),
    ("words_1m", "Million Words", "Read 1,000,000 words", "🏆", "words", 1_000_000),
    ("wpm_400", "Brisk", "Hold 400 WPM for a 5-minute session", "🚴", "wpm", 400),
    ("wpm_600", "Swift", "Hold 600 WPM for a 5-minute session", "🚀", "wpm", 600),
    ("wpm_800", "Blazing", "Hold 800 WPM for a 5-minute session", "⚡", "wpm", 800),
    ("night_owl", "Night Owl", "Read for 5 minutes between midnight and 4 am", "🦉", "night_owl", 5),
    ("early_bird", "Early Bird", "Read for 5 minutes between 4 and 7 am", "🐦", "early_bird", 5),
]


def now_ist() -> datetime:
    return datetime.now(config.IST)


def today() -> date:
    return now_ist().date()


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def day_start_utc(d: date) -> datetime:
    return datetime.combine(d, dtime.min, tzinfo=config.IST)


def level_for(xp: int) -> int:
    # Level n needs 100 * (n-1)^2 total XP, so everyone starts at level 1.
    return int(math.isqrt(max(0, xp) // 100)) + 1


def level_info(xp: int) -> dict:
    lvl = level_for(xp)
    floor, ceil = 100 * (lvl - 1) ** 2, 100 * lvl ** 2
    return {"level": lvl, "level_floor": floor, "level_next": ceil,
            "level_progress": (xp - floor) / (ceil - floor)}


def xp_rules(c) -> dict:
    return {**config.DEFAULT_XP_RULES, **(get_setting(c, "xp_rules") or {})}


def seed_badges(c) -> None:
    for i, (bid, name, desc, icon, kind, thr) in enumerate(DEFAULT_BADGES):
        ex(c, "INSERT INTO badges (id, name, description, icon, kind, threshold, sort) "
              "VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING",
           bid, name, desc, icon, kind, thr, i)


def feed(c, profile_id: int, kind: str, **data) -> None:
    ex(c, "INSERT INTO activity (profile_id, kind, data) VALUES (%s, %s, %s)",
       profile_id, kind, Jsonb(data))


# ---------------------------------------------------------------- streaks

def reconcile(c, p: dict) -> dict:
    """Settle every fully elapsed day since the profile was last looked at:
    a missed day burns a freeze if one is held, otherwise the streak resets."""
    t = today()
    last = p["last_reconciled"]
    if last >= t - timedelta(days=1):
        return p
    streak, freezes = p["current_streak"], p["freezes"]
    if (t - last).days > 400:
        streak = 0
    else:
        met = {r["day"] for r in q(c, "SELECT day FROM daily_activity WHERE profile_id=%s "
                                      "AND day > %s AND day < %s AND goal_met", p["id"], last, t)}
        d = last + timedelta(days=1)
        while d < t:
            if d not in met and streak > 0:
                if freezes > 0:
                    freezes -= 1
                    ex(c, "INSERT INTO daily_activity (profile_id, day, freeze_used) VALUES (%s,%s,true) "
                          "ON CONFLICT (profile_id, day) DO UPDATE SET freeze_used = true", p["id"], d)
                else:
                    streak = 0
            d += timedelta(days=1)
    ex(c, "UPDATE profiles SET current_streak=%s, freezes=%s, last_reconciled=%s WHERE id=%s",
       streak, freezes, t - timedelta(days=1), p["id"])
    p.update(current_streak=streak, freezes=freezes, last_reconciled=t - timedelta(days=1))
    return p


def load_profile(c, profile_id: int, lock: bool = False) -> dict | None:
    p = q1(c, "SELECT * FROM profiles WHERE id=%s" + (" FOR UPDATE" if lock else ""), profile_id)
    return reconcile(c, p) if p else None


def goal_target(p: dict) -> tuple[str, int]:
    return p["goal_type"], max(1, p["goal_value"])


def goal_progress(p: dict, day_row: dict | None) -> dict:
    kind, target = goal_target(p)
    words = day_row["words"] if day_row else 0
    seconds = day_row["seconds"] if day_row else 0
    done = words if kind == "words" else seconds / 60
    return {"type": kind, "target": target, "done": round(done, 1),
            "fraction": min(1.0, done / target), "met": bool(day_row and day_row["goal_met"]),
            "words": words, "seconds": round(seconds)}


# ---------------------------------------------------------------- xp

def streak_multiplier(rules: dict, streak: int) -> float:
    if streak >= 30:
        return float(rules["streak30_multiplier"])
    if streak >= 7:
        return float(rules["streak7_multiplier"])
    return 1.0


def award_xp(c, p: dict, amount: int, reason: str, book_id: int | None, events: list) -> None:
    if amount <= 0:
        return
    before = level_for(p["xp"])
    p["xp"] += amount
    ex(c, "UPDATE profiles SET xp = xp + %s WHERE id=%s", amount, p["id"])
    ex(c, "INSERT INTO xp_events (profile_id, amount, reason, book_id) VALUES (%s,%s,%s,%s)",
       p["id"], amount, reason, book_id)
    ex(c, "INSERT INTO daily_activity (profile_id, day, xp) VALUES (%s,%s,%s) "
          "ON CONFLICT (profile_id, day) DO UPDATE SET xp = daily_activity.xp + EXCLUDED.xp",
       p["id"], today(), amount)
    after = level_for(p["xp"])
    if after > before:
        events.append({"type": "level_up", "level": after})
        feed(c, p["id"], "level", level=after)


def count_new_words(c, profile_id: int, chapter_id: int, ranges: list[list[int]], limit: int) -> int:
    """Words in `ranges` not already shown to this profile in the last 10 minutes."""
    recent = q(c, "SELECT start_w, end_w FROM read_ranges WHERE profile_id=%s AND chapter_id=%s "
                  "AND seen_at > now() - interval '10 minutes'", profile_id, chapter_id)
    seen = sorted((r["start_w"], r["end_w"]) for r in recent)
    total = 0
    for s, e in ranges:
        s, e = max(0, int(s)), min(limit, int(e))
        if e <= s:
            continue
        pos = s
        for a, b in seen:
            if b <= pos:
                continue
            if a >= e:
                break
            if a > pos:
                total += a - pos
            pos = max(pos, b)
            if pos >= e:
                break
        if pos < e:
            total += e - pos
        ex(c, "INSERT INTO read_ranges (profile_id, chapter_id, start_w, end_w) VALUES (%s,%s,%s,%s)",
           profile_id, chapter_id, s, e)
        seen.append((s, e))
        seen.sort()
    return total


def record_reading(c, p: dict, book: dict, chapter: dict, words: int, seconds: float,
                   session_id: str, events: list) -> None:
    """Apply counted words and active time to the day, the session, XP and the goal."""
    rules = xp_rules(c)
    day = today()
    ex(c, "INSERT INTO daily_activity (profile_id, day, words, seconds) VALUES (%s,%s,%s,%s) "
          "ON CONFLICT (profile_id, day) DO UPDATE SET words = daily_activity.words + EXCLUDED.words, "
          "seconds = daily_activity.seconds + EXCLUDED.seconds", p["id"], day, words, seconds)
    ex(c, "INSERT INTO hour_activity (profile_id, hour, seconds) VALUES (%s,%s,%s) "
          "ON CONFLICT (profile_id, hour) DO UPDATE SET seconds = hour_activity.seconds + EXCLUDED.seconds",
       p["id"], now_ist().hour, seconds)
    ex(c, "INSERT INTO reading_sessions (id, profile_id, book_id, words, active_seconds) "
          "VALUES (%s,%s,%s,%s,%s) ON CONFLICT (id) DO UPDATE SET ended_at = now(), "
          "words = reading_sessions.words + EXCLUDED.words, "
          "active_seconds = reading_sessions.active_seconds + EXCLUDED.active_seconds",
       session_id, p["id"], book["id"], words, seconds)
    ex(c, "UPDATE reading_sessions SET avg_wpm = CASE WHEN active_seconds > 0 "
          "THEN round(words / active_seconds * 60) ELSE 0 END WHERE id=%s", session_id)

    if words:
        earned = p["xp_frac"] + words / rules["words_per_xp"] * streak_multiplier(rules, p["current_streak"])
        whole = int(earned)
        p["xp_frac"] = earned - whole
        ex(c, "UPDATE profiles SET xp_frac=%s WHERE id=%s", p["xp_frac"], p["id"])
        award_xp(c, p, whole, "reading", book["id"], events)
        ex(c, "INSERT INTO chapter_reads (profile_id, chapter_id, words_counted) VALUES (%s,%s,%s) "
              "ON CONFLICT (profile_id, chapter_id) DO UPDATE SET "
              "words_counted = chapter_reads.words_counted + EXCLUDED.words_counted",
           p["id"], chapter["id"], words)
        ex(c, "UPDATE reading_progress SET words_counted = words_counted + %s "
              "WHERE profile_id=%s AND book_id=%s", words, p["id"], book["id"])

    row = q1(c, "SELECT * FROM daily_activity WHERE profile_id=%s AND day=%s", p["id"], day)
    kind, target = goal_target(p)
    done = row["words"] if kind == "words" else row["seconds"] / 60
    if not row["goal_met"] and done >= target:
        ex(c, "UPDATE daily_activity SET goal_met=true WHERE profile_id=%s AND day=%s", p["id"], day)
        p["current_streak"] += 1
        p["best_streak"] = max(p["best_streak"], p["current_streak"])
        if p["current_streak"] % 7 == 0 and p["freezes"] < 2:
            p["freezes"] += 1
            events.append({"type": "freeze_earned", "freezes": p["freezes"]})
        ex(c, "UPDATE profiles SET current_streak=%s, best_streak=%s, freezes=%s WHERE id=%s",
           p["current_streak"], p["best_streak"], p["freezes"], p["id"])
        events.append({"type": "goal_met", "streak": p["current_streak"]})
        award_xp(c, p, int(rules["goal_bonus"]), "daily_goal", None, events)
        if p["current_streak"] in STREAK_MILESTONES:
            feed(c, p["id"], "streak", days=p["current_streak"])


def chapter_finished(c, p: dict, book: dict, chapter: dict, events: list) -> None:
    """+50 once per chapter, only if most of it was really shown (skipping earns nothing)."""
    row = q1(c, "SELECT * FROM chapter_reads WHERE profile_id=%s AND chapter_id=%s", p["id"], chapter["id"])
    if not row or row["completed_at"] or row["words_counted"] < 0.9 * chapter["word_count"]:
        return
    ex(c, "UPDATE chapter_reads SET completed_at=now() WHERE profile_id=%s AND chapter_id=%s",
       p["id"], chapter["id"])
    events.append({"type": "chapter_done", "title": chapter["title"]})
    award_xp(c, p, int(xp_rules(c)["chapter_bonus"]), "chapter", book["id"], events)


def book_finished(c, p: dict, book: dict, events: list) -> None:
    row = q1(c, "SELECT * FROM reading_progress WHERE profile_id=%s AND book_id=%s", p["id"], book["id"])
    if not row:
        return
    if row["status"] != "finished":
        ex(c, "UPDATE reading_progress SET status='finished', finished_at=now() "
              "WHERE profile_id=%s AND book_id=%s", p["id"], book["id"])
    if not row["finish_bonus"] and row["words_counted"] >= 0.8 * book["word_count"]:
        ex(c, "UPDATE reading_progress SET finish_bonus=true WHERE profile_id=%s AND book_id=%s",
           p["id"], book["id"])
        events.append({"type": "book_done", "title": book["title"]})
        award_xp(c, p, int(xp_rules(c)["book_bonus"]), "book", book["id"], events)
        feed(c, p["id"], "finished", book_id=book["id"], title=book["title"])


# ---------------------------------------------------------------- badges

def badge_values(c, p: dict) -> dict:
    """Current value per badge kind, used for both awarding and progress bars."""
    words = q1(c, "SELECT coalesce(sum(words),0) AS n FROM daily_activity WHERE profile_id=%s", p["id"])["n"]
    books = q1(c, "SELECT count(*) AS n FROM reading_progress WHERE profile_id=%s AND finish_bonus", p["id"])["n"]
    wpm = q1(c, "SELECT coalesce(max(avg_wpm),0) AS n FROM reading_sessions "
                "WHERE profile_id=%s AND active_seconds >= 300", p["id"])["n"]
    hours = {r["hour"]: r["seconds"] for r in q(c, "SELECT hour, seconds FROM hour_activity WHERE profile_id=%s", p["id"])}
    night = sum(hours.get(h, 0) for h in (0, 1, 2, 3)) / 60
    early = sum(hours.get(h, 0) for h in (4, 5, 6)) / 60
    return {"books": books, "streak": p["best_streak"], "words": words, "wpm": wpm,
            "night_owl": night, "early_bird": early}


def check_badges(c, p: dict, events: list) -> None:
    values = badge_values(c, p)
    owned = {r["badge_id"] for r in q(c, "SELECT badge_id FROM profile_badges WHERE profile_id=%s", p["id"])}
    for b in q(c, "SELECT * FROM badges ORDER BY sort"):
        if b["id"] in owned or values.get(b["kind"], 0) < b["threshold"]:
            continue
        ex(c, "INSERT INTO profile_badges (profile_id, badge_id) VALUES (%s,%s) ON CONFLICT DO NOTHING",
           p["id"], b["id"])
        events.append({"type": "badge", "id": b["id"], "name": b["name"], "icon": b["icon"],
                       "description": b["description"]})
        feed(c, p["id"], "badge", badge=b["name"], icon=b["icon"])


# ---------------------------------------------------------------- leagues

def xp_between(c, start: datetime, end: datetime | None = None) -> list[dict]:
    return q(c, """
        SELECT p.id, p.name, p.avatar, p.color, p.xp AS total_xp, p.current_streak, p.tier,
               coalesce(sum(e.amount), 0)::int AS xp
        FROM profiles p
        LEFT JOIN xp_events e ON e.profile_id = p.id AND e.at >= %s AND (%s::timestamptz IS NULL OR e.at < %s)
        WHERE NOT p.hidden
        GROUP BY p.id ORDER BY xp DESC, p.name""", start, end, end)


def finalize_leagues(c) -> None:
    """Close every finished week: save ranks and trophies, move tiers (GM-12, GM-13)."""
    current = week_start(today())
    raw = get_setting(c, "league_through")
    if raw is None:
        set_setting(c, "league_through", (current - timedelta(days=7)).isoformat())
        return
    week = date.fromisoformat(raw) + timedelta(days=7)
    while week < current:
        rows = xp_between(c, day_start_utc(week), day_start_utc(week + timedelta(days=7)))
        ranked = [r for r in rows if r["xp"] > 0]
        for i, r in enumerate(ranked):
            rank = i + 1
            trophy = ("gold", "silver", "bronze")[i] if i < 3 else None
            tier = r["tier"]
            if rank <= 3:
                tier = min(len(TIER_NAMES) - 1, tier + 1)
            elif rank > max(3, len(ranked) - 3):
                tier = max(0, tier - 1)
            ex(c, "INSERT INTO league_weeks (week_start, profile_id, xp, rank, tier, trophy) "
                  "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING", week, r["id"], r["xp"], rank, tier, trophy)
            ex(c, "UPDATE profiles SET tier=%s WHERE id=%s", tier, r["id"])
            if trophy:
                feed(c, r["id"], "trophy", trophy=trophy, week=week.isoformat())
        idle = [r["id"] for r in rows if r["xp"] == 0]
        if idle and ranked:
            ex(c, "UPDATE profiles SET tier = greatest(0, tier - 1) WHERE id = ANY(%s)", idle)
        set_setting(c, "league_through", week.isoformat())
        week += timedelta(days=7)
