"""Daily database dumps kept for 14 days, a mirror of the book files, and the
on-demand full archive (NF-5, AD-7)."""
import gzip
import os
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import config, game


def _dump_to(path: Path) -> None:
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wb", compresslevel=6) as out:
        proc = subprocess.Popen(["pg_dump", "--no-owner", "--dbname", config.DATABASE_URL],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        shutil.copyfileobj(proc.stdout, out)
        err = proc.stderr.read().decode()
        if proc.wait() != 0:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"pg_dump failed: {err.strip()}")
    # Verify before replacing: a truncated dump must never shadow a good one.
    with gzip.open(tmp, "rb") as check:
        while check.read(1024 * 1024):
            pass
    if tmp.stat().st_size < 1000:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("database dump is suspiciously small")
    tmp.replace(path)


def _mirror_files() -> None:
    """Book files never change once written, so a plain mirror is a complete copy.
    Files of deleted books linger for the retention window, then go."""
    dest = config.BACKUP_DIR / "files"
    dest.mkdir(parents=True, exist_ok=True)
    live = set()
    if config.BOOKS_DIR.exists():
        for src in config.BOOKS_DIR.rglob("*"):
            if not src.is_file():
                continue
            rel = src.relative_to(config.BOOKS_DIR)
            live.add(rel)
            target = dest / rel
            if not target.exists() or target.stat().st_size != src.stat().st_size \
                    or target.stat().st_mtime < src.stat().st_mtime:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, target)
    cutoff = time.time() - config.BACKUP_KEEP_DAYS * 86400
    for old in dest.rglob("*"):
        if old.is_file() and old.relative_to(dest) not in live and old.stat().st_mtime < cutoff:
            old.unlink()
    for d in sorted((p for p in dest.rglob("*") if p.is_dir()), reverse=True):
        if not any(d.iterdir()):
            d.rmdir()


def run_daily() -> str:
    config.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    name = f"read-db-{game.today().isoformat()}.sql.gz"
    _dump_to(config.BACKUP_DIR / name)
    _mirror_files()
    cutoff = game.today() - timedelta(days=config.BACKUP_KEEP_DAYS)
    for f in config.BACKUP_DIR.glob("read-db-*.sql.gz"):
        try:
            if datetime.strptime(f.name[8:18], "%Y-%m-%d").date() < cutoff:
                f.unlink()
        except ValueError:
            continue
    return name


def list_backups() -> list[dict]:
    if not config.BACKUP_DIR.exists():
        return []
    files = sorted(config.BACKUP_DIR.glob("read-db-*.sql.gz"), reverse=True)
    return [{"name": f.name, "bytes": f.stat().st_size} for f in files]


def stream_full_archive():
    """Database dump plus every book file as one tar.gz, streamed as it is built
    so a large library neither fills the disk nor times out before the first byte."""
    work = Path(tempfile.mkdtemp(prefix="backup-", dir=config.TMP_DIR))
    try:
        _dump_to(work / "database.sql.gz")
        config.BOOKS_DIR.mkdir(parents=True, exist_ok=True)
        proc = subprocess.Popen(["tar", "-czf", "-", "-C", str(work), "database.sql.gz",
                                 "-C", str(config.DATA_DIR), "books"], stdout=subprocess.PIPE)
        while chunk := proc.stdout.read(1024 * 1024):
            yield chunk
        proc.wait()
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _loop() -> None:
    while True:
        try:
            today = game.today().isoformat()
            done = (config.BACKUP_DIR / f"read-db-{today}.sql.gz").exists()
            if not done and game.now_ist().hour >= 3:
                run_daily()
                print(f"[read] backup written for {today}", flush=True)
        except Exception as e:
            print(f"[read] backup failed: {e}", flush=True)
        time.sleep(1800)


def start() -> None:
    if os.access(config.BACKUP_DIR, os.W_OK) or not config.BACKUP_DIR.exists():
        threading.Thread(target=_loop, daemon=True, name="backup").start()
    else:
        print(f"[read] backup directory {config.BACKUP_DIR} is not writable; backups are OFF", flush=True)
