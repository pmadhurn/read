import hashlib
import hmac
import secrets
import threading
import time

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHashError
from fastapi import HTTPException, Request

from . import config
from .db import tx, q1, get_setting, set_setting

_hasher = PasswordHasher()
_cache = {"generation": None, "at": 0.0}


def hash_secret(value: str) -> str:
    return _hasher.hash(value)


def verify_secret(stored: str, value: str) -> bool:
    try:
        return _hasher.verify(stored, value)
    except (VerifyMismatchError, InvalidHashError):
        return False


def seed_secrets() -> None:
    """First boot only. Later boots never overwrite what the admin set (AD-4)."""
    with tx() as c:
        if get_setting(c, "passcode_hash") is None:
            passcode = config.INITIAL_FAMILY_PASSCODE or secrets.token_urlsafe(9)
            set_setting(c, "passcode_hash", hash_secret(passcode))
            set_setting(c, "generation", 1)
            if not config.INITIAL_FAMILY_PASSCODE:
                print(f"[read] generated family passcode: {passcode}", flush=True)
        if get_setting(c, "pin_hash") is None:
            pin = config.INITIAL_ADMIN_PIN or str(secrets.randbelow(900000) + 100000)
            set_setting(c, "pin_hash", hash_secret(pin))
            if not config.INITIAL_ADMIN_PIN:
                print(f"[read] generated admin PIN: {pin}", flush=True)
        if get_setting(c, "secret") is None:
            set_setting(c, "secret", config.SECRET_KEY or secrets.token_hex(32))


def _secret() -> bytes:
    if config.SECRET_KEY:
        return config.SECRET_KEY.encode()
    with tx() as c:
        return get_setting(c, "secret").encode()


def generation() -> int:
    # Cached briefly: it is read on every request.
    if _cache["generation"] is None or time.time() - _cache["at"] > 5:
        with tx() as c:
            _cache["generation"] = int(get_setting(c, "generation", 1))
        _cache["at"] = time.time()
    return _cache["generation"]


def bump_generation() -> None:
    """Invalidates every remembered device (AC-9)."""
    with tx() as c:
        set_setting(c, "generation", int(get_setting(c, "generation", 1)) + 1)
    _cache["generation"] = None


def _sign(payload: str) -> str:
    return hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()


def make_token(kind: str, lifetime_seconds: int) -> str:
    payload = f"{kind}.{generation()}.{int(time.time()) + lifetime_seconds}"
    return f"{payload}.{_sign(payload)}"


def check_token(token: str | None, kind: str) -> bool:
    if not token:
        return False
    try:
        k, gen, exp, sig = token.split(".")
    except ValueError:
        return False
    if not hmac.compare_digest(sig, _sign(f"{k}.{gen}.{exp}")):
        return False
    return k == kind and int(gen) == generation() and int(exp) > time.time()


def device_ok(request: Request) -> bool:
    return check_token(request.cookies.get(config.DEVICE_COOKIE), "device")


def admin_ok(request: Request) -> bool:
    return check_token(request.cookies.get(config.ADMIN_COOKIE), "admin")


def require_admin(request: Request) -> None:
    if not admin_ok(request):
        raise HTTPException(403, "Admin PIN required")


def client_ip(request: Request) -> str:
    # Every request reaches us from the tunnel, so the socket peer is useless.
    return (request.headers.get("cf-connecting-ip")
            or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
            or (request.client.host if request.client else "unknown"))


class AttemptLimiter:
    """N failures, then a lockout window (AC-3)."""

    def __init__(self, max_tries: int, lock_seconds: int):
        self.max_tries, self.lock_seconds = max_tries, lock_seconds
        self._fails: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def retry_after(self, key: str) -> int:
        with self._lock:
            now = time.time()
            fails = [t for t in self._fails.get(key, []) if now - t < self.lock_seconds]
            self._fails[key] = fails
            if len(fails) >= self.max_tries:
                return int(self.lock_seconds - (now - fails[0])) + 1
            return 0

    def fail(self, key: str) -> int:
        with self._lock:
            self._fails.setdefault(key, []).append(time.time())
            return max(0, self.max_tries - len(self._fails[key]))

    def reset(self, key: str) -> None:
        with self._lock:
            self._fails.pop(key, None)


passcode_limiter = AttemptLimiter(config.PASSCODE_MAX_TRIES, config.PASSCODE_LOCK_MINUTES * 60)
pin_limiter = AttemptLimiter(config.PASSCODE_MAX_TRIES, config.PASSCODE_LOCK_MINUTES * 60)


def current_profile(request: Request) -> dict:
    pid = request.headers.get("x-profile-id", "")
    if not pid.isdigit():
        raise HTTPException(400, "Choose a profile first")
    with tx() as c:
        row = q1(c, "SELECT * FROM profiles WHERE id = %s", int(pid))
    if not row:
        raise HTTPException(404, "Profile not found")
    return row
