from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import api_core, api_more, backup, discover, config, game, importer, push, security
from .db import init_schema, tx, q1

# Reachable without the family passcode: the gate itself and nothing else (AC-1).
OPEN_PATHS = {"/api/access", "/api/access/passcode", "/healthz", "/robots.txt", "/gate.css", "/gate.js"}

CSP = ("default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
       "script-src 'self'; connect-src 'self'; font-src 'self'; worker-src 'self'; manifest-src 'self'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


@asynccontextmanager
async def lifespan(app: FastAPI):
    for d in (config.BOOKS_DIR, config.TMP_DIR):
        d.mkdir(parents=True, exist_ok=True)
    init_schema()
    security.seed_secrets()
    with tx() as c:
        game.seed_badges(c)
    importer.resume_pending()
    backup.start()
    push.start()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def gate(request: Request, call_next):
    path = request.url.path
    # Fonts and icons carry nothing private and the gate page needs them.
    is_open = path in OPEN_PATHS or path.startswith("/fonts/") or path.startswith("/icons/")
    if not is_open and not security.device_ok(request):
        if path.startswith("/api/"):
            response = JSONResponse({"detail": "Passcode required"}, status_code=401)
        elif request.method == "GET" and "text/html" in request.headers.get("accept", ""):
            response = FileResponse(config.WEB_DIR / "gate.html", status_code=401)
        else:
            response = PlainTextResponse("Passcode required", status_code=401)
    else:
        response = await call_next(request)

    h = response.headers
    # no-transform also stops the CDN rewriting our scripts; private/no-store keeps
    # anything behind the passcode out of its shared cache (NF-7).
    if path.startswith("/fonts/"):
        h["Cache-Control"] = "private, max-age=31536000, immutable, no-transform"
    elif path.startswith("/api/") or response.status_code == 401:
        h.setdefault("Cache-Control", "private, no-store, no-transform")
    else:
        h["Cache-Control"] = "private, no-cache, no-transform"
    h["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    h["X-Content-Type-Options"] = "nosniff"
    h["Referrer-Policy"] = "no-referrer"
    h["X-Frame-Options"] = "DENY"
    h["Content-Security-Policy"] = CSP
    h["Permissions-Policy"] = "interest-cohort=(), geolocation=(), camera=(), microphone=()"
    if path == "/sw.js":
        h["Service-Worker-Allowed"] = "/"
    return response


@app.get("/healthz")
def healthz():
    with tx() as c:
        q1(c, "SELECT 1 AS ok")
    return {"ok": True}


@app.get("/robots.txt", response_class=PlainTextResponse)
def robots():
    return "User-agent: *\nDisallow: /\n"


app.include_router(api_core.router)
app.include_router(api_more.router)
app.include_router(api_more.admin)
app.include_router(discover.router)
app.mount("/", StaticFiles(directory=config.WEB_DIR, html=True), name="web")
