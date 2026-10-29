-- Idempotent initialization for a new volume: no seed data, IDs or migration tables.
CREATE TABLE IF NOT EXISTS public.stories (
    content TEXT NOT NULL
);
