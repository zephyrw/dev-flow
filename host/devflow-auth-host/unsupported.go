//go:build !windows

package main

import "errors"

var errUnsupported = errors.New("auth_host_platform_unsupported")

func readActiveCredential(string) (*CredentialRecord, error) { return nil, errUnsupported }
func writeActiveCredential(string, *CredentialRecord) error  { return errUnsupported }
func saveVaultItem(string, string, *VaultEnvelope) error     { return errUnsupported }
func loadVaultItem(string, string) (*VaultEnvelope, error)   { return nil, errUnsupported }
func deleteVaultItem(string, string) error                   { return errUnsupported }
func acquireNamedMutex() (uintptr, error)                    { return 0, errUnsupported }
func releaseNamedMutex(uintptr) error                        { return errUnsupported }
func nextVaultRevision(string) (int64, error)                { return 0, errUnsupported }
