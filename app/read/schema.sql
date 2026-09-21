CREATE TABLE IF NOT EXISTS settings (
    key   text PRIMARY KEY,
    value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
    id              serial PRIMARY KEY,
    name            text NOT NULL,
    avatar          text NOT NULL DEFAULT '📖',
    color           text NOT NULL DEFAULT '#4f7cff',
    settings        jsonb NOT NULL DEFAULT '{}',
    goal_type       text NOT NULL DEFAULT 'minutes',
    goal_value      integer NOT NULL DEFAULT 10,
    xp              integer NOT NULL DEFAULT 0,
    xp_frac         double precision NOT NULL DEFAULT 0,
    current_streak  integer NOT NULL DEFAULT 0,
    best_streak     integer NOT NULL DEFAULT 0,
    freezes         integer NOT NULL DEFAULT 0,
    last_reconciled date NOT NULL,
    hidden          boolean NOT NULL DEFAULT false,
    tier            integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_name_key ON profiles (lower(name));

CREATE TABLE IF NOT EXISTS books (
    id          serial PRIMARY KEY,
    title       text NOT NULL DEFAULT '',
    author      text NOT NULL DEFAULT '',
    format      text NOT NULL DEFAULT '',
    file_path   text,
    file_size   bigint NOT NULL DEFAULT 0,
    has_cover   boolean NOT NULL DEFAULT false,
    word_count  integer NOT NULL DEFAULT 0,
    script      text NOT NULL DEFAULT 'latin',
    tags        text[] NOT NULL DEFAULT '{}',
    warnings    jsonb NOT NULL DEFAULT '[]',
    source_url  text,
    uploaded_by integer REFERENCES profiles(id) ON DELETE SET NULL,
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    status      text NOT NULL DEFAULT 'processing',
    stage       text NOT NULL DEFAULT 'queued',
    progress    integer NOT NULL DEFAULT 0,
    error_code  text,
    error_msg   text,
    duplicate_of integer,
    deleted_at  timestamptz
);

CREATE TABLE IF NOT EXISTS chapters (
    id         serial PRIMARY KEY,
    book_id    integer NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    ord        integer NOT NULL,
    title      text NOT NULL,
    text       text NOT NULL,
    word_count integer NOT NULL,
    UNIQUE (book_id, ord)
);

CREATE TABLE IF NOT EXISTS reading_progress (
    profile_id    integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    book_id       integer NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_ord   integer NOT NULL DEFAULT 0,
    word_index    integer NOT NULL DEFAULT 0,
    status        text NOT NULL DEFAULT 'to_read',
    words_counted integer NOT NULL DEFAULT 0,
    finish_bonus  boolean NOT NULL DEFAULT false,
    started_at    timestamptz,
    finished_at   timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, book_id)
);

CREATE TABLE IF NOT EXISTS chapter_reads (
    profile_id    integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    chapter_id    integer NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    words_counted integer NOT NULL DEFAULT 0,
    completed_at  timestamptz,
    PRIMARY KEY (profile_id, chapter_id)
);

CREATE TABLE IF NOT EXISTS read_ranges (
    id         bigserial PRIMARY KEY,
    profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    chapter_id integer NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    start_w    integer NOT NULL,
    end_w      integer NOT NULL,
    seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS read_ranges_lookup ON read_ranges (profile_id, chapter_id, seen_at);

-- book_id is deliberately not a foreign key: history survives book deletion (AD-1).
CREATE TABLE IF NOT EXISTS reading_sessions (
    id             text PRIMARY KEY,
    profile_id     integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    book_id        integer NOT NULL,
    started_at     timestamptz NOT NULL DEFAULT now(),
    ended_at       timestamptz NOT NULL DEFAULT now(),
    words          integer NOT NULL DEFAULT 0,
    active_seconds double precision NOT NULL DEFAULT 0,
    avg_wpm        integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reading_sessions_profile ON reading_sessions (profile_id, started_at);

CREATE TABLE IF NOT EXISTS daily_activity (
    profile_id  integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    day         date NOT NULL,
    words       integer NOT NULL DEFAULT 0,
    seconds     double precision NOT NULL DEFAULT 0,
    xp          integer NOT NULL DEFAULT 0,
    goal_met    boolean NOT NULL DEFAULT false,
    freeze_used boolean NOT NULL DEFAULT false,
    PRIMARY KEY (profile_id, day)
);

CREATE TABLE IF NOT EXISTS hour_activity (
    profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    hour       integer NOT NULL,
    seconds    double precision NOT NULL DEFAULT 0,
    PRIMARY KEY (profile_id, hour)
);

CREATE TABLE IF NOT EXISTS xp_events (
    id         bigserial PRIMARY KEY,
    profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    at         timestamptz NOT NULL DEFAULT now(),
    amount     integer NOT NULL,
    reason     text NOT NULL,
    book_id    integer
);
CREATE INDEX IF NOT EXISTS xp_events_profile_at ON xp_events (profile_id, at);

CREATE TABLE IF NOT EXISTS bookmarks (
    id          serial PRIMARY KEY,
    profile_id  integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    book_id     integer NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_ord integer NOT NULL,
    word_index  integer NOT NULL,
    snippet     text NOT NULL DEFAULT '',
    note        text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS badges (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    description text NOT NULL,
    icon        text NOT NULL,
    kind        text NOT NULL,
    threshold   double precision NOT NULL DEFAULT 0,
    sort        integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS profile_badges (
    profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    badge_id   text NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
    earned_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, badge_id)
);

CREATE TABLE IF NOT EXISTS league_weeks (
    week_start date NOT NULL,
    profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    xp         integer NOT NULL,
    rank       integer NOT NULL,
    tier       integer NOT NULL,
    trophy     text,
    PRIMARY KEY (week_start, profile_id)
);

CREATE TABLE IF NOT EXISTS activity (
    id         bigserial PRIMARY KEY,
    profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    at         timestamptz NOT NULL DEFAULT now(),
    kind       text NOT NULL,
    data       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS activity_at ON activity (at DESC);

CREATE TABLE IF NOT EXISTS favourites (
    profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    book_id    integer NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    PRIMARY KEY (profile_id, book_id)
);

CREATE TABLE IF NOT EXISTS collections (
    id         serial PRIMARY KEY,
    name       text NOT NULL,
    created_by integer REFERENCES profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collection_books (
    collection_id integer NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    book_id       integer NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    PRIMARY KEY (collection_id, book_id)
);

CREATE TABLE IF NOT EXISTS push_subs (
    id         serial PRIMARY KEY,
    profile_id integer NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    endpoint   text NOT NULL UNIQUE,
    data       jsonb NOT NULL,
    last_sent  date
);

CREATE TABLE IF NOT EXISTS dictionary_cache (
    word text PRIMARY KEY,
    data jsonb NOT NULL
);
