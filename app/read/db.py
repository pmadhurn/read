import json
import time
from contextlib import contextmanager
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from . import config

_pool: ConnectionPool | None = None


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            config.DATABASE_URL, min_size=1, max_size=12,
            kwargs={"row_factory": dict_row}, open=True,
        )
    return _pool


@contextmanager
def tx():
    """One transaction: commits on success, rolls back on error."""
    with pool().connection() as conn:
        yield conn


def connect() -> psycopg.Connection:
    """Standalone connection for worker processes, which cannot share the pool."""
    return psycopg.connect(config.DATABASE_URL, row_factory=dict_row, autocommit=True)


def q(conn, sql: str, *args) -> list[dict]:
    return conn.execute(sql, args).fetchall()


def q1(conn, sql: str, *args) -> dict | None:
    return conn.execute(sql, args).fetchone()


def ex(conn, sql: str, *args) -> int:
    return conn.execute(sql, args).rowcount


def get_setting(conn, key: str, default=None):
    row = q1(conn, "SELECT value FROM settings WHERE key = %s", key)
    return row["value"] if row else default


def set_setting(conn, key: str, value) -> None:
    ex(conn, "INSERT INTO settings (key, value) VALUES (%s, %s) "
             "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", key, Jsonb(value))


def init_schema() -> None:
    sql = (Path(__file__).parent / "schema.sql").read_text()
    for attempt in range(30):
        try:
            with tx() as c:
                c.execute(sql)
            return
        except psycopg.OperationalError:
            if attempt == 29:
                raise
            time.sleep(1)


__all__ = ["tx", "connect", "q", "q1", "ex", "get_setting", "set_setting", "init_schema", "Jsonb", "json"]
