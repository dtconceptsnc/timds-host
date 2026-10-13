-- D1 owns identities, grants and durable cross-coordinator locators. DO SQLite
-- owns sessions, queues and published pointers. No transaction crosses both.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','archived'))
);
CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('user','agent')),
  name TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deactivating','inactive')),
  admin INTEGER NOT NULL DEFAULT 0 CHECK(admin IN (0,1)), version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(issuer,subject)
);
CREATE TABLE IF NOT EXISTS installation_bootstrap (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL REFERENCES principals(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS principal_deactivations (
  operation_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id),
  actor_id TEXT NOT NULL REFERENCES principals(id), version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed')), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS systems (
  id TEXT PRIMARY KEY, system_id TEXT NOT NULL UNIQUE, organization_id TEXT NOT NULL REFERENCES organizations(id),
  lifecycle_status TEXT NOT NULL, archived_at TEXT, artifacts_namespace TEXT NOT NULL,
  artifacts_repository TEXT NOT NULL, artifacts_repository_id TEXT,
  authority_version INTEGER NOT NULL DEFAULT 0, projection_seq INTEGER NOT NULL DEFAULT 0,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  UNIQUE(artifacts_namespace,artifacts_repository)
);
CREATE TABLE IF NOT EXISTS system_access (
  source_id TEXT NOT NULL REFERENCES systems(id), principal_id TEXT NOT NULL REFERENCES principals(id),
  can_read INTEGER NOT NULL DEFAULT 0 CHECK(can_read IN (0,1)),
  can_write INTEGER NOT NULL DEFAULT 0 CHECK(can_write IN (0,1)), PRIMARY KEY(source_id,principal_id)
);
CREATE TABLE IF NOT EXISTS publishers (
  source_id TEXT NOT NULL REFERENCES systems(id), principal_id TEXT NOT NULL REFERENCES principals(id),
  PRIMARY KEY(source_id,principal_id)
);
CREATE TABLE IF NOT EXISTS principal_fences (
  operation_id TEXT NOT NULL REFERENCES principal_deactivations(operation_id), source_id TEXT NOT NULL REFERENCES systems(id),
  fenced INTEGER NOT NULL DEFAULT 0 CHECK(fenced IN (0,1)), PRIMARY KEY(operation_id,source_id)
);
CREATE TABLE IF NOT EXISTS authority_operations (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES systems(id), expected_version INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES principals(id),
  confirmed_version INTEGER NOT NULL, command_json TEXT NOT NULL CHECK(json_valid(command_json)), created_at TEXT NOT NULL,
  UNIQUE(source_id,confirmed_version)
);
CREATE TABLE IF NOT EXISTS provision_operations (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE REFERENCES systems(id), actor_id TEXT NOT NULL REFERENCES principals(id),
  fingerprint TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
);
CREATE TABLE IF NOT EXISTS start_reservations (
  principal_id TEXT NOT NULL REFERENCES principals(id), idempotency_key TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES systems(id), session_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL, session_json TEXT NOT NULL CHECK(json_valid(session_json)),
  tombstone INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(principal_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS request_reservations (
  request_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES systems(id),
  fingerprint TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
);
CREATE TABLE IF NOT EXISTS resource_index (
  kind TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES systems(id),
  tombstone INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL, PRIMARY KEY(kind,id)
);
CREATE TABLE IF NOT EXISTS session_visibility (
  source_id TEXT NOT NULL REFERENCES systems(id), session_id TEXT NOT NULL, principal_id TEXT NOT NULL REFERENCES principals(id),
  status TEXT NOT NULL, expires_at TEXT, sequence INTEGER NOT NULL, PRIMARY KEY(session_id,principal_id)
);
CREATE INDEX IF NOT EXISTS session_visibility_principal ON session_visibility(principal_id,status,expires_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, kind TEXT NOT NULL, sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL, row_json TEXT NOT NULL CHECK(json_valid(row_json)), UNIQUE(source_id,sequence)
);
CREATE INDEX IF NOT EXISTS audit_events_source ON audit_events(source_id,created_at);
