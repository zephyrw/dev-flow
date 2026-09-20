package main

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// All host operations in these tests are memory-only. No Windows credential,
// DPAPI, named-mutex, login or user-vault API is invoked.
type isolatedBackend struct {
	current                                    CredentialRecord
	saved                                      map[string]VaultEnvelope
	writes, loads, deletes, acquired, released int
	failSave, ignoreWrite                      bool
}

func isolated(t *testing.T) *isolatedBackend {
	t.Helper()
	read, write, save, load, del := credentialRead, credentialWrite, vaultSave, vaultLoad, vaultDelete
	revision, acquire, release := revisionAllocate, domainAcquire, domainRelease
	handle, id, ref, realm, last := lockHandle, lockID, activeRef, activeRealm, lastRevision
	t.Cleanup(func() {
		credentialRead, credentialWrite, vaultSave, vaultLoad, vaultDelete = read, write, save, load, del
		revisionAllocate, domainAcquire, domainRelease = revision, acquire, release
		lockHandle, lockID, activeRef, activeRealm, lastRevision = handle, id, ref, realm, last
	})
	b := &isolatedBackend{saved: map[string]VaultEnvelope{}}
	credentialRead = func(target string) (*CredentialRecord, error) {
		if target != FIXED_CREDENTIAL_TARGET {
			t.Fatal("wrong credential target")
		}
		copy := b.current
		return &copy, nil
	}
	credentialWrite = func(target string, value *CredentialRecord) error {
		if target != FIXED_CREDENTIAL_TARGET {
			t.Fatal("wrong credential target")
		}
		b.writes++
		if !b.ignoreWrite {
			b.current = *value
		}
		return nil
	}
	vaultSave = func(realm, ref string, value *VaultEnvelope) error {
		if b.failSave {
			return errors.New("isolated_save_failure")
		}
		b.saved[realm+":"+ref] = *value
		return nil
	}
	vaultLoad = func(realm, ref string) (*VaultEnvelope, error) {
		b.loads++
		value, ok := b.saved[realm+":"+ref]
		if !ok {
			return nil, errors.New("isolated_not_found")
		}
		return &value, nil
	}
	vaultDelete = func(realm, ref string) error { b.deletes++; delete(b.saved, realm+":"+ref); return nil }
	var sequence int64 = 100
	revisionAllocate = func(string) (int64, error) { sequence++; return sequence, nil }
	domainAcquire = func() (uintptr, error) { b.acquired++; return 42, nil }
	domainRelease = func(handle uintptr) error {
		if handle != 42 {
			t.Fatal("wrong lock")
		}
		b.released++
		return nil
	}
	lockHandle, lockID, activeRef, activeRealm = 42, "isolated-lock", "", ""
	return b
}

func request(t *testing.T, action string, args CommonArgs) (interface{}, error) {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	return handleAction(action, raw)
}

func TestClearActiveRequiresSuccessfulBackup(t *testing.T) {
	b := isolated(t)
	b.current = CredentialRecord{Exists: true, Secret: []byte("synthetic")}
	b.failSave = true
	_, err := request(t, "clear-active-for-login", CommonArgs{RealmId: "test"})
	if err == nil || b.writes != 0 || !b.current.Exists {
		t.Fatal("failed backup must preserve active credential")
	}
}

func TestAbsentCredentialRoundTrip(t *testing.T) {
	b := isolated(t)
	value, err := request(t, "capture-active", CommonArgs{RealmId: "test"})
	if err != nil {
		t.Fatal(err)
	}
	ref := value.(map[string]interface{})["secret_ref"].(string)
	b.current = CredentialRecord{Exists: true, Secret: []byte("synthetic")}
	_, err = request(t, "restore-backup", CommonArgs{RealmId: "test", BackupRef: ref})
	if err != nil || b.current.Exists {
		t.Fatalf("absent backup was not restored: %v", err)
	}
}

func TestClearActiveVerifiesReadback(t *testing.T) {
	b := isolated(t)
	b.current = CredentialRecord{Exists: true, Secret: []byte("synthetic")}
	b.ignoreWrite = true
	_, err := request(t, "clear-active-for-login", CommonArgs{RealmId: "test"})
	if err == nil || err.Error() != "credential_readback_mismatch" {
		t.Fatalf("expected clear readback failure: %v", err)
	}
	if len(b.saved) != 1 {
		t.Fatal("backup must survive clear failure")
	}
}

func TestActivationVerifiesReadback(t *testing.T) {
	b := isolated(t)
	value, err := request(t, "capture-active", CommonArgs{RealmId: "test"})
	if err != nil {
		t.Fatal(err)
	}
	b.current = CredentialRecord{Exists: true, Secret: []byte("synthetic")}
	b.ignoreWrite = true
	_, err = request(t, "activate-saved", CommonArgs{RealmId: "test", SecretRef: value.(map[string]interface{})["secret_ref"].(string)})
	if err == nil || err.Error() != "credential_readback_mismatch" {
		t.Fatalf("expected readback failure, got %v", err)
	}
}

func TestCredentialEnvelopeRoundTrip(t *testing.T) {
	b := isolated(t)
	original := CredentialRecord{Exists: true, Flags: 2, Username: "synthetic-user", Comment: "synthetic-comment", Persist: 2, TargetAlias: "synthetic-alias", Secret: []byte("synthetic-secret"), Attributes: []CredentialAttribute{{Keyword: "synthetic-key", Flags: 3, Value: []byte{1, 2, 3}}}}
	b.current = original
	value, err := request(t, "capture-active", CommonArgs{RealmId: "test", AccountId: "synthetic-account"})
	if err != nil {
		t.Fatal(err)
	}
	public, _ := json.Marshal(value)
	if strings.Contains(string(public), "synthetic") || strings.Contains(string(public), "Secret") {
		t.Fatal("secret metadata leaked through capture response")
	}
	ref := value.(map[string]interface{})["secret_ref"].(string)
	b.current = CredentialRecord{}
	_, err = request(t, "activate-saved", CommonArgs{RealmId: "test", SecretRef: ref})
	if err != nil || !reflect.DeepEqual(b.current, original) {
		t.Fatalf("incomplete credential restore: %v", err)
	}
}

func TestDomainLockRequired(t *testing.T) {
	isolated(t)
	lockHandle = 0
	credentialRead = func(string) (*CredentialRecord, error) { t.Fatal("credential read without lock"); return nil, nil }
	_, err := request(t, "capture-active", CommonArgs{RealmId: "test"})
	if err == nil || err.Error() != "domain_lock_not_held" {
		t.Fatalf("got %v", err)
	}
}

func TestDomainLockLifetime(t *testing.T) {
	b := isolated(t)
	lockHandle = 0
	_, err := request(t, "acquire-domain-lock", CommonArgs{RealmId: "first"})
	if err != nil || lockHandle == 0 {
		t.Fatal("lock not held after response")
	}
	_, err = request(t, "acquire-domain-lock", CommonArgs{RealmId: "other"})
	if err == nil || b.acquired != 1 {
		t.Fatal("realm must not split domain lock")
	}
	_, err = request(t, "release-domain-lock", CommonArgs{RealmId: "first", LockId: lockID})
	if err != nil || lockHandle != 0 || b.released != 1 {
		t.Fatal("lock not released")
	}
}

func TestInvalidReferenceBeforeBackend(t *testing.T) {
	b := isolated(t)
	for _, action := range []string{"activate-saved", "compare-active", "delete-saved"} {
		_, err := request(t, action, CommonArgs{RealmId: "test", SecretRef: "../escape"})
		if err == nil || err.Error() != "invalid_reference" {
			t.Fatalf("%s: %v", action, err)
		}
	}
	if b.loads != 0 || b.deletes != 0 || b.writes != 0 {
		t.Fatal("invalid reference reached backend")
	}
}

func TestCaptureRevisionFailurePreservesCredential(t *testing.T) {
	b := isolated(t)
	revisionAllocate = func(string) (int64, error) { return 0, errors.New("isolated_revision_failure") }
	_, err := request(t, "clear-active-for-login", CommonArgs{RealmId: "test"})
	if err == nil || b.writes != 0 || len(b.saved) != 0 {
		t.Fatal("revision failure must stop mutation")
	}
}
