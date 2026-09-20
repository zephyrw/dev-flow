//go:build windows

package main

import (
	"crypto/sha256"
	"fmt"
	"syscall"
	"unsafe"
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var createMutex = kernel32.NewProc("CreateMutexW")
var releaseMutex = kernel32.NewProc("ReleaseMutex")
var waitHandle = kernel32.NewProc("WaitForSingleObject")
var localFree = kernel32.NewProc("LocalFree")
var convertSD = advapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
var setFileSecurity = advapi32.NewProc("SetFileSecurityW")

func currentSID() (string, error) {
	var token syscall.Token
	process, e := syscall.GetCurrentProcess()
	if e != nil {
		return "", e
	}
	if e = syscall.OpenProcessToken(process, syscall.TOKEN_QUERY, &token); e != nil {
		return "", e
	}
	defer token.Close()
	user, e := token.GetTokenUser()
	if e != nil {
		return "", e
	}
	return user.User.Sid.String()
}
func securityDescriptor() (uintptr, error) {
	sid, e := currentSID()
	if e != nil {
		return 0, e
	}
	text, e := syscall.UTF16PtrFromString("D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;" + sid + ")")
	if e != nil {
		return 0, e
	}
	var descriptor uintptr
	r, _, e := convertSD.Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if r == 0 {
		return 0, e
	}
	return descriptor, nil
}
func restrictPath(path string) error {
	sd, e := securityDescriptor()
	if e != nil {
		return e
	}
	defer localFree.Call(sd)
	p, e := syscall.UTF16PtrFromString(path)
	if e != nil {
		return e
	}
	r, _, e := setFileSecurity.Call(uintptr(unsafe.Pointer(p)), 0x80000004, sd)
	if r == 0 {
		return fmt.Errorf("vault_acl_failed: %w", e)
	}
	return nil
}
func acquireNamedMutex() (uintptr, error) {
	sid, e := currentSID()
	if e != nil {
		return 0, e
	}
	sum := sha256.Sum256([]byte(sid + ":" + FIXED_CREDENTIAL_TARGET))
	name, e := syscall.UTF16PtrFromString(fmt.Sprintf("Global\\DevFlowAuth_%x", sum))
	if e != nil {
		return 0, e
	}
	sd, e := securityDescriptor()
	if e != nil {
		return 0, e
	}
	defer localFree.Call(sd)
	sa := syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: sd}
	h, _, e := createMutex.Call(uintptr(unsafe.Pointer(&sa)), 0, uintptr(unsafe.Pointer(name)))
	if h == 0 {
		return 0, e
	}
	result, _, e := waitHandle.Call(h, 0)
	if result != 0 && result != 0x80 {
		syscall.CloseHandle(syscall.Handle(h))
		return 0, fmt.Errorf("domain_lock_busy: %v", e)
	}
	return h, nil
}
func releaseNamedMutex(h uintptr) error {
	r, _, e := releaseMutex.Call(h)
	if r == 0 {
		return e
	}
	return syscall.CloseHandle(syscall.Handle(h))
}
