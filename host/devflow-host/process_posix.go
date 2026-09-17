//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

type PlatformJob struct {
	pgid int
}

func setupJobObject() (*PlatformJob, error) {
	return &PlatformJob{}, nil
}

func (pj *PlatformJob) assignProcess(cmd *exec.Cmd) error {
	if cmd.Process != nil {
		pj.pgid = cmd.Process.Pid
	}
	return nil
}

func (pj *PlatformJob) terminate(exitCode uint) error {
	if pj.pgid > 0 {
		_ = syscall.Kill(-pj.pgid, syscall.SIGTERM)
		_ = syscall.Kill(-pj.pgid, syscall.SIGKILL)
	}
	return nil
}

func prepareCmdAttrs(cmd *exec.Cmd) {
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
