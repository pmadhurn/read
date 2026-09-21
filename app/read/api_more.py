"""Stats, leaderboard, leagues, feed, badges, push and admin endpoints."""
import shutil
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from . import backup, config, game, importer, push, security
from .db import tx, q, q1, ex, get_setting, set_setting
from .security import current_profile, require_admin

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------- stats

def _totals(c, pid: int, start: date | None = None, end: date | None = None) -> dict:
    day_filter = " AND day >= %s AND day < %s" if start else ""
    args = (pid, start, end) if start else (pid,)
    t = q1(c, "SELECT coalesce(sum(words),0)::int AS words, coalesce(sum(seconds),0)::float AS seconds, "
              "count(*) FILTER (WHERE words > 0 OR seconds > 0)::int AS days, "
              "count(*) FILTER (WHERE goal_met)::int AS goal_days "
              f"FROM daily_activity WHERE profile_id=%s{day_filter}", *args)
    ts_filter = " AND finished_at >= %s AND finished_at < %s" if start else ""
    ts_args = (pid, game.day_start_utc(start), game.day_start_utc(end)) if start else (pid,)
    t["books_finished"] = q1(c, "SELECT count(*)::int AS n FROM reading_progress WHERE profile_id=%s "
                                f"AND status='finished'{ts_filter}", *ts_args)["n"]
    s_filter = " AND started_at >= %s AND started_at < %s" if start else ""
    t["top_wpm"] = q1(c, "SELECT coalesce(max(avg_wpm),0)::int AS n FROM reading_sessions WHERE profile_id=%s "
                         f"AND active_seconds >= 300{s_filter}", *ts_args)["n"]
    t["sessions"] = q1(c, f"SELECT count(*)::int AS n FROM reading_sessions WHERE profile_id=%s{s_filter}", *ts_args)["n"]
    t["avg_wpm"] = round(t["words"] / t["seconds"] * 60) if t["seconds"] > 30 else 0
    return t


def _per_book(c, pid: int, start: datetime | None = None, end: datetime | None = None) -> list[dict]:
    s_filter = " AND s.started_at >= %s AND s.started_at < %s" if start else ""
    args = (pid, pid, start, end) if start else (pid, pid)
    rows = q(c, f"""
        SELECT s.book_id, b.title, b.author, (b.deleted_at IS NOT NULL OR b.id IS NULL) AS deleted,
               b.has_cover, sum(s.words)::int AS words, sum(s.active_seconds)::float AS seconds,
               count(*)::int AS sessions, min(s.started_at) AS first_read,
               max(rp.finished_at) AS finished_at, max(rp.status) AS status
        FROM reading_sessions s
        LEFT JOIN books b ON b.id = s.book_id
        LEFT JOIN reading_progress rp ON rp.book_id = s.book_id AND rp.profile_id = %s
        WHERE s.profile_id = %s{s_filter}
        GROUP BY s.book_id, b.id ORDER BY max(s.ended_at) DESC""", *args)
    for r in rows:
        if r["deleted"]:
            r["title"] = "Deleted book"      # history outlives the book (AD-1)
        r["avg_wpm"] = round(r["words"] / r["seconds"] * 60) if r["seconds"] > 30 else 0
        r["first_read"] = r["first_read"].isoformat()
        r["finished_at"] = r["finished_at"].isoformat() if r["finished_at"] else None
    return rows


@router.get("/stats/{pid}")
def stats(pid: int, _: dict = Depends(current_profile)):
    with tx() as c:
        prof = game.load_profile(c, pid)
        if not prof:
            raise HTTPException(404, "Profile not found")
        today = game.today()
        days = q(c, "SELECT day, words, seconds, goal_met, freeze_used FROM daily_activity "
                    "WHERE profile_id=%s AND day > %s ORDER BY day", pid, today - timedelta(days=371))
        hours = {r["hour"]: r["seconds"] for r in q(c, "SELECT hour, seconds FROM hour_activity WHERE profile_id=%s", pid)}
        recent = q(c, "SELECT s.started_at, s.words, s.active_seconds, s.avg_wpm, "
                      "CASE WHEN b.id IS NULL OR b.deleted_at IS NOT NULL THEN 'Deleted book' ELSE b.title END AS title "
                      "FROM reading_sessions s LEFT JOIN books b ON b.id=s.book_id "
                      "WHERE s.profile_id=%s ORDER BY s.started_at DESC LIMIT 15", pid)
        trophies = q(c, "SELECT week_start, trophy, xp FROM league_weeks WHERE profile_id=%s AND trophy IS NOT NULL "
                        "ORDER BY week_start DESC", pid)
        return {
            "profile": {"id": prof["id"], "name": prof["name"], "avatar": prof["avatar"], "color": prof["color"],
                        "xp": prof["xp"], "current_streak": prof["current_streak"],
                        "best_streak": prof["best_streak"], "tier": game.TIER_NAMES[prof["tier"]],
                        **game.level_info(prof["xp"])},
            "totals": _totals(c, pid),
            "today": today.isoformat(),
            "days": [{"day": r["day"].isoformat(), "words": r["words"], "seconds": round(r["seconds"]),
                      "wpm": round(r["words"] / r["seconds"] * 60) if r["seconds"] > 30 else 0,
                      "met": r["goal_met"], "freeze": r["freeze_used"]} for r in days],
            "hours": [round(hours.get(h, 0) / 60, 1) for h in range(24)],
            "books": _per_book(c, pid),
            "sessions": [{**r, "started_at": r["started_at"].isoformat(),
                          "active_seconds": round(r["active_seconds"])} for r in recent],
            "trophies": [{**r, "week_start": r["week_start"].isoformat()} for r in trophies],
        }


@router.get("/stats/{pid}/year/{year}")
def year_review(pid: int, year: int, _: dict = Depends(current_profile)):
    start, end = date(year, 1, 1), date(year + 1, 1, 1)
    with tx() as c:
        prof = game.load_profile(c, pid)
        if not prof:
            raise HTTPException(404, "Profile not found")
        totals = _totals(c, pid, start, end)
        books = _per_book(c, pid, game.day_start_utc(start), game.day_start_utc(end))
        best_day = q1(c, "SELECT day, words FROM daily_activity WHERE profile_id=%s AND day >= %s AND day < %s "
                         "ORDER BY words DESC LIMIT 1", pid, start, end)
        months = q(c, "SELECT extract(month FROM day)::int AS month, sum(words)::int AS words FROM daily_activity "
                      "WHERE profile_id=%s AND day >= %s AND day < %s GROUP BY 1 ORDER BY 1", pid, start, end)
        hour = q1(c, "SELECT hour FROM hour_activity WHERE profile_id=%s ORDER BY seconds DESC LIMIT 1", pid)
        badges = q(c, "SELECT b.name, b.icon FROM profile_badges pb JOIN badges b ON b.id=pb.badge_id "
                      "WHERE pb.profile_id=%s AND pb.earned_at >= %s AND pb.earned_at < %s ORDER BY pb.earned_at",
                   pid, game.day_start_utc(start), game.day_start_utc(end))
        xp = q1(c, "SELECT coalesce(sum(amount),0)::int AS n FROM xp_events WHERE profile_id=%s AND at >= %s AND at < %s",
                pid, game.day_start_utc(start), game.day_start_utc(end))["n"]
        # Longest run of goal days inside the year.
        met = [r["day"] for r in q(c, "SELECT day FROM daily_activity WHERE profile_id=%s AND day >= %s AND day < %s "
                                      "AND (goal_met OR freeze_used) ORDER BY day", pid, start, end)]
    longest = run = 0
    for i, d in enumerate(met):
        run = run + 1 if i and (d - met[i - 1]).days == 1 else 1
        longest = max(longest, run)
    by_month = {m["month"]: m["words"] for m in months}
    return {"year": year, "name": prof["name"], "avatar": prof["avatar"], "totals": totals, "xp": xp,
            "books": books, "badges": badges, "longest_streak": longest, "favourite_hour": hour["hour"] if hour else None,
            "best_day": {"day": best_day["day"].isoformat(), "words": best_day["words"]} if best_day and best_day["words"] else None,
            "months": [by_month.get(m, 0) for m in range(1, 13)]}


# ---------------------------------------------------------------- leaderboard, league, feed, badges

@router.get("/leaderboard")
def leaderboard(period: str = "week", _: dict = Depends(current_profile)):
    today = game.today()
    start = {"week": game.week_start(today), "month": today.replace(day=1)}.get(period)
    with tx() as c:
        for p in q(c, "SELECT * FROM profiles"):
            game.reconcile(c, p)
        game.finalize_leagues(c)
        rows = game.xp_between(c, game.day_start_utc(start) if start else datetime(2000, 1, 1, tzinfo=config.IST))
    return {"period": period, "rows": [
        {"id": r["id"], "name": r["name"], "avatar": r["avatar"], "color": r["color"], "xp": r["xp"],
         "streak": r["current_streak"], "level": game.level_for(r["total_xp"]), "tier": game.TIER_NAMES[r["tier"]]}
        for r in rows]}


@router.get("/league")
def league(_: dict = Depends(current_profile)):
    today = game.today()
    start = game.week_start(today)
    with tx() as c:
        game.finalize_leagues(c)
        rows = game.xp_between(c, game.day_start_utc(start))
        history = q(c, "SELECT lw.week_start, lw.rank, lw.xp, lw.trophy, p.id, p.name, p.avatar FROM league_weeks lw "
                       "JOIN profiles p ON p.id=lw.profile_id WHERE lw.trophy IS NOT NULL AND NOT p.hidden "
                       "ORDER BY lw.week_start DESC, lw.rank LIMIT 30")
    ends = game.day_start_utc(start + timedelta(days=7))
    return {"week_start": start.isoformat(), "ends_at": ends.isoformat(), "tiers": game.TIER_NAMES,
            "rows": [{"id": r["id"], "name": r["name"], "avatar": r["avatar"], "color": r["color"], "xp": r["xp"],
                      "tier": game.TIER_NAMES[r["tier"]]} for r in rows],
            "history": [{**h, "week_start": h["week_start"].isoformat()} for h in history]}


@router.get("/feed")
def activity_feed(_: dict = Depends(current_profile)):
    with tx() as c:
        rows = q(c, "SELECT a.id, a.at, a.kind, a.data, p.id AS profile_id, p.name, p.avatar, p.color FROM activity a "
                    "JOIN profiles p ON p.id=a.profile_id WHERE NOT p.hidden ORDER BY a.at DESC LIMIT 40")
    return {"items": [{**r, "at": r["at"].isoformat()} for r in rows]}


@router.get("/badges")
def badges(p: dict = Depends(current_profile), profile_id: int | None = None):
    with tx() as c:
        prof = game.load_profile(c, profile_id or p["id"])
        if not prof:
            raise HTTPException(404, "Profile not found")
        values = game.badge_values(c, prof)
        earned = {r["badge_id"]: r["earned_at"] for r in
                  q(c, "SELECT badge_id, earned_at FROM profile_badges WHERE profile_id=%s", prof["id"])}
        rows = q(c, "SELECT * FROM badges ORDER BY sort")
    return {"badges": [{
        "id": b["id"], "name": b["name"], "description": b["description"], "icon": b["icon"],
        "earned_at": earned[b["id"]].isoformat() if b["id"] in earned else None,
        "value": round(values.get(b["kind"], 0), 1), "threshold": b["threshold"],
        "progress": 1.0 if b["id"] in earned else min(1.0, values.get(b["kind"], 0) / b["threshold"]) if b["threshold"] else 0,
    } for b in rows]}


# ---------------------------------------------------------------- push reminders

@router.get("/push/key")
def push_key():
    return {"key": push.public_key()}


@router.post("/push/subscribe")
def push_subscribe(body: dict = Body(...), p: dict = Depends(current_profile)):
    sub = body.get("subscription") or {}
    if not sub.get("endpoint") or not str(sub["endpoint"]).startswith("https://"):
        raise HTTPException(400, "Bad subscription")
    push.save(p["id"], sub)
    return {"ok": True}


@router.post("/push/unsubscribe")
def push_unsubscribe(body: dict = Body(...), p: dict = Depends(current_profile)):
    with tx() as c:
        ex(c, "DELETE FROM push_subs WHERE endpoint=%s", str(body.get("endpoint", "")))
    return {"ok": True}


@router.get("/push/status")
def push_status(p: dict = Depends(current_profile)):
    with tx() as c:
        n = q1(c, "SELECT count(*)::int AS n FROM push_subs WHERE profile_id=%s", p["id"])["n"]
    return {"subscriptions": n}


# ---------------------------------------------------------------- admin

admin = APIRouter(prefix="/api/admin", dependencies=[Depends(require_admin)])


@admin.get("/overview")
def overview():
    with tx() as c:
        books = q1(c, "SELECT count(*)::int AS n, coalesce(sum(file_size),0)::bigint AS bytes, "
                      "coalesce(sum(word_count),0)::bigint AS words FROM books WHERE deleted_at IS NULL")
        profiles = [game.reconcile(c, p) for p in q(c, "SELECT * FROM profiles ORDER BY created_at")]
        db_bytes = q1(c, "SELECT pg_database_size(current_database())::bigint AS n")["n"]
    disk = sum(f.stat().st_size for f in config.BOOKS_DIR.rglob("*") if f.is_file()) if config.BOOKS_DIR.exists() else 0
    free = shutil.disk_usage(config.DATA_DIR).free
    return {"books": books["n"], "book_words": books["words"], "files_bytes": disk, "db_bytes": db_bytes,
            "plan_bytes": config.STORAGE_PLAN_BYTES, "disk_free_bytes": free, "max_profiles": config.MAX_PROFILES,
            "profiles": [{"id": p["id"], "name": p["name"], "avatar": p["avatar"], "xp": p["xp"],
                          "streak": p["current_streak"], "hidden": p["hidden"]} for p in profiles],
            "backups": backup.list_backups()}


@admin.patch("/profiles/{pid}")
def rename_profile(pid: int, body: dict = Body(...)):
    name = " ".join(str(body.get("name", "")).split())[:30]
    if not name:
        raise HTTPException(400, "Enter a name.")
    with tx() as c:
        if q1(c, "SELECT 1 FROM profiles WHERE lower(name)=lower(%s) AND id<>%s", name, pid):
            raise HTTPException(409, "That name is already used.")
        if not ex(c, "UPDATE profiles SET name=%s WHERE id=%s", name, pid):
            raise HTTPException(404)
    return {"ok": True}


@admin.post("/profiles/{pid}/reset")
def reset_profile(pid: int):
    with tx() as c:
        for table in ("reading_progress", "chapter_reads", "read_ranges", "reading_sessions", "daily_activity",
                      "hour_activity", "xp_events", "bookmarks", "profile_badges", "league_weeks", "activity", "favourites"):
            ex(c, f"DELETE FROM {table} WHERE profile_id=%s", pid)
        ex(c, "UPDATE profiles SET xp=0, xp_frac=0, current_streak=0, best_streak=0, freezes=0, tier=0, "
              "last_reconciled=%s WHERE id=%s", game.today() - timedelta(days=1), pid)
    return {"ok": True}


@admin.delete("/profiles/{pid}")
def delete_profile(pid: int):
    with tx() as c:
        if not ex(c, "DELETE FROM profiles WHERE id=%s", pid):
            raise HTTPException(404)
    return {"ok": True}


@admin.post("/secrets")
def change_secrets(body: dict = Body(...)):
    passcode, pin = str(body.get("passcode") or "").strip(), str(body.get("pin") or "").strip()
    if passcode and len(passcode) < 6:
        raise HTTPException(400, "Use a passcode of at least 6 characters.")
    if pin and (not pin.isdigit() or not 4 <= len(pin) <= 12):
        raise HTTPException(400, "The PIN must be 4 to 12 digits.")
    with tx() as c:
        if passcode:
            set_setting(c, "passcode_hash", security.hash_secret(passcode))
        if pin:
            set_setting(c, "pin_hash", security.hash_secret(pin))
    if passcode or pin:
        # New generation: every remembered device must enter the new passcode (AC-9).
        security.bump_generation()
    return {"ok": True, "signed_out": bool(passcode or pin)}


@admin.get("/rules")
def get_rules():
    with tx() as c:
        return {"xp": game.xp_rules(c), "defaults": config.DEFAULT_XP_RULES,
                "badges": q(c, "SELECT id, name, icon, kind, threshold FROM badges ORDER BY sort")}


@admin.put("/rules")
def put_rules(body: dict = Body(...)):
    with tx() as c:
        rules = game.xp_rules(c)
        for key, value in (body.get("xp") or {}).items():
            if key in config.DEFAULT_XP_RULES:
                value = float(value)
                if value <= 0 or value > 100_000:
                    raise HTTPException(400, f"Bad value for {key}")
                rules[key] = value if "multiplier" in key else int(value)
        set_setting(c, "xp_rules", rules)
        for bid, threshold in (body.get("badges") or {}).items():
            if float(threshold) <= 0:
                raise HTTPException(400, "Badge thresholds must be positive")
            ex(c, "UPDATE badges SET threshold=%s WHERE id=%s", float(threshold), bid)
    return {"ok": True}


@admin.post("/books/{book_id}/reprocess")
def reprocess(book_id: int):
    with tx() as c:
        book = q1(c, "SELECT * FROM books WHERE id=%s AND deleted_at IS NULL", book_id)
        if not book or not book["file_path"]:
            raise HTTPException(404, "Book not found")
        ex(c, "UPDATE books SET status='processing', stage='queued', progress=0 WHERE id=%s", book_id)
    importer.submit(book_id)
    return {"ok": True}


@admin.post("/backups")
def run_backup():
    return {"file": backup.run_daily()}


@admin.get("/backup/download")
def download_backup():
    name = f"read-backup-{game.today().isoformat()}.tar.gz"
    return StreamingResponse(backup.stream_full_archive(), media_type="application/gzip",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})
