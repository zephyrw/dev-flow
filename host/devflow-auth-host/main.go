package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"runtime"
	"time"
)

const FIXED_CREDENTIAL_TARGET = "gemini:antigravity"
const AUTH_HOST_VERSION = "2.0.0"

type Request struct {
	Id     string          `json:"id"`
	Action string          `json:"action"`
	Args   json.RawMessage `json:"args"`
}
type Response struct {
	Id    string      `json:"id,omitempty"`
	Ok    bool        `json:"ok"`
	Data  interface{} `json:"data,omitempty"`
	Error string      `json:"error,omitempty"`
}
type CommonArgs struct {
	RealmId   string `json:"realm_id"`
	AccountId string `json:"account_id,omitempty"`
	SecretRef string `json:"secret_ref,omitempty"`
	BackupRef string `json:"backup_ref,omitempty"`
	LockId    string `json:"lock_id,omitempty"`
}
type CredentialAttribute struct {
	Keyword string
	Flags   uint32
	Value   []byte
}
type CredentialRecord struct {
	Exists      bool
	Flags       uint32
	Username    string
	Comment     string
	Persist     uint32
	TargetAlias string
	Attributes  []CredentialAttribute
	Secret      []byte
}
type VaultEnvelope struct {
	Version    int
	RealmID    string
	AccountID  string
	Revision   int64
	Credential CredentialRecord
}
type CredentialInfo struct {
	Exists    bool   `json:"exists"`
	SecretRef string `json:"secret_ref,omitempty"`
	AccountID string `json:"account_id,omitempty"`
}

var referencePattern = regexp.MustCompile(`^(sec|bak)_[a-f0-9]{32}$`)
var realmPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,150}$`)
var lockHandle uintptr
var lockID, activeRef, activeRealm string
var lastRevision int64

// Injectable only inside this package, so tests never access the user's credential store.
var credentialRead = readActiveCredential
var credentialWrite = writeActiveCredential
var vaultSave = saveVaultItem
var vaultLoad = loadVaultItem
var vaultDelete = deleteVaultItem
var revisionAllocate = nextVaultRevision
var domainAcquire = acquireNamedMutex
var domainRelease = releaseNamedMutex

func randomRef(prefix string) (string, error) {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return prefix + "_" + hex.EncodeToString(b), nil
}
func nextRevision() int64 {
	n := time.Now().UnixMilli()
	if n <= lastRevision {
		n = lastRevision + 1
	}
	lastRevision = n
	return n
}
func capture(a CommonArgs, prefix string) (map[string]interface{}, error) {
	c, e := credentialRead(FIXED_CREDENTIAL_TARGET)
	if e != nil {
		return nil, e
	}
	ref, e := randomRef(prefix)
	if e != nil {
		return nil, e
	}
	rev, e := revisionAllocate(a.RealmId)
	if e != nil {
		return nil, e
	}
	env := VaultEnvelope{Version: 2, RealmID: a.RealmId, AccountID: a.AccountId, Revision: rev, Credential: *c}
	if e = vaultSave(a.RealmId, ref, &env); e != nil {
		return nil, e
	}
	activeRef = ref
	activeRealm = a.RealmId
	return map[string]interface{}{"secret_ref": ref, "credential_revision": rev}, nil
}
func compare(realm, ref string) (bool, error) {
	if !referencePattern.MatchString(ref) {
		return false, errors.New("invalid_reference")
	}
	saved, e := vaultLoad(realm, ref)
	if e != nil {
		return false, e
	}
	current, e := credentialRead(FIXED_CREDENTIAL_TARGET)
	if e != nil {
		return false, e
	}
	a, _ := json.Marshal(saved.Credential)
	b, _ := json.Marshal(current)
	return string(a) == string(b), nil
}
func activate(realm, ref string) (interface{}, error) {
	if !referencePattern.MatchString(ref) {
		return nil, errors.New("invalid_reference")
	}
	saved, e := vaultLoad(realm, ref)
	if e != nil {
		return nil, e
	}
	if e = credentialWrite(FIXED_CREDENTIAL_TARGET, &saved.Credential); e != nil {
		return nil, e
	}
	ok, e := compare(realm, ref)
	if e != nil {
		return nil, e
	}
	if !ok {
		return nil, errors.New("credential_readback_mismatch")
	}
	activeRef = ref
	activeRealm = realm
	return map[string]interface{}{"credential_revision": saved.Revision}, nil
}
func handleAction(action string, raw json.RawMessage) (interface{}, error) {
	var a CommonArgs
	if len(raw) > 0 {
		if e := json.Unmarshal(raw, &a); e != nil {
			return nil, errors.New("invalid_arguments")
		}
	}
	if action == "capabilities" {
		s := runtime.GOOS == "windows"
		return map[string]interface{}{"supported": s, "platform": runtime.GOOS, "dpapi_available": s, "cred_manager_available": s, "named_mutex_available": s, "version": AUTH_HOST_VERSION}, nil
	}
	if !realmPattern.MatchString(a.RealmId) {
		return nil, errors.New("invalid_realm")
	}
	if action == "acquire-domain-lock" {
		if lockHandle != 0 {
			return nil, errors.New("domain_lock_already_held")
		}
		h, e := domainAcquire()
		if e != nil {
			return nil, e
		}
		id, e := randomRef("lck")
		if e != nil {
			domainRelease(h)
			return nil, e
		}
		lockHandle = h
		lockID = id
		return map[string]interface{}{"acquired": true, "lock_id": id}, nil
	}
	if lockHandle == 0 {
		return nil, errors.New("domain_lock_not_held")
	}
	switch action {
	case "release-domain-lock":
		if a.LockId != lockID {
			return nil, errors.New("invalid_lock")
		}
		if e := domainRelease(lockHandle); e != nil {
			return nil, e
		}
		lockHandle = 0
		lockID = ""
		return map[string]bool{"released": true}, nil
	case "inspect-active":
		c, e := credentialRead(FIXED_CREDENTIAL_TARGET)
		if e != nil {
			return nil, e
		}
		info := CredentialInfo{Exists: c.Exists}
		if activeRef != "" && activeRealm == a.RealmId {
			ok, e := compare(a.RealmId, activeRef)
			if e != nil {
				return nil, e
			}
			if ok {
				saved, e := vaultLoad(a.RealmId, activeRef)
				if e != nil {
					return nil, e
				}
				info.SecretRef = activeRef
				info.AccountID = saved.AccountID
			}
		}
		return info, nil
	case "capture-active":
		return capture(a, "sec")
	case "compare-active":
		same, e := compare(a.RealmId, a.SecretRef)
		return map[string]bool{"matches": same}, e
	case "activate-saved":
		return activate(a.RealmId, a.SecretRef)
	case "restore-backup":
		return activate(a.RealmId, a.BackupRef)
	case "clear-active-for-login":
		backup, e := capture(a, "bak")
		if e != nil {
			return nil, e
		}
		if e = credentialWrite(FIXED_CREDENTIAL_TARGET, &CredentialRecord{}); e != nil {
			return nil, e
		}
		current, e := credentialRead(FIXED_CREDENTIAL_TARGET)
		if e != nil {
			return nil, e
		}
		if current.Exists {
			return nil, errors.New("credential_readback_mismatch")
		}
		activeRef = ""
		return map[string]interface{}{"cleared": true, "backup_ref": backup["secret_ref"]}, nil
	case "delete-saved":
		if !referencePattern.MatchString(a.SecretRef) {
			return nil, errors.New("invalid_reference")
		}
		if activeRealm == a.RealmId && activeRef == a.SecretRef {
			return nil, errors.New("active_reference")
		}
		if e := vaultDelete(a.RealmId, a.SecretRef); e != nil {
			return nil, e
		}
		return map[string]bool{"deleted": true}, nil
	default:
		return nil, errors.New("unknown_action")
	}
}
func main() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer func() {
		if lockHandle != 0 {
			_ = domainRelease(lockHandle)
		}
	}()
	if len(os.Args) > 1 {
		if os.Args[1] == "--version" {
			fmt.Println("devflow-auth-host v" + AUTH_HOST_VERSION)
			return
		}
		fmt.Fprintln(os.Stderr, "Only NDJSON daemon mode is supported")
		os.Exit(1)
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 65536)
	for scanner.Scan() {
		var req Request
		var resp Response
		if e := json.Unmarshal(scanner.Bytes(), &req); e != nil {
			resp.Error = "invalid_json"
		} else {
			resp.Id = req.Id
			data, e := handleAction(req.Action, req.Args)
			resp.Ok = e == nil
			if e != nil {
				resp.Error = e.Error()
			} else {
				resp.Data = data
			}
		}
		out, _ := json.Marshal(resp)
		fmt.Println(string(out))
	}
}
