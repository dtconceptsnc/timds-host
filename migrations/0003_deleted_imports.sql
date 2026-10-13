-- Already-deleted portal sources carry only the immutable identity and the
-- completed delete evidence. No grants, public pointer or provider resources.
CREATE TABLE IF NOT EXISTS import_deleted_sources (
 operation_id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE REFERENCES systems(id),
 actor_id TEXT NOT NULL REFERENCES principals(id), fingerprint TEXT NOT NULL,
 input_json TEXT NOT NULL CHECK(json_valid(input_json)), created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS deleted_import_valid_reservation BEFORE INSERT ON import_deleted_sources
WHEN EXISTS(SELECT 1 FROM import_operations WHERE operation_id=NEW.operation_id OR source_id=NEW.source_id)
 OR EXISTS(SELECT 1 FROM import_abort_tombstones WHERE operation_id=NEW.operation_id)
 OR NOT EXISTS(SELECT 1 FROM principals WHERE id=NEW.actor_id AND admin=1 AND status='active')
 OR NOT EXISTS(SELECT 1 FROM systems s JOIN organizations o ON o.id=s.organization_id WHERE s.id=NEW.source_id AND s.lifecycle_status='deleted' AND o.status='active' AND json_extract(s.source_json,'$.imported_deleted_identity.operationId')=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'Invalid deleted-source reservation'); END;
CREATE TRIGGER IF NOT EXISTS deleted_import_immutable_update BEFORE UPDATE ON import_deleted_sources
BEGIN SELECT RAISE(ABORT,'Deleted-source receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS deleted_import_immutable_delete BEFORE DELETE ON import_deleted_sources
BEGIN SELECT RAISE(ABORT,'Deleted-source receipts are permanent'); END;
CREATE TRIGGER IF NOT EXISTS import_prepare_not_deleted BEFORE INSERT ON import_operations
WHEN EXISTS(SELECT 1 FROM import_deleted_sources WHERE operation_id=NEW.operation_id OR source_id=NEW.source_id)
BEGIN SELECT RAISE(ABORT,'Deleted-source identity cannot activate'); END;
CREATE TRIGGER IF NOT EXISTS import_abort_not_deleted BEFORE INSERT ON import_abort_tombstones
WHEN EXISTS(SELECT 1 FROM import_deleted_sources WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'Deleted-source operation is terminal'); END;

-- Also defend completed native deletions. Outbox projection_seq advancement
-- remains allowed; identity, lifecycle and source content never revive.
CREATE TRIGGER IF NOT EXISTS deleted_system_identity_immutable BEFORE UPDATE ON systems
WHEN OLD.lifecycle_status='deleted' AND (NEW.id IS NOT OLD.id OR NEW.system_id IS NOT OLD.system_id
 OR NEW.organization_id IS NOT OLD.organization_id OR NEW.lifecycle_status IS NOT OLD.lifecycle_status
 OR NEW.archived_at IS NOT OLD.archived_at OR NEW.artifacts_namespace IS NOT OLD.artifacts_namespace
 OR NEW.artifacts_repository IS NOT OLD.artifacts_repository OR NEW.artifacts_repository_id IS NOT OLD.artifacts_repository_id
 OR NEW.source_json IS NOT OLD.source_json)
BEGIN SELECT RAISE(ABORT,'Deleted source identity is permanent'); END;
CREATE TRIGGER IF NOT EXISTS deleted_system_identity_retained BEFORE DELETE ON systems
WHEN OLD.lifecycle_status='deleted'
BEGIN SELECT RAISE(ABORT,'Deleted source identity is permanent'); END;
CREATE TRIGGER IF NOT EXISTS deleted_system_grant_insert BEFORE INSERT ON system_access
WHEN EXISTS(SELECT 1 FROM systems WHERE id=NEW.source_id AND lifecycle_status='deleted')
BEGIN SELECT RAISE(ABORT,'Deleted source cannot receive grants'); END;
CREATE TRIGGER IF NOT EXISTS deleted_system_grant_update BEFORE UPDATE ON system_access
WHEN (NEW.can_read=1 OR NEW.can_write=1) AND EXISTS(SELECT 1 FROM systems WHERE id=NEW.source_id AND lifecycle_status='deleted')
BEGIN SELECT RAISE(ABORT,'Deleted source cannot receive grants'); END;
CREATE TRIGGER IF NOT EXISTS deleted_system_publisher_insert BEFORE INSERT ON publishers
WHEN EXISTS(SELECT 1 FROM systems WHERE id=NEW.source_id AND lifecycle_status='deleted')
BEGIN SELECT RAISE(ABORT,'Deleted source cannot receive publishers'); END;
CREATE TRIGGER IF NOT EXISTS deleted_system_publisher_update BEFORE UPDATE ON publishers
WHEN EXISTS(SELECT 1 FROM systems WHERE id=NEW.source_id AND lifecycle_status='deleted')
BEGIN SELECT RAISE(ABORT,'Deleted source cannot receive publishers'); END;
