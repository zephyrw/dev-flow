//go:build !windows

package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
)

func runInteractiveProcess(_ *bufio.Reader, _ ProcessSpec) error {
	return fmt.Errorf("interactive console requires Windows")
}

type PlatformJob struct {
	mu         sync.Mutex
	pgid       int
	terminated bool
}

func setupJobObject(id string) (*PlatformJob, error) {
	if _, err := jobObjectName(id); err != nil {
		return nil, err
	}
	return &PlatformJob{}, nil
}

func (pj *PlatformJob) assignProcess(cmd *exec.Cmd) error {
	pj.mu.Lock()
	defer pj.mu.Unlock()
	if cmd.Process != nil {
		pj.pgid = cmd.Process.Pid
	}
	return nil
}

func (pj *PlatformJob) terminate(exitCode uint) error {
	pj.mu.Lock()
	defer pj.mu.Unlock()
	if pj.terminated {
		return nil
	}
	pj.terminated = true
	if pj.pgid > 0 {
		_ = syscall.Kill(-pj.pgid, syscall.SIGTERM)
		_ = syscall.Kill(-pj.pgid, syscall.SIGKILL)
	}
	return nil
}

func prepareCmdAttrs(cmd *exec.Cmd, _ ...bool) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
	}
}

func acquireHostControllerLock(lockName string) (func(), error) {
	tmpDir := os.TempDir()
	lockFile := filepath.Join(tmpDir, fmt.Sprintf("devflow-%s.lock", lockName))
	f, err := os.OpenFile(lockFile, os.O_CREATE|os.O_RDWR, 0666)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("flock %s failed: %v", lockName, err)
	}
	release := func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}
	return release, nil
}

func (pj *PlatformJob) close() error       { return nil }
func (pj *PlatformJob) waitStopped() error { return nil }
func resumeProcess(cmd *exec.Cmd) error    { return nil }
func platformDoctor() (HostCapabilities, error) {
	return HostCapabilities{Version: 1, OS: "posix", Reason: "windows_job_containment_required"}, nil
}
func platformJobStatus(id string) (JobStatus, error) {
	return JobStatus{}, fmt.Errorf("named job status unsupported on this platform")
}
