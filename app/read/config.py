import os
from pathlib import Path
from zoneinfo import ZoneInfo

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://read:read@localhost:5432/read")
SECRET_KEY = os.environ.get("SECRET_KEY", "")
INITIAL_FAMILY_PASSCODE = os.environ.get("INITIAL_FAMILY_PASSCODE", "")
INITIAL_ADMIN_PIN = os.environ.get("INITIAL_ADMIN_PIN", "")
PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://localhost:8160").rstrip("/")

MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "100")) * 1024 * 1024
MAX_PROFILES = int(os.environ.get("MAX_PROFILES", "10"))
STORAGE_PLAN_BYTES = int(os.environ.get("STORAGE_PLAN_GB", "10")) * 1024**3
BACKUP_KEEP_DAYS = int(os.environ.get("BACKUP_KEEP_DAYS", "14"))

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
BOOKS_DIR = DATA_DIR / "books"
TMP_DIR = DATA_DIR / "tmp"
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", "/backups"))
WEB_DIR = Path(os.environ.get("WEB_DIR", "/web"))

# Streak days, league weeks and reminders all follow India Standard Time (GM-3).
IST = ZoneInfo("Asia/Kolkata")

DEVICE_COOKIE = "rd_device"
ADMIN_COOKIE = "rd_admin"
DEVICE_COOKIE_DAYS = 365
ADMIN_SESSION_HOURS = 12

PASSCODE_MAX_TRIES = 5
PASSCODE_LOCK_MINUTES = 15

CHUNK_BYTES = 8 * 1024 * 1024
ALLOWED_FORMATS = {"epub", "pdf", "txt", "docx", "html", "htm", "md", "markdown", "mobi", "azw3", "azw"}

DEFAULT_XP_RULES = {
    "words_per_xp": 100,
    "goal_bonus": 10,
    "chapter_bonus": 50,
    "book_bonus": 200,
    "streak7_multiplier": 1.1,
    "streak30_multiplier": 1.25,
}
