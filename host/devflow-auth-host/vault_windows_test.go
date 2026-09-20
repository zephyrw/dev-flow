//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// This exercises only temporary files with a fake ACL callback: no SID lookup,
// DPAPI, credential-store or configured vault path is accessed.
func TestVaultRevisionSurvivesClockAndProcessReset(t *testing.T) {
	dir := t.TempDir()
	const previous int64 = 8000000000000
	path := filepath.Join(dir, "revision")
	if err := os.WriteFile(path, []byte(strconv.FormatInt(previous, 10)), 0600); err != nil {
		t.Fatal(err)
	}
	old := lastRevision
	t.Cleanup(func() { lastRevision = old })
	lastRevision = 0
	first, err := allocateVaultRevision(dir, func(string) error { return nil })
	if err != nil || first != previous+1 {
		t.Fatalf("first allocation: %d %v", first, err)
	}
	lastRevision = 0
	second, err := allocateVaultRevision(dir, func(string) error { return nil })
	if err != nil || second != first+1 {
		t.Fatalf("second allocation: %d %v", second, err)
	}
}

func TestCorruptVaultRevisionFailsClosed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "revision")
	if err := os.WriteFile(path, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := allocateVaultRevision(dir, func(string) error { t.Fatal("unexpected mutation"); return nil })
	if err == nil {
		t.Fatal("corrupt durable revision accepted")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "corrupt" {
		t.Fatal("corrupt counter replaced")
	}
}
