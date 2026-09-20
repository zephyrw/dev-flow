//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

var advapi32 = syscall.NewLazyDLL("advapi32.dll")
var credRead = advapi32.NewProc("CredReadW")
var credWrite = advapi32.NewProc("CredWriteW")
var credDelete = advapi32.NewProc("CredDeleteW")
var credFree = advapi32.NewProc("CredFree")

type winAttribute struct {
	Keyword   *uint16
	Flags     uint32
	ValueSize uint32
	Value     *byte
}
type winCredential struct {
	Flags          uint32
	Type           uint32
	TargetName     *uint16
	Comment        *uint16
	LastWritten    syscall.Filetime
	BlobSize       uint32
	Blob           *byte
	Persist        uint32
	AttributeCount uint32
	Attributes     *winAttribute
	TargetAlias    *uint16
	Username       *uint16
}

func utf16Value(p *uint16) string {
	if p == nil {
		return ""
	}
	a := make([]uint16, 0)
	for n := uintptr(0); n < 65536; n++ {
		v := *(*uint16)(unsafe.Pointer(uintptr(unsafe.Pointer(p)) + n*2))
		if v == 0 {
			break
		}
		a = append(a, v)
	}
	return syscall.UTF16ToString(a)
}
func copyBytes(p *byte, n uint32) []byte {
	if n == 0 {
		return nil
	}
	return append([]byte(nil), unsafe.Slice(p, n)...)
}
func readActiveCredential(target string) (*CredentialRecord, error) {
	p, e := syscall.UTF16PtrFromString(target)
	if e != nil {
		return nil, e
	}
	var c *winCredential
	r, _, e := credRead.Call(uintptr(unsafe.Pointer(p)), 1, 0, uintptr(unsafe.Pointer(&c)))
	if r == 0 {
		if e == syscall.Errno(1168) {
			return &CredentialRecord{}, nil
		}
		return nil, fmt.Errorf("credential_read_failed: %w", e)
	}
	defer credFree.Call(uintptr(unsafe.Pointer(c)))
	out := &CredentialRecord{Exists: true, Flags: c.Flags, Username: utf16Value(c.Username), Comment: utf16Value(c.Comment), Persist: c.Persist, TargetAlias: utf16Value(c.TargetAlias), Secret: copyBytes(c.Blob, c.BlobSize)}
	for _, a := range unsafe.Slice(c.Attributes, c.AttributeCount) {
		out.Attributes = append(out.Attributes, CredentialAttribute{Keyword: utf16Value(a.Keyword), Flags: a.Flags, Value: copyBytes(a.Value, a.ValueSize)})
	}
	return out, nil
}
func writeActiveCredential(target string, c *CredentialRecord) error {
	p, e := syscall.UTF16PtrFromString(target)
	if e != nil {
		return e
	}
	if !c.Exists {
		r, _, e := credDelete.Call(uintptr(unsafe.Pointer(p)), 1, 0)
		if r == 0 && e != syscall.Errno(1168) {
			return fmt.Errorf("credential_delete_failed: %w", e)
		}
		return nil
	}
	user, e := syscall.UTF16PtrFromString(c.Username)
	if e != nil {
		return e
	}
	comment, e := syscall.UTF16PtrFromString(c.Comment)
	if e != nil {
		return e
	}
	alias, e := syscall.UTF16PtrFromString(c.TargetAlias)
	if e != nil {
		return e
	}
	native := winCredential{Flags: c.Flags, Type: 1, TargetName: p, Comment: comment, Persist: c.Persist, TargetAlias: alias, Username: user, BlobSize: uint32(len(c.Secret))}
	if len(c.Secret) > 0 {
		native.Blob = &c.Secret[0]
	}
	attrs := make([]winAttribute, len(c.Attributes))
	for i, a := range c.Attributes {
		k, e := syscall.UTF16PtrFromString(a.Keyword)
		if e != nil {
			return e
		}
		attrs[i] = winAttribute{Keyword: k, Flags: a.Flags, ValueSize: uint32(len(a.Value))}
		if len(a.Value) > 0 {
			attrs[i].Value = &a.Value[0]
		}
	}
	if len(attrs) > 0 {
		native.Attributes = &attrs[0]
		native.AttributeCount = uint32(len(attrs))
	}
	r, _, e := credWrite.Call(uintptr(unsafe.Pointer(&native)), 0)
	if r == 0 {
		return fmt.Errorf("credential_write_failed: %w", e)
	}
	return nil
}
