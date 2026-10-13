-- Transfer reservations never authorize source work until the terminal CAS.
-- Abort receipts remain durable and cannot later become active.
CREATE TABLE IF NOT EXISTS import_operations (
 operation_id TEXT PRIMARY KEY, stage_id TEXT NOT NULL UNIQUE,
 source_id TEXT NOT NULL UNIQUE REFERENCES systems(id),
 actor_id TEXT NOT NULL REFERENCES principals(id),
 fingerprint TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
 state TEXT NOT NULL CHECK(state IN ('prepared','sealed','active','aborted')),
 activation_id TEXT, verification_json TEXT CHECK(verification_json IS NULL OR json_valid(verification_json)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- A transfer may abort before a full export exists. Never create or disable a
-- system for this tombstone; an already prepared import uses its normal abort.
CREATE TABLE IF NOT EXISTS import_abort_tombstones (
 operation_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, epoch INTEGER NOT NULL,
 input_json TEXT NOT NULL CHECK(json_valid(input_json)), actor_id TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS import_prepare_not_aborted BEFORE INSERT ON import_operations
WHEN EXISTS(SELECT 1 FROM import_abort_tombstones WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'Import operation is durably aborted'); END;
CREATE TRIGGER IF NOT EXISTS import_abort_not_prepared BEFORE INSERT ON import_abort_tombstones
WHEN EXISTS(SELECT 1 FROM import_operations WHERE operation_id=NEW.operation_id)
 OR EXISTS(SELECT 1 FROM systems WHERE id=NEW.source_id)
BEGIN SELECT RAISE(ABORT,'Existing source requires the prepared import abort protocol'); END;

-- Imported history identities are permanently non-authenticatable. Admin APIs
-- cannot later turn a historical actor into a user, service, publisher or admin.
CREATE TRIGGER IF NOT EXISTS imported_history_identity_insert BEFORE INSERT ON principals
WHEN NEW.issuer LIKE 'urn:timds:portal-history:%' AND (NEW.status<>'inactive' OR NEW.admin<>0)
BEGIN SELECT RAISE(ABORT,'History identities must remain inactive'); END;
CREATE TRIGGER IF NOT EXISTS imported_history_identity_update BEFORE UPDATE ON principals
WHEN (OLD.issuer LIKE 'urn:timds:portal-history:%' OR NEW.issuer LIKE 'urn:timds:portal-history:%')
 AND (NEW.status<>'inactive' OR NEW.admin<>0 OR NEW.id<>OLD.id OR NEW.issuer<>OLD.issuer OR NEW.subject<>OLD.subject OR NEW.type<>OLD.type)
BEGIN SELECT RAISE(ABORT,'History identity authority is immutable'); END;
CREATE TRIGGER IF NOT EXISTS imported_history_identity_grant BEFORE INSERT ON system_access
WHEN EXISTS(SELECT 1 FROM principals WHERE id=NEW.principal_id AND issuer LIKE 'urn:timds:portal-history:%')
BEGIN SELECT RAISE(ABORT,'History identities cannot receive grants'); END;
CREATE TRIGGER IF NOT EXISTS imported_history_identity_publisher BEFORE INSERT ON publishers
WHEN EXISTS(SELECT 1 FROM principals WHERE id=NEW.principal_id AND issuer LIKE 'urn:timds:portal-history:%')
BEGIN SELECT RAISE(ABORT,'History identities cannot publish'); END;

CREATE TRIGGER IF NOT EXISTS imported_history_identity_grant_update BEFORE UPDATE ON system_access
WHEN EXISTS(SELECT 1 FROM principals WHERE id=NEW.principal_id AND issuer LIKE 'urn:timds:portal-history:%')
BEGIN SELECT RAISE(ABORT,'History identities cannot receive grants'); END;
CREATE TRIGGER IF NOT EXISTS imported_history_identity_publisher_update BEFORE UPDATE ON publishers
WHEN EXISTS(SELECT 1 FROM principals WHERE id=NEW.principal_id AND issuer LIKE 'urn:timds:portal-history:%')
BEGIN SELECT RAISE(ABORT,'History identities cannot publish'); END;
