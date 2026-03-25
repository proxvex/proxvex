-- PostgREST-compatible schema for livetest results
-- Usage: psql -U postgres -d livetest -f test_results.sql

CREATE TABLE IF NOT EXISTS test_results (
  id SERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  application TEXT NOT NULL,
  variant TEXT NOT NULL,
  task TEXT NOT NULL DEFAULT 'installation',
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
  vm_id INTEGER,
  hostname TEXT,
  stack_name TEXT,
  addons JSONB DEFAULT '[]',
  duration_seconds INTEGER,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  deployer_version TEXT,
  deployer_git_hash TEXT,
  dependencies JSONB DEFAULT '[]',
  verify_results JSONB DEFAULT '{}',
  error_message TEXT,
  skipped_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_test_results_run_id ON test_results (run_id);
CREATE INDEX IF NOT EXISTS idx_test_results_scenario_id ON test_results (scenario_id);
CREATE INDEX IF NOT EXISTS idx_test_results_status ON test_results (status);
