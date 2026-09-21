//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

// os/exec supplies NUL handles for nil streams on Windows. Create the console
// process directly so Windows supplies its own console stdin/stdout/stderr.
// No handles are inherited: the host's JSON control pipe stays host-owned.
func runInteractiveProcess(reader *bufio.Reader, spec ProcessSpec) error {
	if !filepath.IsAbs(spec.Executable) || !filepath.IsAbs(spec.Cwd) {
		return fmt.Errorf("interactive executable and cwd must be absolute paths")
	}
	app, err := syscall.UTF16PtrFromString(spec.Executable)
	if err != nil {
		return fmt.Errorf("invalid interactive executable: %w", err)
	}
	args := append([]string{spec.Executable}, spec.Args...)
	for i, arg := range args {
		args[i] = syscall.EscapeArg(arg)
	}
	command, err := syscall.UTF16PtrFromString(strings.Join(args, " "))
	if err != nil {
		return fmt.Errorf("invalid interactive arguments: %w", err)
	}
	cwd, err := syscall.UTF16PtrFromString(spec.Cwd)
	if err != nil {
		return fmt.Errorf("invalid interactive cwd: %w", err)
	}
	var environment []uint16
	var environmentPtr *uint16
	if len(spec.Env) > 0 {
		// Use the same case-insensitive environment override semantics as exec.Cmd.
		envCommand := exec.Command(spec.Executable)
		envCommand.Env = os.Environ()
		for key, value := range spec.Env {
			if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, '\x00') {
				return fmt.Errorf("invalid interactive environment")
			}
			envCommand.Env = append(envCommand.Env, key+"="+value)
		}
		entries := envCommand.Environ()
		sort.Slice(entries, func(i, j int) bool { return strings.ToUpper(entries[i]) < strings.ToUpper(entries[j]) })
		environment = utf16.Encode([]rune(strings.Join(entries, "\x00") + "\x00\x00"))
		environmentPtr = &environment[0]
	}
	job, err := setupJobObject(spec.Id)
	if err != nil {
		return fmt.Errorf("initialize interactive job: %w", err)
	}
	defer job.close()
	si := syscall.StartupInfo{Cb: uint32(unsafe.Sizeof(syscall.StartupInfo{}))}
	var process syscall.ProcessInformation
	const flags = 0x00000004 | 0x00000010 | 0x00000400 // SUSPENDED | NEW_CONSOLE | UNICODE_ENVIRONMENT
	if err := syscall.CreateProcess(app, command, nil, nil, false, flags, environmentPtr, cwd, &si, &process); err != nil {
		return fmt.Errorf("create interactive process: %w", err)
	}
	var lifecycle sync.Mutex
	finished := false
	defer func() {
		lifecycle.Lock()
		finished = true
		// Also covers assign/resume/wait failure while the child is suspended.
		_ = job.terminate(1)
		_ = syscall.TerminateProcess(process.Process, 1)
		_ = syscall.CloseHandle(process.Thread)
		_ = syscall.CloseHandle(process.Process)
		lifecycle.Unlock()
	}()
	assigned, _, assignErr := procAssignProcessToJobObject.Call(uintptr(job.jobHandle), uintptr(process.Process))
	if assigned == 0 {
		return fmt.Errorf("attach interactive containment: %v", assignErr)
	}
	previous, _, resumeErr := procResumeThread.Call(uintptr(process.Thread))
	if previous != 1 {
		return fmt.Errorf("resume interactive process returned %d: %v", previous, resumeErr)
	}
	emit(OutputMessage{Type: "started", Pid: int(process.ProcessId), JobId: spec.Id})
	stop := func() {
		lifecycle.Lock()
		defer lifecycle.Unlock()
		if finished {
			return
		}
		if err := job.terminate(1); err != nil {
			emit(OutputMessage{Type: "error", Message: err.Error()})
			_ = syscall.TerminateProcess(process.Process, 1)
		}
	}
	var timer *time.Timer
	if spec.TimeoutMs > 0 {
		timer = time.AfterFunc(time.Duration(spec.TimeoutMs)*time.Millisecond, stop)
		defer timer.Stop()
	}
	go func() {
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				stop()
				return
			}
			var command struct {
				Action string `json:"action"`
			}
			if json.Unmarshal([]byte(line), &command) == nil && command.Action == "stop" {
				stop()
				return
			}
		}
	}()
	if result, err := syscall.WaitForSingleObject(process.Process, syscall.INFINITE); err != nil || result != syscall.WAIT_OBJECT_0 {
		return fmt.Errorf("wait interactive process (%d): %v", result, err)
	}
	if timer != nil {
		timer.Stop()
	}
	var exitCode uint32
	if err := syscall.GetExitCodeProcess(process.Process, &exitCode); err != nil {
		return fmt.Errorf("read interactive exit code: %w", err)
	}
	if err := job.terminate(0); err != nil {
		return err
	}
	if err := job.waitStopped(); err != nil {
		return err
	}
	code := int(exitCode)
	emit(OutputMessage{Type: "exit", Code: &code})
	return nil
}
