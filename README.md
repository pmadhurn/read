# read

Private family speed-reading library. Up to ten people share one shelf of books and read them
one word at a time (RSVP), with streaks, XP, badges and a weekly league.

Built against `docs/` — see [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for the requirement-by-requirement status.

## Run

```bash
cp .env.example .env      # set a passcode, a PIN and two random secrets
docker compose up -d --build
```

The app listens on `127.0.0.1:${HTTP_PORT}` (default 8160) and expects TLS to terminate in front of it
(a Cloudflare tunnel here). `INITIAL_FAMILY_PASSCODE` and `INITIAL_ADMIN_PIN` only seed the hashed values on
first boot; afterwards they are changed from **Settings → Admin** and the database is authoritative.

| Service | Image | Role |
|---|---|---|
| `proxy` | nginx | the only published port; reverse proxy |
| `app` | `./app` (FastAPI) | API, import workers, static frontend from `./web` |
| `db` | postgres 17 | data (`pgdata` volume) |

Book files live in the `books` volume. Daily database dumps (kept 14 days) and a mirror of the book files are
written to `BACKUP_DIR`.

## Layout

```
app/read/            API and domain logic
  importer/          one module per format (epub, pdf, simple: txt/html/md/docx/mobi/url)
  game.py            streaks, XP, badges, leagues
  security.py        passcode gate, admin PIN, rate limiting
web/                 frontend: plain ES modules, no build step
tests/               smoke.py (API), e2e.mjs (browser), logic.py (time rules), taps.mjs (tap targets)
```

`web/` is bind-mounted read-only, so frontend edits are live on reload. Backend edits need
`docker compose up -d --build app`.

## Tests

```bash
python3 tests/smoke.py http://localhost:8160 "$PASSCODE" "$PIN"     # local only: it trips the lockout on purpose
node tests/e2e.mjs https://read.example.com "$PASSCODE" "$PIN" /tmp  # safe against the live site
docker compose exec -T -e PYTHONPATH=/srv app sh -c 'cat > /tmp/l.py && cd /srv && python /tmp/l.py' < tests/logic.py
```

## Restore

```bash
gunzip -c read-db-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U read -d read
docker compose cp files/. app:/data/books/
```
