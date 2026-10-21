-- supabase_schema.sql
-- Run this schema block in your Supabase SQL Editor.
-- This builds all required tables, relation keys, indices, and RLS policies.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. PROJECTS TABLE
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id VARCHAR(255) NOT NULL,
    org_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    industry VARCHAR(255) NOT NULL,
    target_market VARCHAR(50) NOT NULL,
    product_name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(255),
    company_context TEXT,
    motor_tech VARCHAR(255),
    key_diff VARCHAR(255),
    price_point VARCHAR(255),
    saved_defaults JSONB DEFAULT '{}'::jsonb,
    latest_analysis_id UUID,
    latest_report_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. ANALYSES TABLE
-- phase0_result holds the mandatory Product Identification step's Identity
-- Card (see lib/product-identification.ts) — same column-per-phase pattern
-- as phase1/2/3_result. pending_question is set (and status stays
-- "running") when identification can't confidently determine the
-- product's category and the pipeline must pause for user input rather
-- than guess; its mere presence is the pause signal, checked by the
-- client and by runAnalysisStep itself before advancing.
CREATE TABLE IF NOT EXISTS analyses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id VARCHAR(255) NOT NULL,
    org_id VARCHAR(255) NOT NULL,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    phase INTEGER NOT NULL DEFAULT 1,
    context JSONB DEFAULT '{}'::jsonb,
    phase0_result JSONB DEFAULT '{}'::jsonb,
    phase1_result JSONB DEFAULT '{}'::jsonb,
    phase2_result JSONB DEFAULT '{}'::jsonb,
    phase3_result JSONB DEFAULT '{}'::jsonb,
    pending_question JSONB,
    error_message TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- 3. REPORTS TABLE
CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id VARCHAR(255) NOT NULL,
    analysis_id UUID REFERENCES analyses(id) ON DELETE SET NULL,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    competitive_analysis JSONB DEFAULT '{}'::jsonb,
    pricing_analysis JSONB DEFAULT '{}'::jsonb,
    go_to_market JSONB DEFAULT '{}'::jsonb,
    content_form JSONB DEFAULT '{}'::jsonb,
    product_knowledge JSONB DEFAULT '{}'::jsonb,
    drive_url VARCHAR(500),
    drive_file_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. COMPETITORS TABLE (Dynamic & Fixed Reference List)
CREATE TABLE IF NOT EXISTS competitors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id VARCHAR(255) NOT NULL,
    org_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    website VARCHAR(255),
    description TEXT,
    main_products TEXT,
    status VARCHAR(50) DEFAULT 'active',
    is_fixed BOOLEAN DEFAULT false NOT NULL,
    logo_url VARCHAR(500),
    tags VARCHAR(255)[] DEFAULT '{}'::varchar[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. ANALYSIS COMPETITORS (Individual competitors mapped from specific analysis runs)
CREATE TABLE IF NOT EXISTS analysis_competitors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_id UUID REFERENCES analyses(id) ON DELETE CASCADE NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    brand VARCHAR(255),
    tier VARCHAR(50) NOT NULL,
    asin VARCHAR(50),
    amazon_url VARCHAR(500),
    price VARCHAR(50),
    rating VARCHAR(50),
    review_count VARCHAR(50),
    monthly_sales VARCHAR(50),
    bsr_rank VARCHAR(50),
    initials VARCHAR(10),
    key_features TEXT[] DEFAULT '{}'::text[],
    strengths TEXT[] DEFAULT '{}'::text[],
    weaknesses TEXT[] DEFAULT '{}'::text[],
    recent_news TEXT[] DEFAULT '{}'::text[],
    top_feature_summary TEXT,
    threat_score INTEGER DEFAULT 50,
    tags VARCHAR(255)[] DEFAULT '{}'::varchar[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 6. PROJECT OUTPUTS
CREATE TABLE IF NOT EXISTS project_outputs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
    output_type VARCHAR(50) NOT NULL,
    content JSONB DEFAULT '{}'::jsonb NOT NULL,
    html TEXT,
    drive_url VARCHAR(500),
    drive_file_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 7. AMAZON CACHE (Rainforest product + review-analysis responses)
-- Cross-instance cache — an in-memory Map only helps within one warm
-- serverless container; this survives across all of them. product: 12h TTL,
-- reviews_analysis: 24h TTL, enforced by the caller checking fetched_at.
CREATE TABLE IF NOT EXISTS amazon_cache (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asin VARCHAR(20) NOT NULL,
    cache_type VARCHAR(30) NOT NULL,
    payload JSONB NOT NULL,
    fetched_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS amazon_cache_asin_type_idx ON amazon_cache(asin, cache_type);

-- 8. DOCUMENTS / DOCUMENT FIELDS / DOCUMENT FIELD HISTORY
-- Field-granular generated documents (currently: doc_type = 'gtm' only).
-- One row per (project, doc_type) — regenerating updates fields in place
-- rather than creating a duplicate document. There is no separate products
-- table: project_id IS the product identifier (one product per project).
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
    doc_type VARCHAR(30) NOT NULL,
    status VARCHAR(20) DEFAULT 'draft',
    drive_url VARCHAR(500),
    drive_file_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE (project_id, doc_type)
);

CREATE TABLE IF NOT EXISTS document_fields (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE NOT NULL,
    field_id TEXT NOT NULL,
    section TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT,
    source TEXT,
    source_detail JSONB DEFAULT '{}'::jsonb,
    flagged BOOLEAN DEFAULT false,
    updated_by TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE (document_id, field_id)
);

CREATE TABLE IF NOT EXISTS document_field_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_field_id UUID REFERENCES document_fields(id) ON DELETE CASCADE NOT NULL,
    answer TEXT,
    changed_by TEXT,
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 9. PRODUCT SNAPSHOTS
-- A raw, timestamped capture of the real product (official site scrape
-- and/or Amazon listing via Rainforest) taken at project creation or an
-- explicit "re-capture". TDS is generated ONLY from this data — never
-- from a project's typed-in description — and re-capturing creates a NEW
-- row here (never overwrites) so the TDS document's `snapshot_id` always
-- points at exactly the data it was generated from.
CREATE TABLE IF NOT EXISTS product_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
    source_url TEXT,
    asin VARCHAR(20),
    raw_data JSONB DEFAULT '{}'::jsonb NOT NULL,
    captured_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS product_snapshots_project_captured_idx ON product_snapshots(project_id, captured_at DESC);

-- 10. PROJECT GENERATION STATE
-- Backs the resumable background pipeline (scrape snapshot -> generate TDS
-- -> generate GTM) kicked off when a project is created with a product
-- anchor. One row per project, advanced one phase per
-- /api/projects/:id/pipeline/continue call — same resumable-step shape as
-- the `analyses` table's phase/status columns.
CREATE TABLE IF NOT EXISTS project_generation_state (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    phase VARCHAR(20) NOT NULL DEFAULT 'pending',
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    error_message TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Product-anchor identity, captured once at project creation. The project
-- NAME stays a free-text reference label only — every generation prompt
-- must identify the product via the scraped snapshot title / this URL /
-- this ASIN, never via `projects.name`.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS product_url TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS asin VARCHAR(20);

-- Mandatory Product Identification stage (runs before competitor discovery)
-- added to the existing 3-phase analysis pipeline as a new phase 0.
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS phase0_result JSONB DEFAULT '{}'::jsonb;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS pending_question JSONB;

-- Links a doc_type='tds' document to the exact snapshot it was generated
-- from, so the UI can show "Live snapshot captured {captured_at} from
-- {domain}". Null for doc_type='gtm'.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS snapshot_id UUID REFERENCES product_snapshots(id);

-- Structured, citation-verified Key Features / Strengths / Weaknesses &
-- Sentiment / News data per competitor (lib/citations.ts's Claim shape).
-- Additive only — the existing key_features/strengths/weaknesses/recent_news
-- TEXT[] columns above stay as-is; this JSONB column is where the richer,
-- source-cited evidence objects live once populated.
ALTER TABLE analysis_competitors ADD COLUMN IF NOT EXISTS evidence JSONB;

-- Shared by GTM and TDS field rows. `owner` mirrors the internal sheet's
-- Owner column (Product Marketing/Marketing/Sales/Legal/Ops); `notes` is
-- free-text, independent of the field's `answer`/history.
ALTER TABLE document_fields ADD COLUMN IF NOT EXISTS owner TEXT DEFAULT 'Product Marketing';
ALTER TABLE document_fields ADD COLUMN IF NOT EXISTS notes TEXT;

-- Re-architecture onto Inngest durable background jobs: `analyses` becomes
-- the unified job id (no separate job table — it's already the FK target
-- for reports/analysis_competitors). `job_status` is the new unified
-- running/partial_complete/complete/failed signal the status-polling
-- endpoint and frontend read; the legacy `status` column keeps being
-- written exactly as before so nothing already reading it breaks.
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS job_status VARCHAR(20) NOT NULL DEFAULT 'running';
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS total_searches INTEGER NOT NULL DEFAULT 0;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS inngest_run_id TEXT;

-- Per-task checkpointing for the Inngest-driven analysis pipeline. Each
-- durable step writes its result here on completion; a retry (automatic or
-- user-clicked) re-runs only rows with status='failed' — rows already
-- 'done' are read back directly, never re-executed. This is the source of
-- truth the status-polling endpoint and the section-level retry button
-- read/write; Inngest's own step memoization is a secondary safety net,
-- not a replacement for it (see lib/inngest/functions/analyze-product.ts).
CREATE TABLE IF NOT EXISTS analysis_tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID REFERENCES analyses(id) ON DELETE CASCADE NOT NULL,
    task_key VARCHAR(160) NOT NULL,
    task_type VARCHAR(40) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    provider VARCHAR(40),
    error_class VARCHAR(40),
    error TEXT,
    latency_ms INTEGER,
    result JSONB,
    inngest_run_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    UNIQUE (job_id, task_key)
);
CREATE INDEX IF NOT EXISTS analysis_tasks_job_idx ON analysis_tasks(job_id);
CREATE INDEX IF NOT EXISTS analysis_tasks_status_idx ON analysis_tasks(job_id, status);
CREATE INDEX IF NOT EXISTS analysis_tasks_admin_failures_idx ON analysis_tasks(status, provider, updated_at DESC) WHERE status = 'failed';

-- Per-provider circuit breaker state (Rainforest/OpenAI web-search/etc.) —
-- tripped after 5 consecutive failures, auto-resets 60s after opening.
-- record_provider_result is a Postgres RPC (not a plain Supabase-JS
-- read-then-write) because many concurrent Inngest step invocations across
-- DIFFERENT users' jobs race to update the same provider row; a naive
-- read-then-write would lose updates under real concurrency and silently
-- under-count failures, defeating the breaker.
CREATE TABLE IF NOT EXISTS provider_circuit_state (
    provider VARCHAR(40) PRIMARY KEY,
    state VARCHAR(20) NOT NULL DEFAULT 'closed',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    opened_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE OR REPLACE FUNCTION record_provider_result(p_provider VARCHAR, p_success BOOLEAN)
RETURNS TABLE(state VARCHAR, consecutive_failures INTEGER) AS $$
BEGIN
  INSERT INTO provider_circuit_state (provider, state, consecutive_failures, updated_at)
  VALUES (p_provider, 'closed', 0, now()) ON CONFLICT (provider) DO NOTHING;
  IF p_success THEN
    UPDATE provider_circuit_state SET consecutive_failures = 0, state = 'closed', opened_at = NULL, updated_at = now()
    WHERE provider = p_provider;
  ELSE
    UPDATE provider_circuit_state SET
      consecutive_failures = consecutive_failures + 1,
      state = CASE WHEN consecutive_failures + 1 >= 5 THEN 'open' ELSE state END,
      opened_at = CASE WHEN consecutive_failures + 1 >= 5 AND opened_at IS NULL THEN now() ELSE opened_at END,
      updated_at = now()
    WHERE provider = p_provider;
  END IF;
  RETURN QUERY SELECT provider_circuit_state.state, provider_circuit_state.consecutive_failures FROM provider_circuit_state WHERE provider = p_provider;
END;
$$ LANGUAGE plpgsql;

-- Enable RLS on all tables
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE amazon_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_field_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_generation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_circuit_state ENABLE ROW LEVEL SECURITY;

-- Create Permissive RLS Policies (allows anyone to query/insert/update/delete for prototype stage)
CREATE POLICY "Allow all operations for projects" ON projects FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for analyses" ON analyses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for amazon_cache" ON amazon_cache FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for reports" ON reports FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for competitors" ON competitors FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for analysis_competitors" ON analysis_competitors FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for project_outputs" ON project_outputs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for documents" ON documents FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for document_fields" ON document_fields FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for document_field_history" ON document_field_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for product_snapshots" ON product_snapshots FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for project_generation_state" ON project_generation_state FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for analysis_tasks" ON analysis_tasks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations for provider_circuit_state" ON provider_circuit_state FOR ALL USING (true) WITH CHECK (true);

-- Real auth (Supabase Auth) — profile/role data for real logged-in users,
-- one row per auth.users row. Domain data (projects/competitors/analyses/
-- reports) is intentionally NOT re-keyed to this id — see lib/auth.ts's
-- getAuthSession() comment on why it still maps to the existing fixed
-- org_id/user_id literal strings for now (single-admin app, no multi-tenant
-- management yet).
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    role VARCHAR(50) NOT NULL DEFAULT 'ADMIN' CHECK (role IN ('OWNER','ADMIN','MEMBER','VIEWER')),
    must_change_password BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for profiles" ON profiles FOR ALL USING (true) WITH CHECK (true);

-- Persisted, per-section data provenance — which source tier won, the
-- verbatim queries run, item counts used vs. rejected (with reasons), and
-- when — for each of Key Features / Reviews / News / Pricing. Append-only
-- (mirrors product_snapshots, NOT amazon_cache's overwrite-on-refresh
-- pattern): every resolver run INSERTs a new row so there's a real history,
-- never UPDATE/upsert. Keyed by product_key (== resolveCacheKey() output,
-- lib/product-cache-key.ts — the same stable identity amazon_cache already
-- uses for an in-progress, not-yet-saved competitor) + section.
-- analysis_id is best-effort/nullable (no analysis_id exists yet for a
-- competitor until an analysis job is created); product_name is denormalized
-- so the Details panel/PDF appendix can render without a join.
CREATE TABLE IF NOT EXISTS section_provenance (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_key VARCHAR(20) NOT NULL,
    section VARCHAR(20) NOT NULL,
    analysis_id UUID REFERENCES analyses(id) ON DELETE SET NULL,
    product_name TEXT,
    tiers JSONB NOT NULL DEFAULT '[]'::jsonb,
    queries JSONB NOT NULL DEFAULT '[]'::jsonb,
    resolved_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
-- "Latest row per (product_key, section)": filters on the two leading
-- columns, ORDER BY resolved_at DESC LIMIT 1 rides this index directly.
CREATE INDEX IF NOT EXISTS section_provenance_key_section_resolved_idx
    ON section_provenance(product_key, section, resolved_at DESC);
ALTER TABLE section_provenance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for section_provenance" ON section_provenance FOR ALL USING (true) WITH CHECK (true);

-- Preserves the AI/derivation-generated answer separately from `answer`
-- (the current, possibly hand-edited value) so a GTM/TDS CSV export can
-- show both side by side. Only ever written by an AI-driven save (full
-- generation or per-field regenerate) — a plain manual edit (PATCH with
-- just {answer}) leaves this column untouched, so it always reflects "what
-- the pipeline last said" regardless of how many times a human edits
-- `answer` afterward.
ALTER TABLE document_fields ADD COLUMN IF NOT EXISTS ai_answer TEXT;

-- 11. DECK TEMPLATES
-- Versioned master .pptx templates for the "Project Deck" feature. The
-- binary file itself lives in Supabase Storage bucket "deck-templates"
-- (same pattern as project_artwork's "artwork" bucket) — this row is
-- metadata + a pointer + the parsed/edited token->data-field mapping.
-- Only one row may have is_active = true at a time (enforced by the
-- partial unique index below); new projects' decks always render off
-- whichever template is currently active. Regenerating an existing
-- project's deck may instead pin an explicit older template_id (see
-- project_decks below), so an active-template change never silently
-- alters a deck someone regenerates from history.
CREATE TABLE IF NOT EXISTS deck_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    -- No public URL, same reasoning as project_decks below — served only
    -- through the authenticated admin routes, never rendered via <img>/<a>.
    file_path VARCHAR(500) NOT NULL,
    file_name VARCHAR(255),
    file_size_bytes INTEGER,
    slide_count INTEGER NOT NULL DEFAULT 0,
    -- Shape: { version, slide_count, tokens: DeckTokenMapping[], unmapped_tokens: string[] } — see lib/deck-types.ts.
    placeholder_map JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT false,
    uploaded_by VARCHAR(255),
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS deck_templates_one_active_idx ON deck_templates(is_active) WHERE is_active = true;
ALTER TABLE deck_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for deck_templates" ON deck_templates FOR ALL USING (true) WITH CHECK (true);

-- 12. PROJECT DECKS
-- Append-only, mirrors product_snapshots' "never overwrite, insert a new
-- row" pattern rather than documents' "one row per (project, doc_type),
-- upsert in place" pattern — a generated deck is a binary artifact with
-- real version history (Part 1's "regenerating an old deck may use its
-- original template version" requirement needs this to be a queryable
-- fact, not something only inferable from deck_templates.is_active at
-- read time). Binary output lives in Storage bucket "project-decks" —
-- unlike project_artwork, decks are never given a public URL (a GTM deck
-- contains pricing/competitive data), bytes are only ever served through
-- the authenticated /api/projects/:id/deck/download route.
CREATE TABLE IF NOT EXISTS project_decks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
    template_id UUID REFERENCES deck_templates(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | generating | complete | failed
    file_path VARCHAR(500),
    file_name VARCHAR(255),
    file_size_bytes INTEGER,
    -- Snapshot of the resolved token->value map used for THIS render (text/
    -- table values only — image tokens store the source URL, never raw
    -- bytes) — audit trail + backs the tab's "fill report" without needing
    -- to re-derive anything from the (possibly since-edited) GTM document.
    placeholder_values JSONB DEFAULT '{}'::jsonb,
    slides_removed INTEGER[] DEFAULT '{}'::integer[],
    error_message TEXT,
    -- Captured at generation time from the GTM document's true last-edited
    -- moment (max of the document row's and its most-recent field row's
    -- updated_at — see lib/db/decks.ts's getGtmLastEditedAt) so the tab can
    -- later detect "GTM edited after this deck was generated" without
    -- re-deriving it from possibly-changed data.
    gtm_snapshot_at TIMESTAMP WITH TIME ZONE,
    generated_at TIMESTAMP WITH TIME ZONE,
    drive_url VARCHAR(500),
    drive_file_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS project_decks_project_created_idx ON project_decks(project_id, created_at DESC);
ALTER TABLE project_decks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for project_decks" ON project_decks FOR ALL USING (true) WITH CHECK (true);

-- 13. LEGACY BRAND REGISTRY
-- Curated, admin-editable brand lists that competitor discovery's Phase 1
-- (legacy/established competitors) now searches directly instead of
-- relying purely on AI judgment (see lib/legacy-brand-discovery.ts). Each
-- category maps to a stable `slug` the app resolves to from the product's
-- Identity Card (category/subcategory + pro-vs-retail) — text columns like
-- `name`/`product_types` are not good join keys, hence the slug.
CREATE TABLE IF NOT EXISTS brand_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    product_types TEXT[] DEFAULT '{}'::text[],
    audience VARCHAR(20), -- 'professional' | 'retail'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE brand_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for brand_categories" ON brand_categories FOR ALL USING (true) WITH CHECK (true);

-- sort_order is the search PRIORITY order (lowest first) — also what "fill
-- 5 slots in priority order" means in lib/legacy-brand-discovery.ts.
-- `enabled=false` keeps a brand in the registry (never silently deleted)
-- but skips it in discovery, per the spec's "disable" requirement.
CREATE TABLE IF NOT EXISTS legacy_brands (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category_id UUID REFERENCES brand_categories(id) ON DELETE CASCADE NOT NULL,
    brand_name VARCHAR(255) NOT NULL,
    aliases TEXT[] DEFAULT '{}'::text[],
    enabled BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE (category_id, brand_name)
);
CREATE INDEX IF NOT EXISTS legacy_brands_category_sort_idx ON legacy_brands(category_id, sort_order);
ALTER TABLE legacy_brands ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for legacy_brands" ON legacy_brands FOR ALL USING (true) WITH CHECK (true);

-- Seed the 4 default categories + their curated brand lists exactly as
-- specified. Idempotent — safe to re-run.
INSERT INTO brand_categories (slug, name, product_types, audience) VALUES
    ('legacy_professional_clippers', 'Legacy Professional Clippers, Trimmers, and Shavers', ARRAY['clipper','trimmer','shaver'], 'professional'),
    ('legacy_retail_clippers', 'Legacy Retail Clippers, Trimmers, and Shavers', ARRAY['clipper','trimmer','shaver'], 'retail'),
    ('professional_beauty', 'Professional Beauty', ARRAY['dryer','iron','styler','brush'], 'professional'),
    ('retail_beauty', 'Retail Beauty', ARRAY['dryer','iron','styler','brush'], 'retail')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO legacy_brands (category_id, brand_name, aliases, sort_order)
SELECT c.id, b.brand_name, b.aliases, b.sort_order
FROM brand_categories c
JOIN (VALUES
    ('legacy_professional_clippers', 'Wahl', ARRAY[]::text[], 0),
    ('legacy_professional_clippers', 'Andis', ARRAY[]::text[], 1),
    ('legacy_professional_clippers', 'Oster', ARRAY[]::text[], 2),
    ('legacy_professional_clippers', 'BaByliss', ARRAY['BaBylissPRO','Babyliss Pro'], 3),
    ('legacy_professional_clippers', 'TPOB', ARRAY['The Profession Of Barbering'], 4),
    ('legacy_professional_clippers', 'Cocco', ARRAY[]::text[], 5),
    ('legacy_professional_clippers', 'JRL', ARRAY[]::text[], 6),

    ('legacy_retail_clippers', 'Wahl', ARRAY[]::text[], 0),
    ('legacy_retail_clippers', 'Andis', ARRAY[]::text[], 1),
    ('legacy_retail_clippers', 'Oster', ARRAY[]::text[], 2),
    ('legacy_retail_clippers', 'Panasonic', ARRAY[]::text[], 3),
    ('legacy_retail_clippers', 'Conair', ARRAY[]::text[], 4),
    ('legacy_retail_clippers', 'Manscaped', ARRAY[]::text[], 5),
    ('legacy_retail_clippers', 'Remington', ARRAY[]::text[], 6),

    ('professional_beauty', 'BaByliss', ARRAY['BaBylissPRO','Babyliss Pro'], 0),
    ('professional_beauty', 'GHD', ARRAY[]::text[], 1),
    ('professional_beauty', 'Paul Mitchell', ARRAY[]::text[], 2),
    ('professional_beauty', 'Bio Ionic', ARRAY[]::text[], 3),
    ('professional_beauty', 'Dyson', ARRAY[]::text[], 4),
    ('professional_beauty', 'Shark', ARRAY[]::text[], 5),
    ('professional_beauty', 'Amika', ARRAY[]::text[], 6),
    ('professional_beauty', 'Olivia Garden', ARRAY[]::text[], 7),
    ('professional_beauty', 'T3', ARRAY[]::text[], 8),

    ('retail_beauty', 'Conair', ARRAY[]::text[], 0),
    ('retail_beauty', 'Revlon', ARRAY[]::text[], 1),
    ('retail_beauty', 'L''Oreal', ARRAY['L''Oréal','LOreal','L Oreal'], 2),
    ('retail_beauty', 'Hot Tools', ARRAY['Hot Tools Professional'], 3),
    ('retail_beauty', 'Drybar', ARRAY[]::text[], 4),
    ('retail_beauty', 'Dyson', ARRAY[]::text[], 5),
    ('retail_beauty', 'Shark', ARRAY[]::text[], 6)
) AS b(category_slug, brand_name, aliases, sort_order) ON b.category_slug = c.slug
ON CONFLICT DO NOTHING;

-- Live per-brand search progress for Phase 1's curated discovery pass —
-- written incrementally as each brand resolves (lib/legacy-brand-discovery.ts's
-- onBrandProgress callback via lib/db/analyses.ts's updatePhase1BrandProgress),
-- polled by components/analyze/ProgressPanel.tsx via the existing
-- GET /api/analyses/[id] route WHILE the Phase 1 POST /continue call is
-- still in flight — this is what makes the brand panel genuinely live
-- without any new endpoint or websocket/SSE infrastructure.
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS phase1_brand_progress JSONB;

-- 14. MOTOR TAXONOMY + COMPETITOR MATCHING WEIGHTS
-- Admin-editable motor-type families competitor selection now matches on
-- (lib/motor-taxonomy.ts) — mirrors legacy_brands/brand_categories's exact
-- dual-path CRUD pattern. `modifier=true` rows (e.g. "brushless") combine
-- with a non-modifier family rather than competing as their own family
-- (e.g. "brushless rotary") — never matched as a family on their own.
-- `adjacent_families` is a self-referencing array of other rows' family_key
-- (not a FK — simpler for a small, rarely-changed admin list) used for
-- "adjacent family" partial-credit scoring (lib/competitor-scoring.ts).
CREATE TABLE IF NOT EXISTS motor_families (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    family_key VARCHAR(50) UNIQUE NOT NULL,
    label VARCHAR(255) NOT NULL,
    domain VARCHAR(30) NOT NULL, -- 'clipper_trimmer_shaver' | 'beauty'
    aliases TEXT[] DEFAULT '{}'::text[],
    modifier BOOLEAN NOT NULL DEFAULT false,
    adjacent_families TEXT[] DEFAULT '{}'::text[],
    enabled BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE motor_families ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for motor_families" ON motor_families FOR ALL USING (true) WITH CHECK (true);

INSERT INTO motor_families (family_key, label, domain, aliases, modifier, adjacent_families, sort_order) VALUES
    ('rotary', 'Rotary', 'clipper_trimmer_shaver', ARRAY['rotary motor'], false, ARRAY[]::text[], 0),
    ('magnetic_vector', 'Magnetic / Vector', 'clipper_trimmer_shaver', ARRAY['electromagnetic','vector','magnetic'], false, ARRAY['pivot','linear'], 1),
    ('pivot', 'Pivot', 'clipper_trimmer_shaver', ARRAY['pivot motor'], false, ARRAY['magnetic_vector'], 2),
    ('linear', 'Linear', 'clipper_trimmer_shaver', ARRAY['linear magnetic'], false, ARRAY['magnetic_vector'], 3),
    ('ac_motor', 'AC Motor', 'beauty', ARRAY['ac motor'], false, ARRAY[]::text[], 4),
    ('dc_motor', 'DC Motor', 'beauty', ARRAY['dc motor'], false, ARRAY[]::text[], 5),
    ('brushless_digital', 'Brushless Digital', 'beauty', ARRAY['brushless digital motor','digital motor'], false, ARRAY[]::text[], 6),
    ('brushless', 'Brushless (modifier)', 'clipper_trimmer_shaver', ARRAY['brushless dc','bldc','brushless'], true, ARRAY[]::text[], 7)
ON CONFLICT (family_key) DO NOTHING;

-- Singleton config row for the composite-score weights
-- (lib/competitor-scoring.ts's computeCompositeScore) — admin-editable at
-- /dashboard/admin/competitor-matching without a deploy. No generic
-- settings/config table existed anywhere in this schema before this; a
-- dedicated small table (rather than a KV blob) matches this file's
-- existing preference for explicit typed columns.
CREATE TABLE IF NOT EXISTS competitor_matching_config (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    motor_weight NUMERIC(4,3) NOT NULL DEFAULT 0.45,
    price_weight NUMERIC(4,3) NOT NULL DEFAULT 0.35,
    feature_weight NUMERIC(4,3) NOT NULL DEFAULT 0.20,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE competitor_matching_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for competitor_matching_config" ON competitor_matching_config FOR ALL USING (true) WITH CHECK (true);
INSERT INTO competitor_matching_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 15. FAQ / HELP CENTER
-- Content lives in lib/faq-seed-data.ts (a plain TS array), NOT duplicated
-- as raw SQL here — FAQ answers are long free-text prose with apostrophes/
-- quotes/markdown, a much higher escaping-risk content type than the short
-- brand/motor-family string arrays seeded directly in SQL elsewhere in this
-- file. Run `npx tsx scripts/seed-faqs.ts` once after this table exists to
-- load the real content (idempotent — safe to re-run after editing the
-- source array). `sort_order` is the priority WITHIN its category (the
-- left-sidebar category order itself is a fixed list in code,
-- lib/faq-seed-data.ts's FAQ_CATEGORIES, not derived from this table).
CREATE TABLE IF NOT EXISTS faqs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category VARCHAR(100) NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL, -- light markdown: **bold**, `code`, "- "/"1. " lists
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS faqs_category_sort_idx ON faqs(category, sort_order);
ALTER TABLE faqs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for faqs" ON faqs FOR ALL USING (true) WITH CHECK (true);

-- One row per vote (not an aggregate counter column) — avoids increment
-- race conditions and keeps a real audit trail, matching this app's
-- general "insert a row, never mutate a counter in place" preference
-- (e.g. product_snapshots). Anonymous — no user identification required,
-- just aggregate counts for the admin view.
CREATE TABLE IF NOT EXISTS faq_votes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    faq_id UUID REFERENCES faqs(id) ON DELETE CASCADE NOT NULL,
    vote VARCHAR(10) NOT NULL CHECK (vote IN ('up', 'down')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS faq_votes_faq_idx ON faq_votes(faq_id);
ALTER TABLE faq_votes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for faq_votes" ON faq_votes FOR ALL USING (true) WITH CHECK (true);

-- One row per zero-result search — lets admins see what people searched
-- for and couldn't find, to grow the FAQ where users actually get stuck
-- (Part 3's explicit ask).
CREATE TABLE IF NOT EXISTS faq_search_misses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    term VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE faq_search_misses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for faq_search_misses" ON faq_search_misses FOR ALL USING (true) WITH CHECK (true);

-- Tracks dismissal of the first-login "New here? Read the Getting Started
-- FAQ" banner (Part 1's onboarding hook) — persists across devices/sessions
-- rather than a localStorage-only flag, and doubles as "has this user seen
-- the FAQ at all" for admins. NULL = never dismissed = still shows the banner.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS faq_banner_dismissed_at TIMESTAMP WITH TIME ZONE;

-- 16. CONTACT SUPPORT
-- Optional screenshot binary lives in the public Supabase Storage bucket
-- "support-screenshots" (create it manually in the Supabase dashboard, same
-- as "deck-templates"/"artwork" — Storage buckets aren't SQL objects).
-- screenshot_url stores the bucket's permanent public URL, matching the
-- existing "artwork" bucket's getPublicUrl() convention (not a signed URL,
-- which would expire and break the record for admins reviewing it later).
--
-- Persistence-first design: a row is inserted here BEFORE any email send is
-- attempted (see app/api/support/contact/route.ts) — a mail-provider hiccup
-- must never lose a message. email_status/email_error track the admin
-- notification email; ack_email_status tracks the separate best-effort
-- "we got your message" reply to the submitter. admin_notification_read
-- doubles as the in-app "unread support message" flag the Topbar bell polls
-- — no separate notifications table needed for this single event type.
CREATE TABLE IF NOT EXISTS support_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    topic VARCHAR(30) NOT NULL, -- 'bug' | 'question' | 'data_wrong' | 'feature_request' | 'other'
    message TEXT NOT NULL,
    context JSONB,
    screenshot_url TEXT,
    email_status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'failed'
    email_error TEXT,
    ack_email_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    admin_notification_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS support_messages_created_idx ON support_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS support_messages_identity_idx ON support_messages(user_id, created_at);
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for support_messages" ON support_messages FOR ALL USING (true) WITH CHECK (true);

-- 17. CRITICAL SECURITY FIX — lock down RLS on every table
-- Every table above was created with `FOR ALL USING (true) WITH CHECK (true)`
-- — fully permissive to ANY caller, including the public/anon Supabase key.
-- Since NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are (by
-- Next.js's own NEXT_PUBLIC_ convention, and by Supabase's design) shipped
-- in the browser bundle, this meant literally anyone on the internet could
-- read/write EVERY row of EVERY table directly via the Supabase REST API —
-- profiles (every user's email/role), support_messages, all project/GTM/TDS
-- data — by lifting the anon key out of the client bundle, completely
-- bypassing this app's own authentication and authorization entirely.
-- Empirically confirmed exploitable (2026-07-27): an unauthenticated GET
-- with only the anon key returned real rows from profiles, support_messages,
-- projects, and document_fields.
--
-- The fix is safe with ZERO functional impact: every server-side query in
-- this app already goes through `supabaseAdmin` (the SERVICE ROLE key, in
-- lib/supabase.ts), which bypasses RLS entirely regardless of policy — RLS
-- policies here have never actually protected anything the app relies on.
-- The only other Supabase clients in this app (lib/supabase-browser.ts,
-- lib/supabase-server.ts) are used exclusively for `.auth.*` (login/session)
-- and `.storage.*` (signed upload URLs) — never a single `.from(table)`
-- call anywhere outside standalone scripts/*.ts maintenance scripts, which
-- all construct their own service-role client independent of these policies.
--
-- Dropping every permissive policy while RLS stays ENABLED makes Postgres
-- deny ALL access by default for the `anon`/`authenticated` roles — exactly
-- what's wanted, since this app has no legitimate use case for a real user's
-- own Supabase session JWT to query a table directly. Run this in the
-- Supabase SQL editor immediately; it is safe to run before, with, or after
-- any other pending schema change in this file.
DROP POLICY IF EXISTS "Allow all operations for projects" ON projects;
DROP POLICY IF EXISTS "Allow all operations for analyses" ON analyses;
DROP POLICY IF EXISTS "Allow all operations for amazon_cache" ON amazon_cache;
DROP POLICY IF EXISTS "Allow all operations for reports" ON reports;
DROP POLICY IF EXISTS "Allow all operations for competitors" ON competitors;
DROP POLICY IF EXISTS "Allow all operations for analysis_competitors" ON analysis_competitors;
DROP POLICY IF EXISTS "Allow all operations for project_outputs" ON project_outputs;
DROP POLICY IF EXISTS "Allow all operations for documents" ON documents;
DROP POLICY IF EXISTS "Allow all operations for document_fields" ON document_fields;
DROP POLICY IF EXISTS "Allow all operations for document_field_history" ON document_field_history;
DROP POLICY IF EXISTS "Allow all operations for product_snapshots" ON product_snapshots;
DROP POLICY IF EXISTS "Allow all operations for project_generation_state" ON project_generation_state;
DROP POLICY IF EXISTS "Allow all operations for analysis_tasks" ON analysis_tasks;
DROP POLICY IF EXISTS "Allow all operations for provider_circuit_state" ON provider_circuit_state;
DROP POLICY IF EXISTS "Allow all operations for profiles" ON profiles;
DROP POLICY IF EXISTS "Allow all operations for section_provenance" ON section_provenance;
DROP POLICY IF EXISTS "Allow all operations for deck_templates" ON deck_templates;
DROP POLICY IF EXISTS "Allow all operations for project_decks" ON project_decks;
DROP POLICY IF EXISTS "Allow all operations for brand_categories" ON brand_categories;
DROP POLICY IF EXISTS "Allow all operations for legacy_brands" ON legacy_brands;
DROP POLICY IF EXISTS "Allow all operations for motor_families" ON motor_families;
DROP POLICY IF EXISTS "Allow all operations for competitor_matching_config" ON competitor_matching_config;
DROP POLICY IF EXISTS "Allow all operations for faqs" ON faqs;
DROP POLICY IF EXISTS "Allow all operations for faq_votes" ON faq_votes;
DROP POLICY IF EXISTS "Allow all operations for faq_search_misses" ON faq_search_misses;
DROP POLICY IF EXISTS "Allow all operations for support_messages" ON support_messages;
-- (All 26 tables now have RLS enabled with zero policies — anon/authenticated
-- get zero rows on every operation; supabaseAdmin/service-role is unaffected.)

-- 18. AUTH EVENTS — audit log + login rate-limiting
-- Real sign-in happens server-side now (app/api/auth/login/route.ts,
-- app/api/auth/forgot-password/route.ts) specifically so this table can
-- both rate-limit (count recent 'login_failure' rows for an email+ip
-- pair) AND serve as the security-relevant audit log Section 9 asks for
-- (logins, failed logins, permission denials, admin changes). One row per
-- event, never mutated — same "insert, never mutate a counter" precedent
-- as every other event-log table in this app (faq_votes, product_snapshots).
CREATE TABLE IF NOT EXISTS auth_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(40) NOT NULL, -- 'login_success' | 'login_failure' | 'password_change' | 'password_reset_requested' | 'permission_denied' | 'admin_change'
    email VARCHAR(255),
    user_id UUID,
    ip_address VARCHAR(64),
    user_agent TEXT,
    detail TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_events_rate_limit_idx ON auth_events(email, ip_address, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_events_created_idx ON auth_events(created_at DESC);
ALTER TABLE auth_events ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policy (see Section 17 above) — only supabaseAdmin
-- (service role) ever reads/writes this table.

-- 19. STRICT TOOL-TYPE ISOLATION — a project's tool type (clipper/trimmer/
-- shaver/etc., see lib/tool-type-taxonomy.ts) is a real, persisted column
-- rather than living only in the free-text `category` field, so it's
-- reused consistently every time an analysis is (re)run from this project
-- — the same pattern price_point/motor_tech/key_diff above already
-- establish. NULL means "not yet selected" (analyses created against a
-- project from before this column existed) — never a silent guess.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tool_type VARCHAR(30);

-- 20. FEATURE FLAGS — TDS disabled (config-driven, reversible)
-- Keyed by flag_name (not a single fixed-id row like
-- competitor_matching_config) since more flags may follow. Read/write via
-- lib/db/feature-flags.ts; lib/feature-flags.ts's isTdsEnabled() falls back
-- to the TDS_ENABLED env var when no row exists at all (a fresh DB that
-- hasn't run this migration yet still behaves correctly).
CREATE TABLE IF NOT EXISTS feature_flags (
    flag_name VARCHAR(50) PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
INSERT INTO feature_flags (flag_name, enabled) VALUES ('tds_enabled', true) ON CONFLICT (flag_name) DO NOTHING;
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policy (see Section 17 above) — only supabaseAdmin
-- (service role) ever reads/writes this table.

-- TDS is being disabled app-wide — the 2 TDS-category FAQ entries
-- (lib/faq-seed-data.ts) auto-hide via this column rather than a one-time
-- manual `enabled=false` toggle that would need to be remembered and
-- reversed by hand when the flag is flipped back on. NULL means "not tied
-- to any feature" (every other FAQ row).
ALTER TABLE faqs ADD COLUMN IF NOT EXISTS feature VARCHAR(50);
UPDATE faqs SET feature = 'tds' WHERE category = 'TDS' AND feature IS NULL;

-- 21. MOTOR TECH SEARCH MISSES — logs a free-text "Motor Technology" entry
-- (analyze/new-project forms) that didn't match any enabled motor_families
-- row, so the taxonomy admin (/dashboard/admin/competitor-matching) can see
-- real-world motor names worth adding as a new family/alias. Read/write via
-- lib/db/motor-families.ts's logMotorTechMiss/getMotorTechMisses — exact
-- same shape as faq_search_misses (Section 15).
CREATE TABLE IF NOT EXISTS motor_tech_search_misses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    term VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS motor_tech_search_misses_created_idx ON motor_tech_search_misses(created_at DESC);
ALTER TABLE motor_tech_search_misses ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policy (see Section 17 above) — only supabaseAdmin
-- (service role) ever reads/writes this table.

-- 22. LEGACY BRAND OFFICIAL DOMAINS — a brand's own official website
-- domain(s) (e.g. "wahlpro.com"), searched FIRST by
-- lib/brand-site-discovery.ts, before Amazon, so a legacy pro product
-- that isn't sold on Amazon at all can still become a real competitor.
-- Admin-editable at /dashboard/admin/legacy-brands alongside aliases.
-- NULL/empty means "no known domain yet" — that brand's discovery simply
-- skips the brand-site pass and falls through to Amazon only, same as
-- today's behavior.
ALTER TABLE legacy_brands ADD COLUMN IF NOT EXISTS official_domains TEXT[] DEFAULT '{}'::text[];

-- 23. FEATURE FLAGS — Recent Buyer Sentiment & News Updates disabled BY
-- DEFAULT (config-driven, reversible — same mechanism as Section 20's TDS
-- flag, but these two default OFF since the whole point is to remove the
-- sections, not just make them toggleable). Reuses the existing
-- feature_flags table — no new table/column needed. If you already ran an
-- earlier version of this section that inserted these rows as `true`, run
-- this once by hand to correct them (ON CONFLICT DO NOTHING won't touch an
-- existing row):
--   UPDATE feature_flags SET enabled = false WHERE flag_name IN ('buyer_sentiment_enabled', 'news_updates_enabled');
INSERT INTO feature_flags (flag_name, enabled) VALUES
    ('buyer_sentiment_enabled', false),
    ('news_updates_enabled', false)
ON CONFLICT (flag_name) DO NOTHING;

-- The one existing FAQ entry mentioning Buyer Sentiment was split in
-- lib/faq-seed-data.ts into an untagged Strengths/Weaknesses entry and a
-- new entry tagged feature='buyer_sentiment' directly in the seed data
-- (unlike Section 20's TDS backfill, there's no pre-existing row to
-- retrofit here — re-run scripts/seed-faqs.ts to pick up the new entry).

-- 24. BRANDED MOTOR NAMES — a brand's own proprietary marketing name for a
-- motor (e.g. "IN3" -> the vector family). Deliberately its OWN table, not
-- more motor_families.aliases entries: aliases there are a single GLOBAL
-- namespace matched regardless of brand (lib/motor-taxonomy.ts's
-- matchMotorFamily), so adding a proprietary term like "IN3" there would
-- wrongly match every other brand's product containing that string too.
-- Admin-editable at /dashboard/admin/competitor-matching alongside the
-- existing motor-family taxonomy. Starts empty — real usage data, not a
-- pre-seeded default (same precedent as legacy_brands.official_domains).
CREATE TABLE IF NOT EXISTS branded_motor_names (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    brand_name VARCHAR(255) NOT NULL,
    branded_term VARCHAR(255) NOT NULL,
    family_key VARCHAR(50) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE branded_motor_names ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for branded_motor_names" ON branded_motor_names FOR ALL USING (true) WITH CHECK (true);

-- 25. CANONICAL 7-FAMILY MOTOR TAXONOMY — one-time restructure of the 8
-- families Section (motor_families' original seed) into exactly 7 fixed
-- canonical families used everywhere motor type enters the system (form,
-- extraction, matching, display, GTM/TDS): Magnetic, Pivot, Rotary,
-- Brushless, Vector, AC, DC Motor. Idempotent/safely re-runnable — every
-- statement is keyed by family_key and guarded so running this twice is a
-- no-op the second time.
--
-- (a) Promote "brushless" from a modifier to a standalone family, merging
-- in "brushless_digital"'s aliases (now redundant, disabled below) plus the
-- new canonical branded-name aliases.
UPDATE motor_families
SET label = 'Brushless Motor',
    modifier = false,
    aliases = ARRAY['brushless','bldc','brushless dc','digital brushless','eon digital brushless','digital motor','brushless digital motor'],
    adjacent_families = '{}'::text[]
WHERE family_key = 'brushless';
UPDATE motor_families SET enabled = false WHERE family_key = 'brushless_digital';

-- (b) Split "magnetic_vector" into two standalone families: rename the
-- existing row to "vector" (keeps its history/id), insert a new "magnetic"
-- row. The spec's own alias list has "electromagnetic" under both —
-- resolved by giving Vector the more specific "electromagnetic vector"
-- phrase and Magnetic the bare "electromagnetic", matching
-- matchMotorFamily's first-match-wins alias order.
UPDATE motor_families
SET family_key = 'vector',
    label = 'Vector Motor',
    aliases = ARRAY['vector','in3','electromagnetic vector'],
    adjacent_families = '{}'::text[]
WHERE family_key = 'magnetic_vector';
INSERT INTO motor_families (family_key, label, domain, aliases, modifier, adjacent_families, sort_order)
VALUES ('magnetic', 'Magnetic Motor', 'clipper_trimmer_shaver', ARRAY['magnetic','electromagnetic'], false, ARRAY[]::text[], 8)
ON CONFLICT (family_key) DO NOTHING;

-- (c) Fold "linear" into Pivot Motor (mechanically closest — both
-- non-rotary reciprocating drives) rather than keeping it as a 7th active
-- family; disable the standalone row so existing references aren't lost,
-- just no longer independently matched.
UPDATE motor_families
SET label = 'Pivot Motor',
    aliases = ARRAY['pivot','pivot motor','linear','linear magnetic'],
    adjacent_families = '{}'::text[]
WHERE family_key = 'pivot';
UPDATE motor_families SET enabled = false WHERE family_key = 'linear';

-- (d) Canonical relabeling + no-adjacency default for the two families
-- untouched by (a)-(c).
UPDATE motor_families SET label = 'Rotary Motor', aliases = ARRAY['rotary','rotary motor'], adjacent_families = '{}'::text[] WHERE family_key = 'rotary';
UPDATE motor_families SET label = 'AC Motor', aliases = ARRAY['ac motor','ac','alternating current'], adjacent_families = '{}'::text[] WHERE family_key = 'ac_motor';
UPDATE motor_families SET label = 'DC Motor', aliases = ARRAY['dc motor','dc','direct current'], adjacent_families = '{}'::text[] WHERE family_key = 'dc_motor';

-- 26. CANONICAL MOTOR FIELDS ON PROJECTS — additive columns for the
-- analyze/new-project forms' Motor Type select (lib/validations.ts's
-- MOTOR_FAMILY_VALUES). motor_family is always one of the 7 canonical
-- family_key values from motor_families above; motor_branded_name is the
-- optional, display-only marketing name typed alongside it (e.g. "EON
-- Digital Brushless Motor") — matching/grounding always uses motor_family,
-- never this. The old free-text motor_tech column is untouched and kept
-- for backward compatibility — old projects/analyses created before this
-- select existed keep reading back correctly (lib/motor-extraction.ts's
-- resolveOurMotorType falls back to fuzzy-matching motor_tech only when
-- motor_family is absent).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS motor_family VARCHAR(50);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS motor_branded_name VARCHAR(150);

-- 27. BRANDED MOTOR MISS COLUMNS — extends Section 21's
-- motor_tech_search_misses (rather than a new table) so a competitor's
-- unrecognized brand-proprietary motor phrase (e.g. scraped listing text
-- mentioning a made-up marketing name that matched neither the generic
-- taxonomy nor the branded map) can be logged and surfaced on
-- /dashboard/admin/competitor-matching for one-click addition to
-- branded_motor_names (Section 24), same as a plain unmatched motorTech
-- entry already is. brand_name/ai_guessed_family are NULL for the original
-- plain-motorTech-miss use case — only populated by the new
-- logBrandedMotorMiss path (lib/db/motor-families.ts). ai_guessed_family is
-- filled lazily by an admin-triggered "Classify with AI" batch action
-- (app/api/admin/motor-families/branded-misses/route.ts), never
-- automatically during analysis — keeps this off the analysis pipeline's
-- hot path entirely.
ALTER TABLE motor_tech_search_misses ADD COLUMN IF NOT EXISTS brand_name VARCHAR(255);
ALTER TABLE motor_tech_search_misses ADD COLUMN IF NOT EXISTS ai_guessed_family VARCHAR(50);

-- 28. TOOL TYPES — migrates Tool Type from a fixed compile-time TypeScript
-- union (lib/tool-type-taxonomy.ts) to the same admin/user-editable,
-- DB-backed shape motor_families already uses, so a new tool category
-- (e.g. a launched "Foil Shaper" line) can be added inline on the analyze/
-- new-project forms without a code deploy. `family` mirrors
-- motor_families.domain's two values ('clipper_trimmer_shaver' | 'beauty')
-- and drives which Industry a type appears under (lib/tool-type-taxonomy.ts's
-- toolTypesForIndustry) — NULL means valid under EITHER industry (only
-- "combo" uses this, since a multi-tool kit can combine either domain).
-- `custom` distinguishes a user/admin-added type from the 9 shipped
-- defaults — custom types get identical strict-matching treatment via
-- their own `aliases`, never weaker isolation than a built-in.
CREATE TABLE IF NOT EXISTS tool_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type_key VARCHAR(50) UNIQUE NOT NULL,
    label VARCHAR(255) NOT NULL,
    aliases TEXT[] NOT NULL DEFAULT '{}',
    family VARCHAR(30),
    enabled BOOLEAN NOT NULL DEFAULT true,
    custom BOOLEAN NOT NULL DEFAULT false,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE tool_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for tool_types" ON tool_types FOR ALL USING (true) WITH CHECK (true);

INSERT INTO tool_types (type_key, label, aliases, family, sort_order) VALUES
    ('trimmer', 'Trimmer', ARRAY['trimmer','beard trimmer','detailer','outliner','liner','edger'], 'clipper_trimmer_shaver', 0),
    ('shaver', 'Shaver', ARRAY['shaver','foil shaver','rotary shaver','electric shaver','razor'], 'clipper_trimmer_shaver', 1),
    ('dryer', 'Hair Dryer', ARRAY['dryer','blow dryer','diffuser'], 'beauty', 2),
    ('flat_iron', 'Flat Iron', ARRAY['flat iron','straightener','hair iron'], 'beauty', 3),
    ('curling_iron', 'Curling Iron', ARRAY['curling iron','curling wand','curler','wand'], 'beauty', 4),
    ('hot_brush', 'Hot Brush', ARRAY['hot brush','styling brush','heated brush'], 'beauty', 5),
    ('clipper', 'Clipper', ARRAY['clipper'], 'clipper_trimmer_shaver', 6),
    ('other_styling', 'Other Styling Tool', ARRAY[]::text[], 'beauty', 7),
    ('combo', 'Combo / Multi-Tool Kit', ARRAY[]::text[], NULL, 8)
ON CONFLICT (type_key) DO NOTHING;

-- 29. SCORING PROFILES — replaces the old singleton
-- competitor_matching_config (Section 16-ish, now deprecated/unused, kept
-- for history) with per-tool-type weight profiles. `type_key IS NULL` is
-- the global default/fallback row — used for any tool type (including
-- every custom one) with no row of its own. Weights are stored EXACTLY as
-- entered (no forced sum-to-1) — free-form relative-importance numbers;
-- normalization happens at use-time in lib/competitor-scoring.ts's
-- computeCompositeScore, never at write time, so the raw entered values
-- stay auditable (see matching_weights snapshot on analyses.phase1_result/
-- phase2_result). motor_weight/price_weight/feature_weight column names
-- are kept from the old table for continuity — motor_weight represents
-- whichever PRIMARY CRITERION applies for that tool type (Motor for
-- motorized types, Heat/Plate Technology for motorless ones per Section
-- 30's tool_types.primary_criterion column) — this avoids a signature
-- rename across the ~30 files that already pass a `{motor,price,feature}`
-- shaped weights object.
CREATE TABLE IF NOT EXISTS scoring_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type_key VARCHAR(50) UNIQUE,
    motor_weight NUMERIC(6,3) NOT NULL,
    price_weight NUMERIC(6,3) NOT NULL,
    feature_weight NUMERIC(6,3) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE scoring_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for scoring_profiles" ON scoring_profiles FOR ALL USING (true) WITH CHECK (true);

INSERT INTO scoring_profiles (type_key, motor_weight, price_weight, feature_weight) VALUES
    (NULL, 45, 35, 20),
    ('clipper', 45, 35, 20),
    ('trimmer', 45, 35, 20),
    ('shaver', 45, 35, 20),
    ('dryer', 35, 35, 30),
    ('flat_iron', 40, 35, 25),
    ('curling_iron', 40, 35, 25),
    ('hot_brush', 40, 35, 25)
ON CONFLICT (type_key) DO NOTHING;

-- 30. TOOL TYPE PRIMARY CRITERION — which evidence-backed criterion
-- dominates composite scoring for this type: 'motor' (the existing motor
-- taxonomy/extraction cascade), 'heat_technology' (the new parallel
-- plate/heat taxonomy — Section 31/32 — for motorless styling tools),
-- or 'none' (neither applies; that weight slot should be 0 in the type's
-- scoring_profiles row, letting price+features carry the full score via
-- computeCompositeScore's own normalization, no special-case code needed).
ALTER TABLE tool_types ADD COLUMN IF NOT EXISTS primary_criterion VARCHAR(30) NOT NULL DEFAULT 'motor';
UPDATE tool_types SET primary_criterion = 'motor' WHERE type_key IN ('clipper', 'trimmer', 'shaver', 'dryer');
UPDATE tool_types SET primary_criterion = 'heat_technology' WHERE type_key IN ('flat_iron', 'curling_iron', 'hot_brush');
UPDATE tool_types SET primary_criterion = 'none' WHERE type_key IN ('other_styling', 'combo');

-- 31. HEAT/PLATE TECHNOLOGY FAMILIES — a full parallel to motor_families
-- (Section 25) for motorless styling tools (flat iron/curling iron/hot
-- brush), minus the motor-specific `modifier`/`adjacent_families` concepts
-- (not needed here — match tiers are exact/different/unverified only, see
-- lib/heat-tech-taxonomy.ts's computeHeatTechMatchTier).
CREATE TABLE IF NOT EXISTS heat_tech_families (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    family_key VARCHAR(50) UNIQUE NOT NULL,
    label VARCHAR(255) NOT NULL,
    aliases TEXT[] NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE heat_tech_families ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for heat_tech_families" ON heat_tech_families FOR ALL USING (true) WITH CHECK (true);

INSERT INTO heat_tech_families (family_key, label, aliases, sort_order) VALUES
    ('titanium', 'Titanium', ARRAY['titanium', 'titanium plates', 'titanium-coated', 'titanium coated'], 0),
    ('ceramic', 'Ceramic', ARRAY['ceramic', 'ceramic plates', 'ceramic-coated', 'ceramic coated'], 1),
    ('tourmaline', 'Tourmaline', ARRAY['tourmaline', 'tourmaline plates', 'tourmaline-ceramic', 'tourmaline ceramic'], 2),
    ('ionic', 'Ionic', ARRAY['ionic', 'ion technology', 'negative ion'], 3)
ON CONFLICT (family_key) DO NOTHING;

-- 32. BRANDED HEAT/PLATE TECHNOLOGY NAMES — a full parallel to
-- branded_motor_names (Section 24): a brand's own proprietary plate/heat
-- marketing name (e.g. a fictional "NanoGlide Plates"), scoped to the one
-- brand that owns it, never a global alias.
CREATE TABLE IF NOT EXISTS branded_heat_tech_names (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    brand_name VARCHAR(255) NOT NULL,
    branded_term VARCHAR(255) NOT NULL,
    family_key VARCHAR(50) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE branded_heat_tech_names ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for branded_heat_tech_names" ON branded_heat_tech_names FOR ALL USING (true) WITH CHECK (true);

-- 33. COMPETITOR CORRECTIONS — a user manually replacing a wrongly-selected
-- competitor's ASIN, and WHY (lib/analysisEngine.ts's replaceCompetitor).
-- Append-only, real usage data (no seed rows). Feeds a learning loop for
-- future discovery runs (lib/db/competitor-corrections.ts): the SAME
-- (old_asin, reason) pair repeated across independent corrections becomes a
-- blocklist/penalty signal; new_asin from a "better_competitor" correction
-- becomes a preference signal, scoped by (tool_type, motor_family OR
-- heat_tech_family, price_band). heat_tech_family is a parallel column to
-- motor_family (Section 30's primary_criterion decides which one a given
-- tool type actually populates) — this table postdates the original spec
-- that only named motor_family, added here for the motorless criterion
-- introduced by Sections 29-32. expired_at (not a hard delete) lets an
-- admin turn a learned rule off while the row stays inspectable — "learning
-- must stay inspectable and reversible."
CREATE TABLE IF NOT EXISTS competitor_corrections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_id UUID REFERENCES analyses(id) ON DELETE SET NULL,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    tool_type VARCHAR(50) NOT NULL,
    motor_family VARCHAR(50),
    heat_tech_family VARCHAR(50),
    price_band VARCHAR(20),
    old_asin VARCHAR(20) NOT NULL,
    old_title VARCHAR(500),
    new_asin VARCHAR(20) NOT NULL,
    new_title VARCHAR(500),
    reason VARCHAR(30) NOT NULL,
    note TEXT,
    user_id VARCHAR(255),
    expired_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE competitor_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for competitor_corrections" ON competitor_corrections FOR ALL USING (true) WITH CHECK (true);

-- 34. STYLECRAFT PRODUCT CATALOG — our own product lineup, selectable at the
-- analyze form's initial stage to auto-fill every analysis field (name,
-- industry, target market, tool type, target price, description, motor/
-- heat-tech) instead of manual entry. Replaces the old hardcoded
-- lib/stylecraft-products.ts array (no admin management, no re-import path,
-- and three independently hand-duplicated fuzzy name-matching
-- implementations against it). heat_tech_family/heat_tech_branded are
-- parallel columns to motor_family/motor_branded (same sibling-column
-- precedent as Section 33's competitor_corrections) — a motorless styling
-- tool (flat iron/curling iron/hot brush/other_styling) populates the heat
-- pair instead, per tool_types.primary_criterion (Section 30). import_flags
-- carries admin-review badges ('incomplete', 'tool_type_needs_review',
-- 'motor_needs_confirmation', 'heat_tech_needs_confirmation') raised during
-- seed/re-import normalization — never a silent guess. active=false is a
-- soft-deactivate (never hard-deleted, same as legacy_brands.enabled).
CREATE TABLE IF NOT EXISTS catalog_products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(500) NOT NULL UNIQUE,
    industry VARCHAR(50) NOT NULL,
    target_market VARCHAR(20) NOT NULL,
    tool_type VARCHAR(50) NOT NULL,
    target_price NUMERIC(10,2),
    description TEXT,
    motor_family VARCHAR(50),
    motor_branded VARCHAR(255),
    heat_tech_family VARCHAR(50),
    heat_tech_branded VARCHAR(255),
    active BOOLEAN NOT NULL DEFAULT true,
    import_flags TEXT[] NOT NULL DEFAULT '{}',
    source VARCHAR(30) NOT NULL DEFAULT 'manual',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE catalog_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for catalog_products" ON catalog_products FOR ALL USING (true) WITH CHECK (true);

-- New heat_tech_families row for the Infared Curler (motorless, primary
-- criterion Heat Technology) — reuses Section 31's existing admin-editable
-- table rather than a new one.
INSERT INTO heat_tech_families (family_key, label, aliases, sort_order) VALUES
    ('infrared', 'Infrared', ARRAY['infrared', 'infrared technology'], 4)
ON CONFLICT (family_key) DO NOTHING;

-- New branded_motor_names rows (Section 24's table) for StyleCraft's own
-- proprietary motor marketing names, confirmed against the canonical
-- 7-family taxonomy (Section 25). "P.U.R.E Outrunner" maps to Brushless
-- (outrunner is a brushless architecture) — flagged here for a one-time
-- admin confirmation via a comment since it's an inferred mapping, not a
-- verbatim spec term like the other five. Section 24 never gave this table
-- a uniqueness constraint (it started empty, admin-added-only) — added here
-- so this INSERT is safely re-runnable.
CREATE UNIQUE INDEX IF NOT EXISTS branded_motor_names_brand_term_idx ON branded_motor_names (brand_name, branded_term);
INSERT INTO branded_motor_names (brand_name, branded_term, family_key, sort_order) VALUES
    ('StyleCraft', 'EON Digital Brushless', 'brushless', 0),
    ('StyleCraft', 'Digital Brushless', 'brushless', 1),
    ('StyleCraft', 'BLDC', 'brushless', 2),
    ('StyleCraft', 'Super Torque Rotary', 'rotary', 3),
    ('StyleCraft', 'Supercharged Rotary', 'rotary', 4),
    ('StyleCraft', 'P.U.R.E Outrunner', 'brushless', 5)
ON CONFLICT (brand_name, branded_term) DO NOTHING;

-- Seed: the 21 GTM-forms products (source='gtm_forms_import', the
-- authoritative spec — its own closing note says "22" but double-counts
-- Infared Curler, already row 1 of the same table; 21 is the real distinct
-- count) plus the deduped survivors of the old lib/stylecraft-products.ts
-- array (source='legacy_catalog_import') — zero name overlap was found
-- between the two sets by the same normalize+substring match
-- lib/our-product-position.ts already uses, so all 73 rows are distinct
-- products. Brushes/Apparel/Accessories categories from the
-- old array are deliberately excluded (no analyzable tool_type — plain
-- non-heated hairbrushes and merch/consumables have no motor or heat-tech
-- competitive angle), consistent with lib/tool-type-taxonomy.ts's
-- deriveToolTypeFromCatalogProduct already returning null for Apparel/
-- Accessories. Motor/heat-tech strings that don't resolve against the
-- canonical taxonomy above (e.g. "Super-Torque Motor" without the word
-- "Rotary", "Super C4RBN Motor") are seeded with a NULL family and
-- 'motor_needs_confirmation'/'heat_tech_needs_confirmation' in import_flags
-- rather than guessed — visible on the admin Product Catalog page for a
-- human to resolve. tool_type for the 4 legacy "combo set" rows (Rogue/
-- Super Set/Rebel/Protégé) is deliberately 'combo', not the 'clipper' that
-- deriveToolTypeFromCatalogProduct would mechanically produce from their
-- amazonCategory string "...Clipper Sets" (that string contains the bare
-- word "Clipper" but none of resolveToolType's COMBO_SIGNALS phrases) — a
-- 2-tool kit competing only in the standalone-clipper bucket would be
-- compared against single-tool products it doesn't actually compete with.
INSERT INTO catalog_products (name, industry, target_market, tool_type, target_price, description, motor_family, motor_branded, heat_tech_family, heat_tech_branded, import_flags, source) VALUES
('Infared Curler', 'haircare-styling', 'pro', 'curling_iron', NULL, NULL, NULL, NULL, 'infrared', 'Infrared Technology', '{}'::text[], 'gtm_forms_import'),
('Orange Saber II Clipper', 'grooming-barbering', 'pro', 'clipper', 299.95, 'EON Digital brushless motor up to 7,200rpm, Echo blade with shallow 2.0 cutter, full metal body', 'brushless', 'EON Digital Brushless', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Orange Saber Trimmer', 'grooming-barbering', 'pro', 'trimmer', 199.95, 'Digital brushless motor, full metal body, gold X-Pro wide blade with "The One" cutter', 'brushless', 'Digital Brushless', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Xceed Dryer', 'haircare-styling', 'pro', 'dryer', 299.95, NULL, NULL, NULL, NULL, NULL, ARRAY['incomplete']::text[], 'gtm_forms_import'),
('3versince Trimmer', 'grooming-barbering', 'pro', 'trimmer', 184.95, 'Hand-sharpened modified blade, super torque rotary motor up to 7,500 rpm, lightweight ergonomic rubber grip', 'rotary', 'Super Torque Rotary', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Anime Clipper', 'grooming-barbering', 'pro', 'clipper', 249.95, 'EON Digital brushless motor up to 7,800rpm, Echo taper blade with echo deep tooth cutter, ergonomic lightweight design', 'brushless', 'EON Digital Brushless', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Anime Trimmer', 'grooming-barbering', 'pro', 'trimmer', 199.95, 'EON Digital brushless motor up to 7,800rpm, X-Pro wide DLC blade with "The One" cutter, ergonomic lightweight design', 'brushless', 'EON Digital Brushless', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Alpha Up', 'grooming-barbering', 'pro', 'clipper', 159.95, 'Super torque rotary motor up to 7,200 rpm, enhanced build quality, DLC faper blade with slim deep tooth cutter', 'rotary', 'Super Torque Rotary', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Hitter Up', 'grooming-barbering', 'pro', 'trimmer', 119.95, 'Super torque rotary motor up to 6,500 rpm, enhanced build quality, DLC X-Pro wide blade with "The One" cutter', 'rotary', 'Super Torque Rotary', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Arbitrage Clipper', 'grooming-barbering', 'pro', 'clipper', 279.95, 'Outrunner motor up to 7,200rpm, intuitive torque control, full metal body, Echo blade with shallow 2.0 cutter', 'brushless', 'P.U.R.E Outrunner', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Retro Dryer', 'haircare-styling', 'consumer', 'dryer', 139.95, NULL, NULL, NULL, NULL, NULL, ARRAY['incomplete']::text[], 'gtm_forms_import'),
('Multistyler', 'haircare-styling', 'consumer', 'dryer', 189.95, NULL, NULL, NULL, NULL, NULL, ARRAY['incomplete','tool_type_needs_review']::text[], 'gtm_forms_import'),
('Smarty Dryer', 'haircare-styling', 'consumer', 'dryer', 179.95, NULL, 'brushless', 'BLDC', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Homie Dryer', 'haircare-styling', 'consumer', 'dryer', 129.95, NULL, NULL, NULL, NULL, NULL, ARRAY['incomplete']::text[], 'gtm_forms_import'),
('Daymond John Clipper', 'grooming-barbering', 'both', 'clipper', 99.95, 'Supercharged rotary motor, adjustable speeds up to 7,000/8,000/9,000 rpm, smart LED display, full metal body', 'rotary', 'Supercharged Rotary', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Daymond John Trimmer', 'grooming-barbering', 'both', 'trimmer', 79.95, 'Supercharged rotary motor, adjustable speeds up to 7,000/8,000/9,000 rpm, smart LED display, full metal body', 'rotary', 'Supercharged Rotary', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Daymond John Shaver', 'grooming-barbering', 'both', 'shaver', 79.95, 'Supercharged rotary motor, adjustable speeds up to 7,000/8,000/9,000 rpm, smart LED display, full metal body', 'rotary', 'Supercharged Rotary', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Red Saber II Clipper', 'grooming-barbering', 'pro', 'clipper', 299.95, 'EON Digital brushless motor up to 7,200rpm, Echo blade with shallow 2.0 cutter, full metal body', 'brushless', 'EON Digital Brushless', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Red Saber Trimmer', 'grooming-barbering', 'pro', 'trimmer', 199.95, 'Digital brushless motor, full metal body, gold X-Pro wide blade with "The One" cutter', 'brushless', 'Digital Brushless', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Protege 2 Clipper', 'grooming-barbering', 'pro', 'clipper', 89.95, 'Super torque rotary motor up to 7,200 rpm, enhanced build quality, stainless steel faper blade with DLC slim deep tooth cutter', 'rotary', 'Super Torque Rotary', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Protege 2 Trimmer', 'grooming-barbering', 'pro', 'trimmer', 79.95, 'Super torque rotary motor up to 6,500 rpm, enhanced build quality, stainless steel X-Pro wide blade with DLC "The One" cutter', 'rotary', 'Super Torque Rotary', NULL, NULL, '{}'::text[], 'gtm_forms_import'),
('Saber 2 Professional Hair Clipper with EON Digital Brushless Motor', 'grooming-barbering', 'pro', 'clipper', 319.95, 'Professional cordless modular hair clipper with EON Digital Brushless Motor. High torque, premium performance for professional barbers. Available in Gold and Black finishes.', 'brushless', 'EON Digital Brushless Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('S|C x 360 Jeezy Professional Hair Clipper with IN2 Vector Motor', 'grooming-barbering', 'pro', 'clipper', 299.95, 'Signature artist-collaboration clipper with the IN2 Vector Motor — limited-run professional cordless clipper.', 'vector', 'IN2 Vector Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Instinct Metal Professional Hair Clipper with IN2 Vector Motor', 'grooming-barbering', 'pro', 'clipper', 299.95, 'Professional hair clipper with IN2 Vector Motor. Intelligent torque control adjusts power automatically. All-metal construction.', 'vector', 'IN2 Vector Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Instinct Professional Hair Clipper with IN2 Vector Motor', 'grooming-barbering', 'pro', 'clipper', 269.95, 'Professional cordless hair clipper with the IN2 Vector Motor and intuitive torque control, in a lightweight polymer body.', 'vector', 'IN2 Vector Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Reign Professional Hair Clipper with EON Digital Brushless Motor', 'grooming-barbering', 'pro', 'clipper', 229.95, 'Reign Professional Hair Clipper with EON Digital Brushless Motor. Conquer every style. Available in standard and Purple finishes.', 'brushless', 'EON Digital Brushless Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Rebel 2.0 Professional Hair Clipper with Super C4RBN Motor', 'grooming-barbering', 'pro', 'clipper', 199.95, 'Rebel 2.0 Professional Hair Clipper with Super C4RBN Motor. Rebel with a cause — for barbers who demand more.', NULL, 'Super C4RBN Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('S|C x United by Short Hair — Rogue Clipper Collab', 'grooming-barbering', 'pro', 'clipper', 149.95, 'Limited-run Rogue clipper collaboration with United by Short Hair, sold exclusively through the UBSH channel.', 'magnetic', '9V Microchipped Magnetic Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Rogue Professional Hair Clipper with Microchipped Magnetic Motor', 'grooming-barbering', 'pro', 'clipper', 129.95, 'Rogue Professional Hair Clipper with 9V Microchipped Magnetic Motor. Embrace the unconventional.', 'magnetic', '9V Microchipped Magnetic Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Ergo Professional Hair Clipper with Microchipped Magnetic Motor', 'grooming-barbering', 'pro', 'clipper', 129.95, 'Ergo Professional Hair Clipper with a linear microchipped magnetic motor, built for an ergonomic in-hand feel during long shifts.', 'magnetic', 'Microchipped Magnetic Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Solecito Professional Hair Clipper with Powerful Rotary Motor', 'grooming-barbering', 'both', 'clipper', 109.95, 'Solecito Professional Hair Clipper with Powerful Rotary Motor — professional rotary performance at a mid-tier price.', 'rotary', 'Powerful Rotary Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Rival Metal Hair Clipper with Digital Display', 'grooming-barbering', 'both', 'clipper', 59.95, 'Rival Metal Hair Clipper with Digital Display. All-metal construction with digital battery indicator.', 'brushless', 'Digital Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('ACE Cordless Hair Clipper with Rotary Motor', 'grooming-barbering', 'consumer', 'clipper', 69.95, 'ACE Cordless Hair Clipper with Rotary Motor. Entry-level professional clipper, frequently discounted.', 'rotary', 'Rotary Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Instinct Metal Professional Hair Trimmer with IN2 Vector Motor', 'grooming-barbering', 'pro', 'trimmer', 239.95, 'Instinct Metal Professional Hair Trimmer with IN2 Vector Motor and intelligent torque control in an all-metal body.', 'vector', 'IN2 Vector Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Saber Professional Hair Trimmer with Digital Brushless Motor', 'grooming-barbering', 'pro', 'trimmer', 209.95, 'Saber Professional Hair Trimmer with Digital Brushless Motor. High energy, low vibration. Best seller. Available in Gold and Black.', 'brushless', 'Digital Brushless Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Precision Saber Professional Hair Trimmer with Digital Brushless Motor', 'grooming-barbering', 'pro', 'trimmer', 209.95, 'Precision variant of the Saber trimmer line with a full-metal body and Digital Brushless Motor, tuned for detail line-up work.', 'brushless', 'Digital Brushless Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Instinct Professional Hair Trimmer with IN2 Vector Motor', 'grooming-barbering', 'pro', 'trimmer', 179.95, 'Instinct Professional Hair Trimmer with IN2 Vector Motor and intuitive torque control in a lightweight polymer body.', 'vector', 'IN2 Vector Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Rebel Professional Hair Trimmer with Super-Torque Motor', 'grooming-barbering', 'pro', 'trimmer', 139.95, 'Rebel Professional Hair Trimmer with a modular Super-Torque Motor for detail and outline work.', NULL, 'Super-Torque Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Flex Professional Hair Trimmer with Super-Torque Motor', 'grooming-barbering', 'pro', 'trimmer', 129.95, 'Flex Professional Hair Trimmer with Super-Torque Motor, the trimmer half of the Super Set combo.', NULL, 'Super-Torque Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Reign Professional Hair Trimmer with EON Digital Brushless Motor', 'grooming-barbering', 'pro', 'trimmer', 189.95, 'Reign Professional Hair Trimmer with EON Digital Brushless Motor. Available in standard and Purple finishes.', 'brushless', 'EON Digital Brushless Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Ace Hair Trimmer with Rotary Motor', 'grooming-barbering', 'consumer', 'trimmer', 59.95, 'Ace Hair Trimmer with Rotary Motor, USB-C rechargeable with 3 guide combs and stainless steel blades.', 'rotary', 'Rotary Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Ace Body Buzzer Hair Trimmer with Supercharged Rotary Motor', 'grooming-barbering', 'consumer', 'trimmer', 59.95, 'Ace Body Buzzer Hair Trimmer with Supercharged Rotary Motor, purpose-built for body grooming.', 'rotary', 'Supercharged Rotary Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Homie Nano Trimmer', 'grooming-barbering', 'consumer', 'trimmer', 54.95, 'Homie Nano Trimmer — compact, portable, precise trimming for home use.', NULL, 'Nano Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Ace Beard Blender Hair Trimmer with Supercharged Rotary Motor', 'grooming-barbering', 'consumer', 'trimmer', 37.95, 'Ace Beard Blender Hair Trimmer with Supercharged Rotary Motor, designed for blending beard fades and edges.', 'rotary', 'Supercharged Rotary Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Schnozzle Water Resistant Nose and Ear Hair Trimmer', 'grooming-barbering', 'consumer', 'trimmer', 29.95, 'Schnozzle Water Resistant Nose and Ear Hair Trimmer in matte black.', NULL, 'Compact Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Ace 3-in-1 Rechargeable Multipurpose Hair Trimmer', 'grooming-barbering', 'consumer', 'trimmer', 29.95, 'Ace 3-in-1 Rechargeable Multipurpose Hair Trimmer. Versatile consumer trimmer for multiple uses.', NULL, 'Rechargeable Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Ace Electric Ear and Nose Hair Trimmer with Dual-Speed Motor', 'grooming-barbering', 'consumer', 'trimmer', 27.95, 'Ace Electric Ear and Nose Hair Trimmer with a Dual-Speed Motor for adjustable precision.', NULL, 'Dual-Speed Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Instinct Metal Professional Double Foil Shaver with IN2 Vector Motor', 'grooming-barbering', 'pro', 'shaver', 179.95, 'Instinct Metal Professional Double Foil Shaver with IN2 Vector Motor and a built-in micro-trimmer. Available in Black and Pink.', 'vector', 'IN2 Vector Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Rebel Professional Double Foil Shaver with Super-Torque Motor', 'grooming-barbering', 'pro', 'shaver', 84.95, 'Rebel Professional Double Foil Shaver with Super-Torque Motor and a gold titanium foil head.', NULL, 'Super-Torque Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Ace Waterproof Triple Foil Shaver with Integrated Pop-Up Trimmer', 'grooming-barbering', 'consumer', 'shaver', 74.95, 'Ace Waterproof Triple Foil Shaver with an integrated pop-up trimmer for edging.', 'rotary', 'Rotary Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Ace Bald Head 7X Foil Shaver with Supercharged Motor', 'grooming-barbering', 'consumer', 'shaver', 69.95, 'Ace Bald Head 7X Foil Shaver with a Supercharged Motor, purpose-built for close head shaves.', NULL, 'Supercharged Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Uno 2.0 Professional Single Foil Shaver with Supercharged Motor', 'grooming-barbering', 'both', 'shaver', 59.95, 'Uno 2.0 Professional Single Foil Shaver with Supercharged Motor and USB-C charging.', NULL, 'Supercharged Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Absolute Zero Professional Double Foil Shaver with Rotary Motor', 'grooming-barbering', 'both', 'shaver', 49.95, 'Absolute Zero Professional Double Foil Shaver with a built-in retractable trimmer.', 'rotary', 'Rotary Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Uno Professional Single Foil Shaver with Turbocharged Motor', 'grooming-barbering', 'both', 'shaver', 49.95, 'Uno Professional Single Foil Shaver with Turbocharged Motor, USB rechargeable and travel-sized. Available in Red.', NULL, 'Turbocharged Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Ace Single Foil Shaver with Built-in Trimmer', 'grooming-barbering', 'consumer', 'shaver', 37.95, 'Ace Single Foil Shaver with a built-in trimmer for touch-ups on the go.', NULL, 'Compact Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Rogue Combo Set - Professional Cordless Hair Clipper/Trimmer with 9V Magnetic Motor', 'grooming-barbering', 'pro', 'combo', 219.95, 'Rogue Combo Set with Clipper and Trimmer. 9V Microchipped Magnetic Motor. Best seller combo.', 'magnetic', '9V Magnetic Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Super Set - Rebel Cordless Hair Clipper & Flex Cordless Hair Trimmer Set with Super-Torque Rotary Motor', 'grooming-barbering', 'pro', 'combo', 199.95, 'Super Set pairing the Rebel Clipper and Flex Trimmer with a Super-Torque Rotary Motor, includes travel case.', 'rotary', 'Super-Torque Rotary Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Rebel Combo Set - Professional Cordless Hair Clipper/Hair Trimmer Set with Super-Torque Motor', 'grooming-barbering', 'pro', 'combo', 189.95, 'Rebel Combo Set with modular clipper and trimmer sharing a Super-Torque Motor platform.', NULL, 'Super-Torque Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Protégé Combo - Professional Cordless Hair Clipper/Hair Trimmer Combo with Turbocharged Rotary Motor', 'grooming-barbering', 'pro', 'combo', 179.95, 'Protégé Combo pairing a clipper and trimmer with a Turbocharged Rotary Motor in a matte metallic black finish.', 'rotary', 'Turbocharged Rotary Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Sage Professional Lightweight Hair Dryer with Digital LED Display', 'haircare-styling', 'pro', 'dryer', 199.95, 'Sage Professional Lightweight Hair Dryer with a Digital Brushless Motor and LED temperature display.', 'brushless', 'Digital Brushless Motor', NULL, NULL, '{}'::text[], 'legacy_catalog_import'),
('Sage 2-in-1 Diffuser & Hair Dryer with Ion Generator', 'haircare-styling', 'both', 'dryer', 99.95, 'Sage 2-in-1 Diffuser & Hair Dryer with Ion Generator. Style with wisdom, shine with confidence.', NULL, 'Ion Generator Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Stay-Temp Professional Hair Dryer with Turbo Power Motor', 'haircare-styling', 'both', 'dryer', 69.95, 'Stay-Temp Professional Hair Dryer with Turbo Power Motor for fast, consistent-heat drying.', NULL, 'Turbo Power Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Ace Professional Lightweight Foldable Hair Dryer', 'haircare-styling', 'consumer', 'dryer', 59.95, 'Ace Professional Lightweight Foldable Hair Dryer built for travel and everyday consumer use.', NULL, 'Standard Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Rival Lightweight Foldable Hair Dryer', 'haircare-styling', 'consumer', 'dryer', 39.95, 'Rival Lightweight Foldable Hair Dryer. Compact, travel-friendly design.', NULL, 'Standard Motor', NULL, NULL, ARRAY['motor_needs_confirmation']::text[], 'legacy_catalog_import'),
('Sage Professional 1" Cordless Curling Iron & Wand with Removable Clamp', 'haircare-styling', 'both', 'curling_iron', 129.95, 'Sage Professional 1" Cordless Curling Iron & Wand with a removable clamp for both clamped and wand-style curling. Features a 1" ceramic barrel.', NULL, NULL, 'ceramic', 'Ceramic Barrel', '{}'::text[], 'legacy_catalog_import'),
('Sage Professional Retractable Styling Brush & Curling Wand 1.25"', 'haircare-styling', 'both', 'other_styling', 99.95, 'Sage Professional Retractable Styling Brush & Curling Wand with a 1.25" ceramic barrel — bristles retract for wand-style curling.', NULL, NULL, 'ceramic', 'Ceramic Barrel', '{}'::text[], 'legacy_catalog_import'),
('Sage Professional Flat Iron with 1" Titanium Plates', 'haircare-styling', 'both', 'flat_iron', 99.95, 'Sage Professional Flat Iron with 1" titanium plates for fast, even heat distribution.', NULL, NULL, 'titanium', 'Titanium Plates', '{}'::text[], 'legacy_catalog_import'),
('Stay-Temp Professional Flat Iron with 1" Titanium Plates', 'haircare-styling', 'both', 'flat_iron', 89.95, 'Stay-Temp Professional Flat Iron with 1" titanium plates and consistent temperature hold.', NULL, NULL, 'titanium', 'Titanium Plates', '{}'::text[], 'legacy_catalog_import'),
('Sage Professional Triple Barrel Deep Waver', 'haircare-styling', 'both', 'other_styling', 89.95, 'Sage Professional Triple Barrel Deep Waver for beachy waves in one pass. Ceramic coated barrels.', NULL, NULL, 'ceramic', 'Ceramic Coated', '{}'::text[], 'legacy_catalog_import'),
('Heat Stroke Professional Beard & Hair Styling Cordless Hot Brush', 'haircare-styling', 'both', 'other_styling', 69.95, 'Heat Stroke Professional Beard & Hair Styling Cordless Hot Brush for beard straightening and styling.', NULL, NULL, NULL, NULL, ARRAY['heat_tech_needs_confirmation']::text[], 'legacy_catalog_import'),
('Stay-Temp Professional Ceramic Extended Barrel Curling Iron (0.75"–1.25")', 'haircare-styling', 'both', 'curling_iron', 54.95, 'Stay-Temp Professional Ceramic Extended Barrel Curling Iron, available in 0.75", 1", and 1.25" barrel sizes.', NULL, NULL, 'ceramic', 'Ceramic Barrel', '{}'::text[], 'legacy_catalog_import'),
('Stay-Temp Professional Ceramic Barrel 3/4" Marcel Curling Iron', 'haircare-styling', 'both', 'curling_iron', 49.95, 'Stay-Temp Professional Ceramic Barrel 3/4" Marcel Curling Iron for classic clamp-free curling technique.', NULL, NULL, 'ceramic', 'Ceramic Barrel', '{}'::text[], 'legacy_catalog_import'),
('Stay-Temp Professional Ceramic Barrel Curling Iron (0.5"–1.5")', 'haircare-styling', 'both', 'curling_iron', 44.95, 'Stay-Temp Professional Ceramic Barrel Curling Iron, available across five barrel sizes from 0.5" to 1.5".', NULL, NULL, 'ceramic', 'Ceramic Barrel', '{}'::text[], 'legacy_catalog_import')
ON CONFLICT (name) DO NOTHING;

-- 35. CATALOG PRODUCTS: BRAND + SKU — GTM's new "Comparison Chart WEB ONLY"
-- field needs to search catalog_products across BOTH of our house brands
-- with a real SKU to render ("1. {name} (StyleCraft) — SKU {sku}"), and the
-- new Manufacturer auto-detect cascade (lib/gtm-tier6-inference.ts) uses
-- `brand` as its most-authoritative signal when an analysis was built from
-- a real catalog pick. No CHECK constraint — same plain-VARCHAR-no-enum
-- convention this table's own target_market/industry/tool_type columns
-- already use (validated at the application layer, not the DB layer).
-- Every existing row genuinely IS StyleCraft-sourced (this session's own
-- GTM-forms + scraped-site seed data) — safe, honest backfill, not a guess.
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS brand VARCHAR(20);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS sku VARCHAR(100);
UPDATE catalog_products SET brand = 'StyleCraft' WHERE brand IS NULL;

-- 36. BRAND NAME HINTS — a small admin-editable "product-name-prefix ->
-- brand" map for the Manufacturer auto-detect cascade's 2nd tier (after the
-- catalog-record check, before falling back to the TDS manufacturer field
-- or an ambiguous confirm-quick-pick). Deliberately NOT the full 4-category
-- legacy-brand-registry shape (lib/db/legacy-brands.ts) — that structure
-- exists for pro/retail category segmentation this 2-value brand hint
-- doesn't need. Matching reuses the exact same word-boundary token
-- approach as lib/legacy-brand-discovery.ts's brandMatchesTitle/
-- normalizeBrandToken, just against name_prefixes instead of brand aliases.
CREATE TABLE IF NOT EXISTS brand_name_hints (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    brand VARCHAR(20) NOT NULL UNIQUE,
    name_prefixes TEXT[] NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE brand_name_hints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for brand_name_hints" ON brand_name_hints FOR ALL USING (true) WITH CHECK (true);

INSERT INTO brand_name_hints (brand, name_prefixes, sort_order) VALUES
    ('StyleCraft', ARRAY['Saber', 'Anime', 'Protege', 'Protégé', 'Reign', 'Rebel', 'Rogue', 'Instinct', 'Ergo', 'Solecito', 'Rival', 'Ace', 'Homie', 'Schnozzle', 'Sage', 'Stay-Temp', 'Stay Temp'], 0),
    ('Gamma+', ARRAY['Absolute', 'X-Evo', 'XEvo'], 1)
ON CONFLICT (brand) DO NOTHING;

-- 37. PROJECT SKU — GTM Schema v3's Product Title field renders
-- "{Product Title} — {SKU}" once a SKU is set. Not one of the 76 GTM
-- Product Knowledge fields itself (it's project-level identity data, same
-- tier as motor_family/key_diff/price_point), editable inline from the
-- GTM tab. No CHECK constraint — same plain-VARCHAR convention as every
-- other project column.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sku VARCHAR(100);

-- 38. CATALOG PRODUCTS: PRODUCT KIND + PARENT SKU + COLLECTION — GTM style
-- corpus work. product_kind distinguishes a full tool from an accessory/
-- replacement part (e.g. SC559B, a foil head) so Motor/Lids/Lever/Guards/
-- Charging/most Included-in-Box fields resolve straight to N/A for it
-- without ever attempting a scrape (see lib/gtm-generate.ts's
-- structurallyInapplicableFieldIds). parent_sku links an accessory back to
-- the tool it services (SC559B -> SC817B) for cross-sell/tier derivation.
-- collection is the free-text product line name ("Homie", "360 Jeezy") a
-- product belongs to, matched case-insensitively against the new
-- collections table (Section 39) at generation time. No CHECK constraints —
-- same plain-VARCHAR convention as every other catalog column.
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS product_kind VARCHAR(20) NOT NULL DEFAULT 'tool';
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS parent_sku VARCHAR(100);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS collection VARCHAR(100);

-- 39. COLLECTIONS — admin-editable narrative kernels (origin story, logo
-- meaning, voice notes) for a named product line ("Homie", "360 Jeezy").
-- When a product's catalog_products.collection matches a stored kernel,
-- GTM's Product Name Origin / name-ties-to-story generation ADAPTS the
-- kernel to the specific product instead of inventing a new story or
-- copying it verbatim (see lib/gtm-features-and-tip.ts) — mirroring how the
-- real Homie Clipper/Shaver/Foil GTM sheets repeat-and-adapt the same
-- origin paragraph. Seeded with the real Homie and 360 Jeezy kernel text
-- (quoted from those same approved sheets), same "always-seeded real
-- default configuration" precedent as brand_name_hints.
CREATE TABLE IF NOT EXISTS collections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    narrative_kernel TEXT NOT NULL DEFAULT '',
    logo_meaning TEXT NOT NULL DEFAULT '',
    voice_notes TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for collections" ON collections FOR ALL USING (true) WITH CHECK (true);

INSERT INTO collections (name, narrative_kernel, logo_meaning, voice_notes, sort_order) VALUES
    (
        'Homie',
        'Homie is a term rooted in loyalty, familiarity, and community - it''s the person who always has your back, reliable, real, and never pretentious. The Homie name was established with the Homie Nano Clipper and carried through the full collection (Clipper, Trimmer, Shaver) to represent StyleCraft''s connection to the grooming community at every level.',
        'The stylized H with a heart in the logo reinforces that emotional bond - this is a brand that cares about craft and the people who practice it.',
        'Confident, down-to-earth, community-rooted. Not trying to be premium - owning the accessible-pro lane with pride. Real talk, no fluff. A homie doesn''t show off, they just show up and deliver.',
        0
    ),
    (
        '360 Jeezy',
        'The 360 Jeezy collaboration represents a full-circle approach to barbering: precision, consistency, and mastery from every angle. Just like a clean 360 wave pattern, every detail matters. Co-designed with one of the industry''s most recognized barbers, every feature decision was made from behind the chair, not behind a desk.',
        'N/A - no distinct logo lockup beyond the co-branded S|C x 360 Jeezy wordmark.',
        'Bold, technical authority, craft language. Peer-to-peer trust from a working barber, not celebrity hype. Confident, professional, never generic/corporate.',
        1
    )
ON CONFLICT (name) DO NOTHING;

-- 40. GTM WORKBOOK TEMPLATES — versioned master .xlsx templates for the
-- official 12-tab Go-To-Market workbook export (Product Knowledge/BOX ONLY/
-- Product FAQ get filled; the other 9 tabs are exported byte-for-byte
-- untouched — see lib/gtm-workbook-render.ts). Direct clone of Section 11's
-- deck_templates pattern: the binary file lives in Supabase Storage bucket
-- "gtm-workbook-templates" (create it manually in the Supabase dashboard,
-- same as "deck-templates"/"artwork" — Storage buckets aren't SQL objects);
-- this row is metadata + a pointer + a validation summary (which sheet
-- names were found, confirming Product Knowledge/BOX ONLY/Product FAQ
-- exist). Only one row may have is_active = true at a time.
CREATE TABLE IF NOT EXISTS gtm_workbook_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    file_name VARCHAR(255),
    file_size_bytes INTEGER,
    -- Shape: { sheetNames: string[], missingRequiredSheets: string[] } — see
    -- lib/gtm-workbook-template-parser.ts.
    sheet_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT false,
    uploaded_by VARCHAR(255),
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS gtm_workbook_templates_one_active_idx ON gtm_workbook_templates(is_active) WHERE is_active = true;
ALTER TABLE gtm_workbook_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for gtm_workbook_templates" ON gtm_workbook_templates FOR ALL USING (true) WITH CHECK (true);

-- 41. CATALOG PRODUCTS: UPC — GTM workbook export's BOX ONLY tab needs a
-- real UPC per product; sourced from the catalog record (same "catalog
-- wins, else Awaiting internal input" pattern as sku/brand), populated via
-- spreadsheet re-import (lib/catalog-import.ts), not a manual admin form
-- field — same precedent as brand/sku/product_kind/parent_sku/collection.
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS upc VARCHAR(20);

-- 42. BRAND VOICE GUIDES — versioned, brand-scoped voice/tone/terminology
-- guide injected into every AI call that produces user-facing prose (GTM
-- narrative fields, Product FAQs, Sales Kit, deck-copy condensation,
-- analysis synthesis — see lib/brand-voice.ts). "Versioned" here follows
-- the SAME precedent as gtm_workbook_templates/deck_templates: a new edit
-- is a new ROW (version = previous max for that brand + 1), activating one
-- deactivates the rest for THAT brand only — the partial unique index is
-- scoped to (brand, is_active), not globally, since StyleCraft and Gamma+
-- each need their own concurrently-active guide. Seeded with the real
-- StyleCraft guide verbatim; no Gamma+ row is seeded — its absence IS the
-- "no brand voice guide on file" signal lib/brand-voice.ts falls back on.
CREATE TABLE IF NOT EXISTS brand_voice_guides (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    brand VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    version INTEGER NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT false,
    created_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS brand_voice_guides_one_active_per_brand_idx ON brand_voice_guides(brand, is_active) WHERE is_active = true;
ALTER TABLE brand_voice_guides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for brand_voice_guides" ON brand_voice_guides FOR ALL USING (true) WITH CHECK (true);

INSERT INTO brand_voice_guides (brand, content, version, is_active) VALUES (
    'StyleCraft',
    $$# StyleCraftUS Brand Voice Guide

*Derived from analysis of stylecraftus.com (homepage, About Us / Our Story, collection and product copy) — July 2026*

---

## 1. Brand Personality

If StyleCraft were a person, they'd be a master barber who came up through the industry, knows every motor spec by heart, and treats their clients like family. Confident bordering on cocky about the tools, but genuinely warm with people. They talk like a peer in the shop, not a corporation — they'd say "the Fam" without irony, hype a "new drop" like a sneaker release, and then patiently walk you through a warranty claim.

**In one line:** A pro-grade challenger brand with streetwear energy and family-business heart.

## 2. Voice Attributes

### Bold & Competitive
- **We are:** Confident, declarative, unafraid of big statements. We name products after winners and fighters (Saber, Rebel, Rogue, Reign, Ace, Instinct) and write taglines like commands: "Conquer Every Style." "Do Whatever It Takes."
- **We are not:** Arrogant toward the customer, or dismissive of competitors by name. The swagger is about the tools, never at anyone's expense.
- **Sounds like:** "Unmatched. Unstoppable. Intuitive."
- **Does NOT sound like:** "We think you might enjoy our clipper, which compares favorably to leading brands."

### Tech-Credible
- **We are:** Specific about engineering. We lead with named technology — EON Digital Brushless Motor, IN2 Vector Motor, Super C4RBN, Stay-Temp — and concrete benefits (high torque, low vibration, full metal body). Specs are part of the swagger.
- **We are not:** Jargon for jargon's sake. Every spec ties to what it does in the pro's hand: faster cuts, cooler blades, longer sessions.
- **Sounds like:** "High energy, low vibration."
- **Does NOT sound like:** Vague fluff like "cutting-edge quality you can trust."

### Community-First ("The Fam")
- **We are:** Warm, loyal, reciprocal. We talk about barbers and stylists as family and collaborators, not customers. We celebrate their work and their following, not just our products. "It's a 2-way street."
- **We are not:** Corporate-friendly-by-committee, or transactional. We never fake intimacy with generic "valued customer" language.
- **Sounds like:** "If you are not happy, we are not happy."
- **Does NOT sound like:** "We appreciate your business and strive for customer satisfaction."

### Street-Culture Fluent
- **We are:** Plugged into barber culture — drops, collabs (S|C x 360 Jeezy), edgy colorways, metallic finishes. Product launches read like sneaker releases: "NEW DROPS."
- **We are not:** Trend-chasing or trying too hard. The culture references come from being *in* the community, not marketing to it.
- **Sounds like:** "Embrace the unconventional: Go Rogue!"
- **Does NOT sound like:** Forced slang or memes disconnected from barbering.

### Craft-Proud & Family-Built
- **We are:** A family-owned, US-based company with 50+ years of combined industry experience. We invoke the founder story (Ken & Austin Russo), craftsmanship, and "the art & science of styling."
- **We are not:** Nostalgic or old-fashioned. Heritage backs up innovation; it doesn't replace it.
- **Sounds like:** "The Art & Science of Styling."
- **Does NOT sound like:** "Old-world tradition since days gone by."

## 3. Audience

**Primary:** Professional barbers and stylists — people who cut hair for a living, care about torque, blade quality, and battery life, and see their tools as an extension of their craft and personal brand. They expect to be addressed as peers and pros.

**Secondary:** Prosumers and home users who aspire to pro-grade results and buy into the culture (the Ace and Homie lines, brushes, dryers).

They care about: performance under daily use, standing out (finishes, colorways), education and skill growth, and being part of a community that respects the craft.

## 4. Core Messaging Pillars

1. **Pro-grade innovation** — Named motor technology and engineering that rivals the biggest players. Every product claim anchors to a spec or design feature.
2. **Built by and for the craft** — Family-owned, 50+ years of industry expertise, tools designed with working barbers and stylists.
3. **The Fam** — A loyal, two-way community. We elevate our pros' craft and their following, and they carry the brand.
4. **Edgy design that stands out** — Bold colorways, metallic finishes, collabs. The tool on your station says something about you.
5. **Service that has your back** — Trained, genuinely helpful support; happiness guaranteed in spirit: "If you are not happy, we are not happy."

## 5. Tone Spectrum (voice stays fixed, tone flexes)

| Context | Dial up | Dial down | Example register |
|---|---|---|---|
| Product launches / drops | Boldness, hype, culture | Warmth | "NEW DROP. Conquer every style." |
| Product detail pages | Tech credibility | Slang | Specs first, benefit-driven, still punchy |
| Education / tutorials | Craft pride, clarity | Hype | Peer-to-peer teaching, step-by-step |
| Customer service / support | Warmth, patience | Swagger | Plain, friendly, human — no attitude |
| Corporate / press / About | Heritage, credibility | Street slang | Confident but polished; founder story |
| Social media | Community, playfulness | Formality | Fam language, collabs, celebrating pros' work |

## 6. Style Rules (observed & recommended)

- **Taglines:** Short imperative or fragment constructions, often stacked one-word sentences ("Unmatched. Unstoppable. Intuitive."). ALL CAPS acceptable in headlines/banners only, never body copy.
- **Contractions:** Use them ("we've got the answers") — the voice is conversational.
- **Exclamation marks:** Sparingly; reserve for launch/hype moments ("Go Rogue!"), max one per piece.
- **Body copy:** Warm, first-person plural ("we," "our"), direct address ("you," "your craft").
- **Product naming convention:** [Collection Name] + [Product Type] + "with" + [Named Technology] (e.g., "Reign Professional Hair Clipper with EON Digital Brushless Motor"). Keep this structure consistent.

## 7. Terminology

**Preferred terms**
| Use | Notes |
|---|---|
| StyleCraft / StyleCraftUS / S\|C | S\|C shorthand for logos, collabs, sub-brands (S\|C Educators, S\|C x 360 Jeezy) |
| the Fam | Community/social contexts only, not corporate copy |
| pros, barbers, stylists | Never "users" or "consumers" in community-facing copy |
| drop / new drop | For product launches on social and homepage |
| tools | Preferred over "devices" or "appliances" (except corporate/press: "hair appliances" is acceptable) |
| Named tech in full on first use | "EON Digital Brushless Motor," "IN2 Vector Motor," "Super C4RBN," "Stay-Temp Technology" |

**Avoid**
- Generic praise without a spec behind it ("high quality," "great performance" standing alone)
- Corporate distance ("valued customers," "our organization")
- Talking down to home users — they're aspiring pros, not amateurs

## 8. Watch-outs (flagged during audit)

- **Unsubstantiated superlatives:** Lines like "one of the fastest growing beauty and grooming tool companies since the industrial revolution" and "rivaling billion-dollar companies" are on-voice in their boldness but legally soft. Recommend qualifying with a source (e.g., Inc. 500 recognition, which the site already displays) or softening in formal/press contexts.
- **Voice drift between sections:** Corporate copy occasionally slips into run-on, less polished sentences ("Join the revolution and experience."). Keep the bold-but-polished standard everywhere.
- **Consistency of S|C vs. SC vs. SIC:** Product listings show variants ("SIC Pro" mat). Standardize on S|C.

---

*Use this guide with content reviews: check any new copy against the five voice attributes, the tone spectrum for its channel, and the terminology table.*
$$,
    1,
    true
) ON CONFLICT DO NOTHING;

-- 43. DOCUMENTS: VOICE GUIDE PROVENANCE — records which brand voice guide
-- version was active when a document (GTM/TDS) was generated, mirroring
-- project_decks.template_id pinning its original template — so a later
-- guide edit never silently reclassifies what an already-generated
-- document was actually written against.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS voice_guide_id UUID REFERENCES brand_voice_guides(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS voice_guide_version INTEGER;

-- 44. UPLOADED SOURCE DOCS — externally-authored TDS/Spec Sheet/Sales Kit/
-- Other files a team uploads for a project (pre-launch products with no
-- web presence especially need this), parsed into extracted_facts and
-- injected as a top-priority grounded source in the GTM fill ladder. NOT
-- the app's own disabled TDS-generation feature (lib/tds-generate.ts,
-- gated by isTdsEnabled() in lib/feature-flags.ts, stays untouched) — this
-- ingests a real file as source material, a different concern that
-- happens to share GTM's field vocabulary (lib/tds-field-schema.ts).
-- Versioned per (project_id, doc_type): a replacement upload is a new row,
-- old ones kept for audit/rollback, only one active per project+type at a
-- time — same precedent as Section 42's brand_voice_guides, scoped here to
-- (project_id, doc_type) instead of (brand). The binary file lives in
-- Supabase Storage bucket "project-source-docs" (create it manually in the
-- Supabase dashboard, private — no public URL, same as "deck-templates").
CREATE TABLE IF NOT EXISTS uploaded_source_docs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL,
    doc_type VARCHAR(20) NOT NULL, -- 'tds' | 'spec_sheet' | 'sales_kit' | 'other'
    file_path VARCHAR(500) NOT NULL,
    file_name VARCHAR(255),
    file_size_bytes INTEGER,
    mime_type VARCHAR(100),
    version INTEGER NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    full_text TEXT, -- sanitizeText() applied — used for narrative grounding + fact re-verification
    extraction_status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | complete | failed
    uploaded_by VARCHAR(255),
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uploaded_source_docs_one_active_idx ON uploaded_source_docs(project_id, doc_type, is_active) WHERE is_active = true;
ALTER TABLE uploaded_source_docs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for uploaded_source_docs" ON uploaded_source_docs FOR ALL USING (true) WITH CHECK (true);

-- Structured facts extracted from an uploaded_source_docs row — one row per
-- (source_doc_id, field_id), field_id matching GTM_FIELD_SCHEMA/
-- TDS_FIELD_SCHEMA's own ids directly (no separate vocabulary to
-- translate). confirmed_by_user distinguishes an AI-extracted candidate
-- (already verbatim-quote-verified against the doc's own full_text before
-- ever being inserted) from a human's explicit correction/addition, which
-- always wins in the fill ladder regardless of which doc type it came from.
CREATE TABLE IF NOT EXISTS extracted_facts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_doc_id UUID NOT NULL REFERENCES uploaded_source_docs(id) ON DELETE CASCADE,
    project_id UUID NOT NULL,
    field_id VARCHAR(100) NOT NULL,
    value TEXT NOT NULL,
    raw_text TEXT, -- verbatim quote from the source doc backing this value
    source_location VARCHAR(100), -- e.g. "p.3", "Motor sheet"
    confirmed_by_user BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(source_doc_id, field_id)
);
ALTER TABLE extracted_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for extracted_facts" ON extracted_facts FOR ALL USING (true) WITH CHECK (true);

-- documents.source_doc_versions — provenance stamp for the "out of date
-- sources" banner. Unlike voice_guide (one guide per brand, a single FK
-- fits), a project can have several active doc TYPES at once — JSONB is
-- this codebase's own established shape for "a map of several typed
-- values" (document_fields.source_detail, gtm_workbook_templates.sheet_summary).
-- Shape: {"tds": {"id": "...", "version": 2}, "spec_sheet": {"id": "...", "version": 1}}
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_doc_versions JSONB;

-- 45. FEATURE FLAG: DECK GENERATION — deck generation was repeatedly
-- stalling/timing out as the auto-pipeline's last phase (lib/project-generation-engine.ts's
-- "deck" phase); this flag defaults it off so project setup completes right
-- after Product FAQs instead of hanging here. A missing row already falls
-- back to disabled (lib/db/feature-flags.ts's DEFAULT_ENABLED), so this
-- seed isn't load-bearing for the fix itself — it exists so the row shows
-- up in the admin Features page to be re-enabled later, same as every
-- other flag in Section 20/23.
INSERT INTO feature_flags (flag_name, enabled) VALUES ('deck_generation_enabled', false) ON CONFLICT (flag_name) DO NOTHING;

-- 46. FEATURE FLAG: MARKETING DIRECTION GENERATION — new pipeline phase
-- (lib/project-generation-engine.ts's "marketing_direction" phase, runs
-- after "faqs" and before "deck") generating the GTM workbook's 4th filled
-- tab. Defaults ON (unlike Section 45's deck flag) — the feature's own spec
-- requires it to auto-generate — but exists as an admin-page kill-switch
-- (lib/db/feature-flags.ts's DEFAULT_ENABLED already returns true even with
-- no row, so this seed isn't load-bearing; it exists so the row is visible
-- to disable later, same as every other flag in this file).
INSERT INTO feature_flags (flag_name, enabled) VALUES ('marketing_direction_generation_enabled', true) ON CONFLICT (flag_name) DO NOTHING;

-- 47. MARKETING DEFAULTS — org-wide singleton config for the Marketing
-- Direction section's "Languages" field (GTM workbook export work). Same
-- singleton-row shape as Section 14's competitor_matching_config (a single
-- id=1 row), not the versioned brand_voice_guides pattern — overkill for one
-- string. Read/write via lib/db/marketing-defaults.ts; the admin page at
-- /dashboard/admin/marketing-defaults edits it directly.
CREATE TABLE IF NOT EXISTS marketing_defaults (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    languages TEXT NOT NULL DEFAULT 'English (primary). Spanish (secondary, for retail/DTC market reach). French Canadian',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE marketing_defaults ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for marketing_defaults" ON marketing_defaults FOR ALL USING (true) WITH CHECK (true);
INSERT INTO marketing_defaults (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 48. FEATURE FLAG: CONTENT FORM GENERATION — new pipeline phase
-- (lib/project-generation-engine.ts's "content_form" phase, runs right
-- after "gtm" and before "faqs") generating the 15-field Product Detail
-- Page content sheet (doc_type="content_form" on the existing documents/
-- document_fields tables — no new table needed). Defaults ON, same
-- kill-switch precedent as Section 46's marketing_direction flag (this
-- seed isn't load-bearing on its own — lib/db/feature-flags.ts's
-- DEFAULT_ENABLED already returns true with no row — it exists so the row
-- is visible in the admin Features page to disable later if needed).
INSERT INTO feature_flags (flag_name, enabled) VALUES ('content_form_generation_enabled', true) ON CONFLICT (flag_name) DO NOTHING;

-- 49. DOCUMENTS: XLSX DRIVE PROVENANCE — a "Save to Google Drive" option
-- next to GTM's existing "Download XLSX" link, so the generated GTM
-- workbook (not just its PDF) also saves to Drive. Kept as separate
-- columns from documents.drive_url/drive_file_id (which track the PDF's
-- own saved link, see Part with SaveToDriveButton) so saving the XLSX
-- never clobbers an already-saved PDF link, and vice versa.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS xlsx_drive_url VARCHAR(500);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS xlsx_drive_file_id VARCHAR(255);

-- 50. UPLOADED SOURCE DOCS: FACTS EXTRACTION STATUS — Section 44's
-- extraction_status tracks CONTENT extraction (raw text out of the file);
-- this tracks the SEPARATE structured-facts-derivation step
-- (lib/tds-doc-facts.ts's extractStructuredFacts, called from
-- lib/tds-doc-ingest.ts's deriveFactsForDoc). Before this column existed,
-- an AI-call failure during facts derivation (network blip, timeout,
-- malformed response) was silently indistinguishable from "this document
-- genuinely has zero extractable specs" — both produced factsFound: 0 with
-- no way for a user to tell them apart days later when GTM fields are still
-- blank. 'not_attempted' is the default for every row created before this
-- column existed (and briefly, for a row whose facts call hasn't run yet) —
-- deliberately distinct from 'failed' so old rows don't retroactively show
-- an error banner they never actually had.
ALTER TABLE uploaded_source_docs ADD COLUMN IF NOT EXISTS facts_extraction_status VARCHAR(20) NOT NULL DEFAULT 'not_attempted'; -- not_attempted | complete | failed

-- 51. ANALYSES: RELATED PRODUCTS (ENRICHED) — the raw user-pasted ASINs/
-- URLs (0-3, from the analyze form's "Related Products" field) travel in
-- the existing free-form analyses.context JSONB column (context.relatedAsins),
-- exactly like companyContext/keyDiff already do — no migration needed for
-- that. This column instead holds the ENRICHED result: each related ASIN's
-- full Rainforest payload + motor/heat-tech extraction, resolved once at
-- the start of the run (lib/analysisEngine.ts's resolveRelatedProducts,
-- called from the Phase 0 block) plus a toolTypeMismatch flag and
-- eligibility for pool-seeding into discovery. Kept as its own column
-- (mirroring phase0_result/phase1_result/...) rather than folded into
-- phase0_result, since it has its own patch lifecycle (the "fixing a
-- mispaste re-fetches in place" swap flow patches only this column, never
-- touching the identity card).
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS related_products JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 52. PROJECTS: RELATED PRODUCTS DEFAULTS (RAW) — lets "Related Products"
-- pre-fill on a re-run from a project, the same way companyContext/
-- motorFamily/keyDiff already do (see PATCH /api/projects/[id]'s
-- whitelist). Deliberately holds only the raw {asin,url,addedAt} input,
-- never the enriched Rainforest/motor data in Section 51 above — that
-- enrichment must always be refetched fresh at the start of each run
-- (prices/availability/motor claims go stale), never carried forward
-- project-to-project.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS related_products JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 53. SOURCE-DOC FACTS: TYPE/CONFIDENCE + LOCATION PERSISTENCE + CROSS-
-- DOCUMENT FILL CHAIN — "Automatic Source-Doc Fact Extraction & Cross-
-- Document Fill." Three additions:
--
-- (a) extracted_facts gains fact_type ('grounded_field' | 'narrative_signal')
-- and confidence ('high' | 'medium' | 'low'). Every fact before this column
-- existed was a schema-field-id-bound grounded fact from the AI sweep
-- (lib/tds-doc-facts.ts) — defaults preserve that read exactly.
-- 'grounded_field' now also covers the new deterministic synonym-map parser
-- (lib/source-fact-extract-deterministic.ts, confidence:'high');
-- 'narrative_signal' is new — free-form marketing facts (taglines/USPs/
-- audience statements) that don't map to a fixed schema field id, keyed by
-- a synthesized slug in the existing field_id column (no FK/enum
-- constraint on that column, so this needed no schema change beyond adding
-- the two new columns themselves).
ALTER TABLE extracted_facts ADD COLUMN IF NOT EXISTS fact_type VARCHAR(20) NOT NULL DEFAULT 'grounded_field';
ALTER TABLE extracted_facts ADD COLUMN IF NOT EXISTS confidence VARCHAR(10) NOT NULL DEFAULT 'medium';
--
-- (b) uploaded_source_docs gains `locations` (JSONB array of
-- {label, text} — lib/tds-doc-extract.ts's ExtractedLocation shape).
-- lib/tds-doc-ingest.ts's deriveFactsForDoc previously reconstructed
-- content with `locations: []` (a disclosed trade-off at the time,
-- documented in that function's own header comment) because locations
-- were never persisted — every fact derived AFTER initial upload lost its
-- "found on p.3" attribution. Restoring this is required for the new
-- "{Doc type} (filename, p.X)" field badge.
ALTER TABLE uploaded_source_docs ADD COLUMN IF NOT EXISTS locations JSONB NOT NULL DEFAULT '[]'::jsonb;
--
-- (c) document_fill_state — one row per project, tracks the automatic
-- "extract facts -> fill GTM -> fill Content Form" chain the same way
-- project_generation_state tracks the project-creation pipeline: one phase
-- per request/poll, checkpointed so a closed tab/browser just resumes the
-- moment any tab of that project reopens (no background-job service —
-- this app tried Inngest for a similar always-running chain and reverted
-- it; see the revert commit's own reasoning). `steps` is the ordered
-- remaining-step list for THIS run (e.g. ["gtm","content_form"]);
-- `results` accumulates each step's {filled, regenerated, stillAwaiting}
-- counts for the completion toast + per-document header summary.
CREATE TABLE IF NOT EXISTS document_fill_state (
    project_id UUID PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'idle', -- idle | running | complete | failed
    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    current_step_index INTEGER NOT NULL DEFAULT 0,
    triggered_by_doc_id UUID,
    triggered_by_file_name VARCHAR(255),
    results JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
ALTER TABLE document_fill_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations for document_fill_state" ON document_fill_state FOR ALL USING (true) WITH CHECK (true);

-- 54. GTM WORKBOOK TEMPLATES: MULTI-TEMPLATE (BARBER + BEAUTY) — a second
-- real template ("... Go to Market — BEAUTY — BLANK.xlsx") is now uploaded
-- alongside the original BARBER one, and BOTH must stay active
-- simultaneously (export auto-selects by the product's industry family).
-- `industry` scopes which template a product routes to; the old GLOBAL
-- "only one active row" index is replaced with one scoped per industry —
-- same precedent as brand_voice_guides' (brand, is_active) scoped index
-- (Section 42) — so activating a beauty template never deactivates the
-- barber one. The existing barber row backfills to industry='barber' via
-- the column default; no data migration needed.
ALTER TABLE gtm_workbook_templates ADD COLUMN IF NOT EXISTS industry VARCHAR(20) NOT NULL DEFAULT 'barber';
-- field_inspection: the Part 1.2 "template inspection on upload" output for
-- a beauty-industry upload — { sheetLabels: {[tabName]: string[]}, diff:
-- {shared, candidateOnly, referenceOnly} per tab } — diffed against the
-- barber template's own known labels at upload time, shown in Settings so
-- an admin can see exactly what did/didn't map before relying on the
-- export. NULL for barber uploads (barber IS the reference, nothing to
-- diff it against).
ALTER TABLE gtm_workbook_templates ADD COLUMN IF NOT EXISTS field_inspection JSONB;
DROP INDEX IF EXISTS gtm_workbook_templates_one_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS gtm_workbook_templates_one_active_per_industry_idx
  ON gtm_workbook_templates(industry) WHERE is_active = true;

-- projects.gtm_template_override — Part 3.4's "mixed collections... route by
-- TOOL TYPE's industry family, with a visible override on the project."
-- NULL (the default/common case) = auto-route from the product's tool
-- type's family (lib/db/tool-types.ts); 'barber'/'beauty' pins the export
-- to that template regardless of the resolved family.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS gtm_template_override VARCHAR(20);

-- 55. CRITICAL SECURITY FIX — RLS regression on 15 tables added after Section 17
-- Section 17 (above) empirically confirmed and fixed a fully-permissive RLS
-- policy on the original 26 tables — anon/authenticated had zero-restriction
-- read/write via the public Supabase anon key (which ships in the browser
-- bundle by NEXT_PUBLIC_ convention), completely bypassing this app's own
-- auth/authorization. A pre-launch adversarial audit (2026-08-09) found that
-- EVERY table created in a section AFTER Section 17 reintroduced the exact
-- same `FOR ALL USING (true) WITH CHECK (true)` policy — Section 17's fix was
-- never made into a rule future sections had to follow, so 15 tables slipped
-- back into the identical, already-once-fixed hole. Two of the tables added
-- in this same later window (auth_events, feature_flags) got it right
-- (RLS enabled, deliberately zero policies) — proving the safe pattern was
-- known, just not applied consistently.
--
-- Impact before this fix: any unauthenticated visitor, using only the public
-- anon key extracted from this app's own shipped JS bundle, could read/write
-- via Supabase's REST API directly — bypassing getAuthSession(), middleware.ts,
-- and every ownership check in this codebase entirely:
--   - uploaded_source_docs / extracted_facts: every project's uploaded TDS/
--     spec-sheet/sales-kit full text and structured facts, across every org.
--   - catalog_products, scoring_profiles, competitor_corrections,
--     brand_voice_guides, gtm_workbook_templates, tool_types,
--     branded_motor_names, heat_tech_families, branded_heat_tech_names,
--     brand_name_hints, collections, marketing_defaults, document_fill_state:
--     shared config every tenant's analyses/generation depend on — readable
--     AND writable (an attacker could vandalize pricing/taxonomy/brand data
--     for every user of the app).
--
-- Fix is identical in shape and equally safe (zero functional impact) as
-- Section 17's: every real query against these 15 tables already goes
-- through `supabaseAdmin` (service-role, bypasses RLS) in their lib/db/*.ts
-- modules — confirmed via a full grep, no code path anywhere uses the plain
-- anon `supabase` client for a `.from(table)` call on any of these tables.
-- Dropping the permissive policy while RLS stays ENABLED denies anon/
-- authenticated by default, exactly like the original 26.
DROP POLICY IF EXISTS "Allow all operations for branded_motor_names" ON branded_motor_names;
DROP POLICY IF EXISTS "Allow all operations for tool_types" ON tool_types;
DROP POLICY IF EXISTS "Allow all operations for scoring_profiles" ON scoring_profiles;
DROP POLICY IF EXISTS "Allow all operations for heat_tech_families" ON heat_tech_families;
DROP POLICY IF EXISTS "Allow all operations for branded_heat_tech_names" ON branded_heat_tech_names;
DROP POLICY IF EXISTS "Allow all operations for competitor_corrections" ON competitor_corrections;
DROP POLICY IF EXISTS "Allow all operations for catalog_products" ON catalog_products;
DROP POLICY IF EXISTS "Allow all operations for brand_name_hints" ON brand_name_hints;
DROP POLICY IF EXISTS "Allow all operations for collections" ON collections;
DROP POLICY IF EXISTS "Allow all operations for gtm_workbook_templates" ON gtm_workbook_templates;
DROP POLICY IF EXISTS "Allow all operations for brand_voice_guides" ON brand_voice_guides;
DROP POLICY IF EXISTS "Allow all operations for uploaded_source_docs" ON uploaded_source_docs;
DROP POLICY IF EXISTS "Allow all operations for extracted_facts" ON extracted_facts;
DROP POLICY IF EXISTS "Allow all operations for marketing_defaults" ON marketing_defaults;
DROP POLICY IF EXISTS "Allow all operations for document_fill_state" ON document_fill_state;
-- (All 15 tables now have RLS enabled with zero policies, matching Section
-- 17's 26 — anon/authenticated get zero rows on every operation;
-- supabaseAdmin/service-role is unaffected. IMPORTANT FOR FUTURE SECTIONS:
-- when adding a new table, do NOT add a permissive `USING (true)` policy —
-- either add no policy at all (RLS enabled, zero policies = deny by
-- default, the correct choice for any table only ever queried via
-- supabaseAdmin) or a real per-row policy scoped to auth.uid()/org — never
-- copy the `CREATE POLICY ... USING (true) WITH CHECK (true)` pattern that
-- appears earlier in this file for the ORIGINAL 26 tables' now-superseded
-- definitions; those lines are dead/overridden by this section and Section
-- 17, kept only so `CREATE TABLE IF NOT EXISTS` blocks stay runnable
-- top-to-bottom on a fresh database.

-- 56. GROOMING/BEAUTY INDUSTRY GATE — admin-editable allow/block/keyword
-- rules + a per-candidate rejection anomaly log. Fixes a real pre-launch bug:
-- competitor discovery (lib/analysisEngine.ts's selectByCompositeScore) was
-- scoring candidates on motor-keyword match alone, with zero category/
-- industry awareness — an "Electric Weed Wacker with Wheel" (Patio/Lawn) and
-- a "Waterproof Brushless DC Motor... for Efoil Electric Surfboard" (a bare
-- motor/component) both scored as strong "competitors" for a hair clipper.
-- One flat, rule_type-discriminated table (not six) — same precedent as
-- Section 27's motor_tech_search_misses -> branded misses via a nullable
-- discriminator column rather than a forked table.
CREATE TABLE IF NOT EXISTS grooming_gate_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rule_type VARCHAR(40) NOT NULL,  -- allow_category_segment | block_category_segment |
                                     -- required_keyword | disqualifying_keyword |
                                     -- trimmer_cosignal_keyword | component_disqualifier |
                                     -- cross_domain_use_phrase | confidence_threshold
    value VARCHAR(255) NOT NULL,
    label VARCHAR(255),
    enabled BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS grooming_gate_rules_type_idx ON grooming_gate_rules(rule_type);
CREATE UNIQUE INDEX IF NOT EXISTS grooming_gate_rules_type_value_idx ON grooming_gate_rules(rule_type, value);
ALTER TABLE grooming_gate_rules ENABLE ROW LEVEL SECURITY;
-- No policy added — RLS enabled, zero policies, deny-by-default for anon/
-- authenticated (per the Section 17/55 convention above). Only ever queried
-- via supabaseAdmin in lib/db/grooming-gate-rules.ts.

-- Default rule set — MUST mirror lib/memoryDb.ts's seedGroomingGateRuleDefaults()
-- exactly, or local dev (memoryDb) and production (this table) gate
-- differently. Without this INSERT, a fresh grooming_gate_rules table has
-- zero required_keyword rows, which makes passesGroomingIndustryGate's 1B
-- check reject EVERY candidate (a required-keyword hit can never exist
-- against an empty rule list) — competitor discovery would silently return
-- zero competitors for every analysis. Idempotent via the unique index above.
INSERT INTO grooming_gate_rules (rule_type, value, label) VALUES
    ('allow_category_segment', 'Beauty & Personal Care', NULL),
    ('allow_category_segment', 'Hair Care', NULL),
    ('allow_category_segment', 'Hair Cutting Tools', NULL),
    ('allow_category_segment', 'Hair Clippers', NULL),
    ('allow_category_segment', 'Hair Trimmers', NULL),
    ('allow_category_segment', 'Shave & Hair Removal', NULL),
    ('allow_category_segment', 'Electric Shavers', NULL),
    ('allow_category_segment', 'Men''s Grooming', NULL),
    ('allow_category_segment', 'Hair Dryers', NULL),
    ('allow_category_segment', 'Hair Styling Tools', NULL),
    ('allow_category_segment', 'Flat Irons', NULL),
    ('allow_category_segment', 'Curling Irons', NULL),
    ('allow_category_segment', 'Tools & Accessories', NULL),
    ('block_category_segment', 'Patio, Lawn & Garden', NULL),
    ('block_category_segment', 'Tools & Home Improvement', NULL),
    ('block_category_segment', 'Power & Hand Tools', NULL),
    ('block_category_segment', 'Outdoor Power Tools', NULL),
    ('block_category_segment', 'Automotive', NULL),
    ('block_category_segment', 'Kitchen & Dining', NULL),
    ('block_category_segment', 'Appliances', NULL),
    ('block_category_segment', 'Industrial & Scientific', NULL),
    ('block_category_segment', 'Pet Supplies', NULL),
    ('block_category_segment', 'Toys & Games', NULL),
    ('block_category_segment', 'Sports & Outdoors', NULL),
    ('block_category_segment', 'Garden', NULL),
    ('block_category_segment', 'Lawn Mowers', NULL),
    ('block_category_segment', 'String Trimmers', NULL),
    ('block_category_segment', 'Weed Trimmers', NULL),
    ('block_category_segment', 'Hedge Trimmers', NULL),
    ('block_category_segment', 'Brush Cutters', NULL),
    ('block_category_segment', 'Drills', NULL),
    ('block_category_segment', 'Saws', NULL),
    ('required_keyword', 'hair', NULL),
    ('required_keyword', 'clipper', NULL),
    ('required_keyword', 'trimmer', NULL),
    ('required_keyword', 'shaver', NULL),
    ('required_keyword', 'foil', NULL),
    ('required_keyword', 'beard', NULL),
    ('required_keyword', 'barber', NULL),
    ('required_keyword', 'grooming', NULL),
    ('required_keyword', 'haircut', NULL),
    ('required_keyword', 'hair dryer', NULL),
    ('required_keyword', 'blow dryer', NULL),
    ('required_keyword', 'flat iron', NULL),
    ('required_keyword', 'curling', NULL),
    ('required_keyword', 'styling', NULL),
    ('required_keyword', 'razor', NULL),
    ('required_keyword', 'edger', NULL),
    ('required_keyword', 'lining', NULL),
    ('required_keyword', 'fade', NULL),
    ('disqualifying_keyword', 'weed', NULL),
    ('disqualifying_keyword', 'grass', NULL),
    ('disqualifying_keyword', 'lawn', NULL),
    ('disqualifying_keyword', 'garden', NULL),
    ('disqualifying_keyword', 'hedge', NULL),
    ('disqualifying_keyword', 'string trimmer', NULL),
    ('disqualifying_keyword', 'brush cutter', NULL),
    ('disqualifying_keyword', 'wacker', NULL),
    ('disqualifying_keyword', 'whacker', NULL),
    ('disqualifying_keyword', 'drill', NULL),
    ('disqualifying_keyword', 'saw', NULL),
    ('disqualifying_keyword', 'sander', NULL),
    ('disqualifying_keyword', 'tire', NULL),
    ('disqualifying_keyword', 'engine', NULL),
    ('disqualifying_keyword', 'kitchen', NULL),
    ('disqualifying_keyword', 'blender', NULL),
    ('disqualifying_keyword', 'vacuum', NULL),
    ('disqualifying_keyword', 'wood', NULL),
    ('disqualifying_keyword', 'metal cutting', NULL),
    ('disqualifying_keyword', 'automotive', NULL),
    ('disqualifying_keyword', 'dog grooming', 'Skipped when our own product is pet grooming'),
    ('disqualifying_keyword', 'pet grooming', 'Skipped when our own product is pet grooming'),
    ('disqualifying_keyword', 'animal grooming', 'Skipped when our own product is pet grooming'),
    ('trimmer_cosignal_keyword', 'beard', NULL),
    ('trimmer_cosignal_keyword', 'hair', NULL),
    ('trimmer_cosignal_keyword', 'barber', NULL),
    ('trimmer_cosignal_keyword', 'body', NULL),
    ('trimmer_cosignal_keyword', 'mustache', NULL),
    ('trimmer_cosignal_keyword', 'ear', NULL),
    ('trimmer_cosignal_keyword', 'nose', NULL),
    ('component_disqualifier', 'brushless motor', NULL),
    ('component_disqualifier', 'dc motor', NULL),
    ('component_disqualifier', 'outrunner motor', NULL),
    ('component_disqualifier', 'motor kit', NULL),
    ('component_disqualifier', 'replacement motor', NULL),
    ('component_disqualifier', 'esc', NULL),
    ('component_disqualifier', 'propeller', NULL),
    ('component_disqualifier', 'stator', NULL),
    ('component_disqualifier', 'armature', NULL),
    ('component_disqualifier', 'dynamo', NULL),
    ('component_disqualifier', 'gear motor', NULL),
    ('component_disqualifier', 'servo motor', NULL),
    ('cross_domain_use_phrase', 'surfboard', NULL),
    ('cross_domain_use_phrase', 'efoil', NULL),
    ('cross_domain_use_phrase', 'drone', NULL),
    ('cross_domain_use_phrase', 'rc car', NULL),
    ('cross_domain_use_phrase', 'boat', NULL),
    ('cross_domain_use_phrase', 'underwater', NULL),
    ('cross_domain_use_phrase', 'marine', NULL),
    ('cross_domain_use_phrase', 'thruster', NULL),
    ('cross_domain_use_phrase', 'lawn mower', NULL),
    ('confidence_threshold', '0.4', 'Minimum same-tool-kind confidence to survive the gate')
ON CONFLICT (rule_type, value) DO NOTHING;

-- Anomaly log — a separate table (not a rule_type on the table above) since
-- its rows are per-candidate audit records with a different shape entirely,
-- same reasoning that kept competitor_corrections separate from
-- motor_families despite both living under "competitor matching."
CREATE TABLE IF NOT EXISTS grooming_gate_incidents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_id UUID,                  -- nullable, no FK — same precedent as competitor_corrections.analysis_id
    phase VARCHAR(20) NOT NULL,        -- 'phase1' | 'phase2' | 'manual_removal'
    candidate_name VARCHAR(500),
    candidate_asin VARCHAR(20),
    candidate_brand VARCHAR(255),
    category_path TEXT,
    failed_rule VARCHAR(40),           -- nullable — a manual_removal incident has no automated rule to name
    detail TEXT,
    dismissed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS grooming_gate_incidents_created_idx ON grooming_gate_incidents(created_at DESC);
ALTER TABLE grooming_gate_incidents ENABLE ROW LEVEL SECURITY;
-- No policy added — same deny-by-default convention as above.

-- 57. REMOVE-WITHOUT-REPLACEMENT SUPPORT — competitor_corrections
-- The new per-competitor "Remove" action (lib/analysisEngine.ts's
-- removeCompetitorSlot) records a correction with no replacement ASIN yet
-- known (new_asin was NOT NULL before this). correction_type distinguishes
-- a remove (no new_asin, may be refilled later without a second correction
-- row) from the existing replace flow (new_asin always populated).
ALTER TABLE competitor_corrections ALTER COLUMN new_asin DROP NOT NULL;
ALTER TABLE competitor_corrections ADD COLUMN IF NOT EXISTS correction_type VARCHAR(20) NOT NULL DEFAULT 'replace';

-- 58. REFERENCE LINKS — up to 5 user-supplied reference URLs (product pages,
-- competitor/brand sites) per project, added on the Sources tab. Checked
-- FIRST (their fetched page text is prepended to GTM/Content Form generation
-- prompts as a top-priority external source, ahead of the AI's own web
-- search) before any field falls back to general AI knowledge/web search.
-- A plain JSONB array (not a separate table) — a small, fixed-size (5),
-- user-edited list, not a growing per-file record like source docs.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS reference_urls JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 59. PREDECESSOR PRODUCT REFERENCE — a single optional name or link to an
-- existing/prior product this project's product is a modified version of,
-- pasted on the analyze form next to Related Products. Resolved fresh at
-- GTM generation time (lib/predecessor-product-context.ts, never cached —
-- same discipline as reference_urls above) into a FALLBACK-ONLY grounding
-- block: an existing project's own real GTM answers first (richest), then
-- a StyleCraft catalog match, then an Amazon ASIN/URL or any other product
-- page. Plain text, not a URL type — it may be a product name, not a link.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS predecessor_ref VARCHAR(500);

-- 60. GROOMING GATE: ADD BARE "dryer" REQUIRED KEYWORD — Section 56's
-- required_keyword list had "hair dryer"/"blow dryer" but not bare "dryer",
-- so a real Amazon title that never spells out "hair" (e.g. "Conair
-- InfinitiPRO Dryer") was wrongly rejected by passesGroomingIndustryGate's
-- 1B check at the pre-enrichment stage (no category data yet to fall back
-- on). Bare "dryer" is consistent with the "dryer" tool type's own alias
-- list already treating it as sufficient evidence. Mirrors
-- lib/memoryDb.ts's seedGroomingGateRuleDefaults(). Idempotent via Section
-- 56's unique index on (rule_type, value).
INSERT INTO grooming_gate_rules (rule_type, value, label) VALUES
    ('required_keyword', 'dryer', NULL)
ON CONFLICT (rule_type, value) DO NOTHING;
