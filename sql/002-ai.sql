-- Additive, transactional and repeatable. Apply to the EXISTING stories database.
BEGIN;
SELECT pg_advisory_xact_lock(714003, 4);
CREATE SCHEMA IF NOT EXISTS ai;

CREATE TABLE IF NOT EXISTS ai.sources (
    source TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    timezone TEXT NOT NULL,
    language TEXT NOT NULL CHECK (language IN ('ru', 'en')),
    desired_key TEXT,
    last_scheduled_day DATE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS ai.jobs (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('chat', 'summary')),
    source TEXT REFERENCES ai.sources(source),
    cache_key TEXT,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
    payload JSONB,
    result JSONB,
    error_code TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    discard_requested BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    CHECK ((kind = 'chat' AND source IS NULL) OR (kind = 'summary' AND source IS NOT NULL AND cache_key IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_jobs_active_summary ON ai.jobs(source, cache_key)
    WHERE kind = 'summary' AND state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS ai_jobs_ready ON ai.jobs(available_at, created_at) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS ai_jobs_completed ON ai.jobs(completed_at) WHERE completed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai.reports (
    source TEXT PRIMARY KEY REFERENCES ai.sources(source),
    cache_key TEXT NOT NULL,
    report JSONB NOT NULL,
    period JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS ai.control (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    active_job UUID REFERENCES ai.jobs(id),
    blocked BOOLEAN NOT NULL DEFAULT FALSE
);
INSERT INTO ai.control(singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS ai.rate_limits (
    bucket TEXT PRIMARY KEY,
    window_start TIMESTAMPTZ NOT NULL,
    requests INTEGER NOT NULL
);
COMMIT;
