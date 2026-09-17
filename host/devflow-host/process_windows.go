//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"syscall"
	"unsafe"
)

var (
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject       = kernel32.NewProc("TerminateJobObject")
	procCloseHandle              = kernel32.NewProc("CloseHandle")
)

const (
	JobObjectExtendedLimitInformationClass = 9
	JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE     = 0x2000
	PROCESS_SET_QUOTA                      = 0x0100
	PROCESS_TERMINATE                      = 0x0001
)

type IO_COUNTERS struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type JOBOBJECT_BASIC_LIMIT_INFORMATION struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type JOBOBJECT_EXTENDED_LIMIT_INFORMATION struct {
	BasicLimitInformation JOBOBJECT_BASIC_LIMIT_INFORMATION
	IoInfo                IO_COUNTERS
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

type PlatformJob struct {
	jobHandle syscall.Handle
}

func setupJobObject() (*PlatformJob, error) {
	r1, _, err := procCreateJobObjectW.Call(0, 0)
	if r1 == 0 {
		return nil, fmt.Errorf("failed to create Job Object: %v", err)
	}

	jobHandle := syscall.Handle(r1)

	var info JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE

	ret, _, err := procSetInformationJobObject.Call(
		uintptr(jobHandle),
		uintptr(JobObjectExtendedLimitInformationClass),
		uintptr(unsafe.Pointer(&info)),
		uintptr(unsafe.Sizeof(info)),
	)
	if ret == 0 {
		_ = syscall.CloseHandle(jobHandle)
		return nil, fmt.Errorf("failed to set job information: %v", err)
	}

	return &PlatformJob{jobHandle: jobHandle}, nil
}

func (pj *PlatformJob) assignProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return fmt.Errorf("process not started")
	}

	hProcess, err := syscall.OpenProcess(
		syscall.PROCESS_QUERY_INFORMATION|PROCESS_SET_QUOTA|PROCESS_TERMINATE,
		false,
		uint32(cmd.Process.Pid),
	)
	if err != nil {
		return fmt.Errorf("failed to open process handle: %v", err)
	}
	defer syscall.CloseHandle(hProcess)

	ret, _, err := procAssignProcessToJobObject.Call(
		uintptr(pj.jobHandle),
		uintptr(hProcess),
	)
	if ret == 0 {
		return fmt.Errorf("failed to assign process to Job Object: %v", err)
	}
	return nil
}

func (pj *PlatformJob) terminate(exitCode uint) error {
	if pj.jobHandle != 0 {
		ret, _, err := procTerminateJobObject.Call(uintptr(pj.jobHandle), uintptr(exitCode))
		if ret == 0 {
			return fmt.Errorf("failed to terminate Job Object: %v", err)
		}
		_ = syscall.CloseHandle(pj.jobHandle)
		pj.jobHandle = 0
	}
	return nil
}

func prepareCmdAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow: true,
	}
}

var (
	procCreateMutexW = kernel32.NewProc("CreateMutexW")
	procReleaseMutex = kernel32.NewProc("ReleaseMutex")
)

func acquireHostControllerLock(lockName string) (func(), error) {
	namePtr, err := syscall.UTF16PtrFromString("Global\\" + lockName)
	if err != nil {
		namePtr, _ = syscall.UTF16PtrFromString(lockName)
	}
	r1, _, err := procCreateMutexW.Call(0, 1, uintptr(unsafe.Pointer(namePtr)))
	if r1 == 0 {
		return nil, fmt.Errorf("failed to create mutex %s: %v", lockName, err)
	}
	if err == syscall.ERROR_ALREADY_EXISTS {
		procCloseHandle.Call(r1)
		return nil, fmt.Errorf("mutex %s already exists", lockName)
	}
	handle := syscall.Handle(r1)
	release := func() {
		procReleaseMutex.Call(uintptr(handle))
		procCloseHandle.Call(uintptr(handle))
	}
	return release, nil
}
