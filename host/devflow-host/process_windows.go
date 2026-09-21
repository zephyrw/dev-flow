//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32                      = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW          = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject   = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject  = kernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject        = kernel32.NewProc("TerminateJobObject")
	procOpenJobObjectW            = kernel32.NewProc("OpenJobObjectW")
	procQueryInformationJobObject = kernel32.NewProc("QueryInformationJobObject")
	procCreateToolhelp32Snapshot  = kernel32.NewProc("CreateToolhelp32Snapshot")
	procThread32First             = kernel32.NewProc("Thread32First")
	procThread32Next              = kernel32.NewProc("Thread32Next")
	procOpenThread                = kernel32.NewProc("OpenThread")
	procResumeThread              = kernel32.NewProc("ResumeThread")
	procCloseHandle               = kernel32.NewProc("CloseHandle")
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
	mu         sync.Mutex
	jobHandle  syscall.Handle
	terminated bool
}

func setupJobObject(id string) (*PlatformJob, error) {
	name, err := jobObjectName(id)
	if err != nil {
		return nil, err
	}
	namePtr, _ := syscall.UTF16PtrFromString(name)
	r1, _, err := procCreateJobObjectW.Call(0, uintptr(unsafe.Pointer(namePtr)))
	if r1 == 0 {
		return nil, fmt.Errorf("failed to create Job Object: %v", err)
	}

	jobHandle := syscall.Handle(r1)
	// Never join or reconfigure another host's existing containment domain.
	if err == syscall.ERROR_ALREADY_EXISTS {
		syscall.CloseHandle(jobHandle)
		return nil, fmt.Errorf("job already exists")
	}

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
	pj.mu.Lock()
	defer pj.mu.Unlock()
	if pj.jobHandle == 0 || pj.terminated {
		return fmt.Errorf("job closed")
	}
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

// Termination requests can race (timeout, EOF, stop and natural exit).
// Keep the named job handle alive until all its processes are confirmed gone.
func (pj *PlatformJob) terminate(exitCode uint) error {
	pj.mu.Lock()
	defer pj.mu.Unlock()
	if pj.jobHandle == 0 || pj.terminated {
		return nil
	}
	ret, _, err := procTerminateJobObject.Call(uintptr(pj.jobHandle), uintptr(exitCode))
	if ret == 0 {
		return fmt.Errorf("terminate job: %v", err)
	}
	pj.terminated = true
	return nil
}
func (pj *PlatformJob) close() error {
	pj.mu.Lock()
	defer pj.mu.Unlock()
	if pj.jobHandle == 0 {
		return nil
	}
	err := syscall.CloseHandle(pj.jobHandle)
	if err == nil {
		pj.jobHandle = 0
	}
	return err
}

type jobAccounting struct {
	TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime int64
	TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses     uint32
}

func activeJobProcesses(handle syscall.Handle) (uint32, error) {
	var info jobAccounting
	ok, _, err := procQueryInformationJobObject.Call(uintptr(handle), 1, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info), 0)
	if ok == 0 {
		return 0, fmt.Errorf("query job: %v", err)
	}
	return info.ActiveProcesses, nil
}
func (pj *PlatformJob) waitStopped() error {
	deadline := time.Now().Add(10 * time.Second)
	for {
		pj.mu.Lock()
		count, err := activeJobProcesses(pj.jobHandle)
		pj.mu.Unlock()
		if err != nil {
			return err
		}
		if count == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("job still has %d active processes", count)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
func platformJobStatus(id string) (JobStatus, error) {
	name, err := jobObjectName(id)
	if err != nil {
		return JobStatus{}, err
	}
	namePtr, _ := syscall.UTF16PtrFromString(name)
	h, _, err := procOpenJobObjectW.Call(4, 0, uintptr(unsafe.Pointer(namePtr)))
	if h == 0 {
		if err == syscall.ERROR_FILE_NOT_FOUND {
			return JobStatus{Id: id}, nil
		}
		return JobStatus{}, fmt.Errorf("open job: %v", err)
	}
	defer syscall.CloseHandle(syscall.Handle(h))
	count, err := activeJobProcesses(syscall.Handle(h))
	return JobStatus{Id: id, Alive: count > 0, ActiveProcesses: count}, err
}
func platformDoctor() (HostCapabilities, error) {
	caps := HostCapabilities{Version: 1, OS: "windows"}
	for _, api := range []*syscall.LazyProc{procCreateJobObjectW, procSetInformationJobObject, procAssignProcessToJobObject, procTerminateJobObject, procOpenJobObjectW, procQueryInformationJobObject, procCreateToolhelp32Snapshot, procThread32First, procThread32Next, procOpenThread, procResumeThread} {
		if err := api.Find(); err != nil {
			return caps, err
		}
	}
	job, err := setupJobObject(fmt.Sprintf("doctor-%d-%d", os.Getpid(), time.Now().UnixNano()))
	if err != nil {
		return caps, err
	}
	defer job.close()
	if _, err := activeJobProcesses(job.jobHandle); err != nil {
		return caps, err
	}
	caps.SuspendedSpawn, caps.KillOnClose = true, true
	return caps, nil
}
func prepareCmdAttrs(cmd *exec.Cmd, interactive ...bool) {
	isInteractive := len(interactive) > 0 && interactive[0]
	if isInteractive {
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: false, CreationFlags: 0x00000004 | 0x00000010} // CREATE_SUSPENDED | CREATE_NEW_CONSOLE
	} else {
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x00000004}
	}
}

type threadEntry32 struct {
	Size, Usage, ThreadID, OwnerProcessID uint32
	BasePriority, DeltaPriority           int32
	Flags                                 uint32
}

// os/exec closes PROCESS_INFORMATION.hThread. ToolHelp exposes the documented
// thread ID; a CREATE_SUSPENDED child has not run its application entry point.
// https://learn.microsoft.com/windows/win32/api/tlhelp32/nf-tlhelp32-thread32first
// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-resumethread
func resumeProcess(cmd *exec.Cmd) error {
	snapshot, _, err := procCreateToolhelp32Snapshot.Call(4, 0) // TH32CS_SNAPTHREAD
	if snapshot == ^uintptr(0) {
		return fmt.Errorf("snapshot threads: %v", err)
	}
	defer syscall.CloseHandle(syscall.Handle(snapshot))
	entry := threadEntry32{Size: uint32(unsafe.Sizeof(threadEntry32{}))}
	ok, _, scanErr := procThread32First.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	var ids []uint32
	for ok != 0 {
		if entry.Size < 16 {
			return fmt.Errorf("incomplete thread entry")
		}
		if entry.OwnerProcessID == uint32(cmd.Process.Pid) {
			ids = append(ids, entry.ThreadID)
		}
		entry.Size = uint32(unsafe.Sizeof(entry))
		ok, _, scanErr = procThread32Next.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	}
	if scanErr != syscall.ERROR_NO_MORE_FILES {
		return fmt.Errorf("enumerate threads: %v", scanErr)
	}
	if len(ids) != 1 {
		return fmt.Errorf("expected one suspended primary thread, got %d", len(ids))
	}
	thread, _, err := procOpenThread.Call(2, 0, uintptr(ids[0])) // THREAD_SUSPEND_RESUME
	if thread == 0 {
		return fmt.Errorf("open primary thread: %v", err)
	}
	defer syscall.CloseHandle(syscall.Handle(thread))
	previous, _, err := procResumeThread.Call(thread)
	if previous != 1 {
		return fmt.Errorf("resume primary thread returned %d: %v", previous, err)
	}
	return nil
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
