"""Opt-in evening reminder when the day's goal is still open (GM-6)."""
import base64
import json
import threading
import time

from . import config, game
from .db import tx, q, q1, ex, get_setting, set_setting, Jsonb

REMINDER_HOUR = 20


def _keys() -> dict:
    with tx() as c:
        keys = get_setting(c, "vapid")
        if keys:
            return keys
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        private = ec.generate_private_key(ec.SECP256R1())
        raw_private = private.private_numbers().private_value.to_bytes(32, "big")
        raw_public = private.public_key().public_bytes(serialization.Encoding.X962,
                                                       serialization.PublicFormat.UncompressedPoint)
        b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
        keys = {"private": b64(raw_private), "public": b64(raw_public)}
        set_setting(c, "vapid", keys)
        return keys


def public_key() -> str:
    return _keys()["public"]


def save(profile_id: int, sub: dict) -> None:
    with tx() as c:
        ex(c, "INSERT INTO push_subs (profile_id, endpoint, data) VALUES (%s,%s,%s) "
              "ON CONFLICT (endpoint) DO UPDATE SET profile_id=EXCLUDED.profile_id, data=EXCLUDED.data",
           profile_id, sub["endpoint"], Jsonb(sub))


def send(sub_row: dict, payload: dict) -> None:
    from pywebpush import webpush, WebPushException
    try:
        webpush(subscription_info=sub_row["data"], data=json.dumps(payload), vapid_private_key=_keys()["private"],
                vapid_claims={"sub": f"mailto:admin@{config.PUBLIC_URL.split('//')[-1]}"}, ttl=3 * 3600)
    except WebPushException as e:
        if e.response is not None and e.response.status_code in (404, 410):
            with tx() as c:
                ex(c, "DELETE FROM push_subs WHERE id=%s", sub_row["id"])


def remind_once() -> int:
    today = game.today()
    sent = 0
    with tx() as c:
        rows = q(c, "SELECT s.*, p.name, p.current_streak FROM push_subs s JOIN profiles p ON p.id=s.profile_id "
                    "LEFT JOIN daily_activity d ON d.profile_id=p.id AND d.day=%s "
                    "WHERE (s.last_sent IS NULL OR s.last_sent < %s) AND NOT coalesce(d.goal_met, false)", today, today)
        for r in rows:
            ex(c, "UPDATE push_subs SET last_sent=%s WHERE id=%s", today, r["id"])
    for r in rows:
        streak = r["current_streak"]
        body = (f"Read a little to keep your {streak}-day streak alive." if streak
                else "A few minutes of reading meets today's goal.")
        send(r, {"title": f"{r['name']}, today's goal is still open", "body": body, "url": "/"})
        sent += 1
    return sent


def _loop() -> None:
    while True:
        try:
            if game.now_ist().hour == REMINDER_HOUR:
                remind_once()
        except Exception as e:
            print(f"[read] reminder failed: {e}", flush=True)
        time.sleep(600)


def start() -> None:
    threading.Thread(target=_loop, daemon=True, name="reminders").start()
