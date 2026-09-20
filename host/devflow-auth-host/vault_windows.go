//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"unsafe"
)

var (
	modCrypt32 = syscall.NewLazyDLL("crypt32.dll")

	procCryptProtectData   = modCrypt32.NewProc("CryptProtectData")
	procCryptUnprotectData = modCrypt32.NewProc("CryptUnprotectData")
	procLocalFree          = syscall.NewLazyDLL("kernel32.dll").NewProc("LocalFree")
)

type winDATA_BLOB struct {
	CbData uint32
	PbData *byte
}

func protectData(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return []byte{}, nil
	}
	inBlob := winDATA_BLOB{
		CbData: uint32(len(data)),
		PbData: &data[0],
	}
	var outBlob winDATA_BLOB

	// Current-user scope; never show an interactive prompt from the daemon.
	r1, _, err := procCryptProtectData.Call(
		uintptr(unsafe.Pointer(&inBlob)),
		0,
		0,
		0,
		0,
		1,
		uintptr(unsafe.Pointer(&outBlob)),
	)
	if r1 == 0 {
		return nil, errors.New("CryptProtectData failed: " + err.Error())
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(outBlob.PbData)))

	cipher := make([]byte, outBlob.CbData)
	copy(cipher, unsafe.Slice(outBlob.PbData, outBlob.CbData))
	return cipher, nil
}

func unprotectData(cipher []byte) ([]byte, error) {
	if len(cipher) == 0 {
		return []byte{}, nil
	}
	inBlob := winDATA_BLOB{
		CbData: uint32(len(cipher)),
		PbData: &cipher[0],
	}
	var outBlob winDATA_BLOB

	r1, _, err := procCryptUnprotectData.Call(
		uintptr(unsafe.Pointer(&inBlob)),
		0,
		0,
		0,
		0,
		1,
		uintptr(unsafe.Pointer(&outBlob)),
	)
	if r1 == 0 {
		return nil, errors.New("CryptUnprotectData failed: " + err.Error())
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(outBlob.PbData)))

	plain := make([]byte, outBlob.CbData)
	copy(plain, unsafe.Slice(outBlob.PbData, outBlob.CbData))
	return plain, nil
}

func getVaultDir(realmId string) (string, error) {
	if !realmPattern.MatchString(realmId) {
		return "", errors.New("invalid_realm")
	}
	base := os.Getenv("LOCALAPPDATA")
	if base == "" || !filepath.IsAbs(base) {
		return "", errors.New("local_appdata_unavailable")
	}
	dir := filepath.Join(base, "DevFlow", "agy-accounts", realmId)
	for _, p := range []string{filepath.Join(base, "DevFlow"), filepath.Join(base, "DevFlow", "agy-accounts"), dir} {
		if e := os.MkdirAll(p, 0700); e != nil {
			return "", e
		}
		info, e := os.Lstat(p)
		if e != nil {
			return "", e
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return "", errors.New("vault_reparse_path")
		}
		if p != filepath.Join(base, "DevFlow") {
			if e = restrictPath(p); e != nil {
				return "", e
			}
		}
	}
	return dir, nil
}
func vaultPath(realm, ref string) (string, error) {
	if !referencePattern.MatchString(ref) {
		return "", errors.New("invalid_reference")
	}
	dir, e := getVaultDir(realm)
	if e != nil {
		return "", e
	}
	p := filepath.Join(dir, ref+".bin")
	if info, e := os.Lstat(p); e == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("vault_reparse_path")
	} else if e != nil && !os.IsNotExist(e) {
		return "", e
	}
	return p, nil
}
func saveVaultItem(realm, ref string, env *VaultEnvelope) error {
	path, e := vaultPath(realm, ref)
	if e != nil {
		return e
	}
	data, e := json.Marshal(env)
	if e != nil {
		return e
	}
	encrypted, e := protectData(data)
	if e != nil {
		return e
	}
	file, e := os.CreateTemp(filepath.Dir(path), ".vault-*")
	if e != nil {
		return e
	}
	temp := file.Name()
	defer os.Remove(temp)
	if e = restrictPath(temp); e != nil {
		file.Close()
		return e
	}
	if _, e = file.Write(encrypted); e != nil {
		file.Close()
		return e
	}
	if e = file.Sync(); e != nil {
		file.Close()
		return e
	}
	if e = file.Close(); e != nil {
		return e
	}
	if e = os.Rename(temp, path); e != nil {
		return e
	}
	return restrictPath(path)
}
func loadVaultItem(realm, ref string) (*VaultEnvelope, error) {
	path, e := vaultPath(realm, ref)
	if e != nil {
		return nil, e
	}
	encrypted, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	plain, e := unprotectData(encrypted)
	if e != nil {
		return nil, e
	}
	var env VaultEnvelope
	if e = json.Unmarshal(plain, &env); e != nil {
		return nil, errors.New("invalid_vault_envelope")
	}
	if env.Version != 2 || env.RealmID != realm || env.Revision < 1 {
		return nil, errors.New("incompatible_vault_envelope")
	}
	return &env, nil
}
func deleteVaultItem(realm, ref string) error {
	path, e := vaultPath(realm, ref)
	if e != nil {
		return e
	}
	return os.Remove(path)
}

// The domain mutex serializes allocation across daemon restarts. A failed durable
// allocation must stop capture before it can change an active credential.
func nextVaultRevision(realm string) (int64, error) {
	dir, e := getVaultDir(realm)
	if e != nil {
		return 0, e
	}
	return allocateVaultRevision(dir, restrictPath)
}

func allocateVaultRevision(dir string, restrict func(string) error) (int64, error) {
	path := filepath.Join(dir, "revision")
	if info, e := os.Lstat(path); e == nil && info.Mode()&os.ModeSymlink != 0 {
		return 0, errors.New("vault_reparse_path")
	} else if e != nil && !os.IsNotExist(e) {
		return 0, e
	}
	previous := int64(0)
	if data, e := os.ReadFile(path); e == nil {
		previous, e = strconv.ParseInt(string(data), 10, 64)
		if e != nil || previous < 0 {
			return 0, errors.New("invalid_vault_revision")
		}
	} else if !os.IsNotExist(e) {
		return 0, e
	}
	if previous >= 9007199254740991 {
		return 0, errors.New("vault_revision_exhausted")
	}
	next := nextRevision()
	if next <= previous {
		next = previous + 1
	}
	if next > 9007199254740991 {
		return 0, errors.New("vault_revision_exhausted")
	}
	file, e := os.CreateTemp(dir, ".revision-*")
	if e != nil {
		return 0, e
	}
	temp := file.Name()
	defer os.Remove(temp)
	defer file.Close()
	if e = restrict(temp); e != nil {
		return 0, e
	}
	if _, e = file.WriteString(strconv.FormatInt(next, 10)); e != nil {
		return 0, e
	}
	if e = file.Sync(); e != nil {
		return 0, e
	}
	if e = file.Close(); e != nil {
		return 0, e
	}
	if e = os.Rename(temp, path); e != nil {
		return 0, e
	}
	lastRevision = next
	return next, nil
}
