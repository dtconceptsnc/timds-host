-- Explicit source grants reserved by an administrator. The invited human must
-- claim through their own verified Access issuer/email and stable subject.
-- These rows never merge an imported history identity or grant administration.
CREATE TABLE IF NOT EXISTS source_access_invitations (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES systems(id),
 issuer TEXT NOT NULL, email TEXT NOT NULL, requested_by TEXT NOT NULL REFERENCES principals(id),
 can_read INTEGER NOT NULL CHECK(can_read IN (0,1)),
 can_write INTEGER NOT NULL CHECK(can_write IN (0,1)),
 can_publish INTEGER NOT NULL CHECK(can_publish IN (0,1)),
 fingerprint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','revoked')),
 claimed_principal_id TEXT REFERENCES principals(id), claimed_subject TEXT, claimed_at TEXT,
 revoked_by TEXT REFERENCES principals(id), revoked_at TEXT, created_at TEXT NOT NULL,
 CHECK(can_read=1 OR can_write=1 OR can_publish=1), CHECK(can_write=0 OR can_read=1),
 CHECK((status='claimed' AND claimed_principal_id IS NOT NULL AND claimed_subject IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status<>'claimed' AND claimed_principal_id IS NULL AND claimed_subject IS NULL AND claimed_at IS NULL)),
 CHECK((status='revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
    OR (status<>'revoked' AND revoked_by IS NULL AND revoked_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_access_invitation ON source_access_invitations(source_id,issuer,email) WHERE status='pending';
CREATE INDEX IF NOT EXISTS access_invitation_login ON source_access_invitations(issuer,email,status);
CREATE TRIGGER IF NOT EXISTS access_invitation_insert_guard BEFORE INSERT ON source_access_invitations
WHEN NEW.status<>'pending'
 OR NOT EXISTS(SELECT 1 FROM principals WHERE id=NEW.requested_by AND status='active' AND admin=1)
 OR NOT EXISTS(SELECT 1 FROM systems s JOIN organizations o ON o.id=s.organization_id WHERE s.id=NEW.source_id AND s.lifecycle_status IN ('ready','importing') AND s.archived_at IS NULL AND o.status='active')
BEGIN SELECT RAISE(ABORT,'Access invitation source or administrator is unavailable'); END;
CREATE TRIGGER IF NOT EXISTS access_invitation_immutable BEFORE UPDATE ON source_access_invitations
WHEN OLD.status<>'pending' OR NEW.status NOT IN ('claimed','revoked')
 OR NEW.id IS NOT OLD.id OR NEW.source_id IS NOT OLD.source_id OR NEW.issuer IS NOT OLD.issuer
 OR NEW.email IS NOT OLD.email OR NEW.requested_by IS NOT OLD.requested_by OR NEW.fingerprint IS NOT OLD.fingerprint
 OR NEW.can_read IS NOT OLD.can_read OR NEW.can_write IS NOT OLD.can_write OR NEW.can_publish IS NOT OLD.can_publish OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'Access invitation binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS access_invitation_claim_guard BEFORE UPDATE ON source_access_invitations
WHEN NEW.status='claimed' AND (
 NOT EXISTS(SELECT 1 FROM systems s JOIN organizations o ON o.id=s.organization_id WHERE s.id=NEW.source_id AND s.lifecycle_status='ready' AND s.archived_at IS NULL AND o.status='active')
 OR NOT EXISTS(SELECT 1 FROM principals WHERE id=NEW.requested_by AND status='active' AND admin=1)
 OR NOT EXISTS(SELECT 1 FROM principals WHERE id=NEW.claimed_principal_id AND issuer=NEW.issuer AND subject=NEW.claimed_subject AND type='user' AND status='active')
)
BEGIN SELECT RAISE(ABORT,'Access invitation cannot be claimed by this identity or source'); END;
CREATE TRIGGER IF NOT EXISTS access_invitation_revoke_guard BEFORE UPDATE ON source_access_invitations
WHEN NEW.status='revoked' AND NOT EXISTS(SELECT 1 FROM principals WHERE id=NEW.revoked_by AND status='active' AND admin=1)
BEGIN SELECT RAISE(ABORT,'Access invitation revocation requires an active administrator'); END;
CREATE TRIGGER IF NOT EXISTS access_invitation_retained BEFORE DELETE ON source_access_invitations
BEGIN SELECT RAISE(ABORT,'Access invitation receipts are retained'); END;
