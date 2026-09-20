package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var sharedHostBin string

func TestMain(m *testing.M) {
	tempDir, err := os.MkdirTemp("", "devflow-host-test-*")
	if err != nil {
		fmt.Printf("failed to create temp dir: %v\n", err)
		os.Exit(1)
	}
	defer os.RemoveAll(tempDir)

	sharedHostBin = filepath.Join(tempDir, "devflow-host-test")
	if os.PathSeparator == '\\' {
		sharedHostBin += ".exe"
	}

	buildCmd := exec.Command("go", "build", "-o", sharedHostBin, ".")
	if out, err := buildCmd.CombinedOutput(); err != nil {
		fmt.Printf("failed to build host binary: %v, out: %s\n", err, string(out))
		os.Exit(1)
	}

	code := m.Run()
	os.RemoveAll(tempDir)
	os.Exit(code)
}

func TestHostVersion(t *testing.T) {
	for _, flag := range []string{"version", "-v", "--version"} {
		cmd := exec.Command(sharedHostBin, flag)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("flag %s failed: %v", flag, err)
		}
		if !strings.Contains(string(out), "devflow-host v") {
			t.Errorf("expected version output for flag %s, got: %s", flag, string(out))
		}
	}
}

func TestHostProcessExecutionAndCode0(t *testing.T) {
	nodeExe, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found in PATH")
	}

	spec := ProcessSpec{
		Id:         "test-job-0",
		Executable: nodeExe,
		Args:       []string{"-e", "console.log('hello from test'); process.exit(0);"},
		TimeoutMs:  10000,
	}

	specBytes, _ := json.Marshal(spec)

	cmd := exec.Command(sharedHostBin)
	stdin, _ := cmd.StdinPipe()
	defer stdin.Close()
	go func() { _, _ = stdin.Write(append(specBytes, '\n')) }()
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("host run failed: %v, out: %s", err, string(out))
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var foundStarted bool
	var foundExit bool
	var exitCode int

	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		var msg OutputMessage
		if err := json.Unmarshal([]byte(l), &msg); err == nil {
			if msg.Type == "started" {
				foundStarted = true
				if msg.JobId != "test-job-0" || msg.Pid <= 0 {
					t.Errorf("unexpected started message: %+v", msg)
				}
			}
			if msg.Type == "exit" {
				foundExit = true
				if msg.Code == nil {
					t.Errorf("exit message missing code (H01 regression)")
				} else {
					exitCode = *msg.Code
				}
			}
		}
	}

	if !foundStarted {
		t.Errorf("expected started event in output: %s", string(out))
	}
	if !foundExit {
		t.Errorf("expected exit event in output: %s", string(out))
	}
	if exitCode != 0 {
		t.Errorf("expected exit code 0, got %d", exitCode)
	}
}

func TestHostTimeoutTermination(t *testing.T) {
	nodeExe, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found in PATH")
	}

	// 启动一个如果自然结束需要 30 秒的进程，设置超时 400ms (H02)
	spec := ProcessSpec{
		Id:         "test-job-timeout",
		Executable: nodeExe,
		Args:       []string{"-e", "setTimeout(() => {}, 30000);"},
		TimeoutMs:  400,
	}

	specBytes, _ := json.Marshal(spec)

	start := time.Now()
	cmd := exec.Command(sharedHostBin)
	stdin, _ := cmd.StdinPipe()
	defer stdin.Close()
	go func() { _, _ = stdin.Write(append(specBytes, '\n')) }()
	out, _ := cmd.CombinedOutput()
	elapsed := time.Since(start)

	// 若未发生超时终止，则必定执行满 30 秒；若超时机制生效，则应在数秒内（含进程启动开销）被迅速强杀
	if elapsed > 10*time.Second {
		t.Errorf("host did not terminate child within timeout, elapsed: %v, out: %s", elapsed, string(out))
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var foundExit bool
	for _, l := range lines {
		var msg OutputMessage
		if err := json.Unmarshal([]byte(strings.TrimSpace(l)), &msg); err == nil {
			if msg.Type == "exit" {
				foundExit = true
			}
		}
	}
	if !foundExit {
		t.Errorf("expected exit message even upon timeout: %s", string(out))
	}
}

func TestHostControllerLockMutualExclusion(t *testing.T) {
	lockName := fmt.Sprintf("test-lock-%d", time.Now().UnixNano())

	cmd1 := exec.Command(sharedHostBin, "controller-lock", lockName)
	stdin1, err := cmd1.StdinPipe()
	if err != nil {
		t.Fatalf("failed to get stdin pipe for lock1: %v", err)
	}
	stdout1, err := cmd1.StdoutPipe()
	if err != nil {
		t.Fatalf("failed to get stdout pipe for lock1: %v", err)
	}

	if err := cmd1.Start(); err != nil {
		t.Fatalf("failed to start cmd1: %v", err)
	}
	defer func() {
		_ = stdin1.Close()
		_ = cmd1.Process.Kill()
	}()

	reader1 := bufio.NewReader(stdout1)
	line1, err := reader1.ReadString('\n')
	if err != nil {
		t.Fatalf("failed to read lock1 response: %v", err)
	}

	var msg1 OutputMessage
	if err := json.Unmarshal([]byte(strings.TrimSpace(line1)), &msg1); err != nil {
		t.Fatalf("failed to parse lock1 msg: %v", err)
	}
	if msg1.Type != "lock" || msg1.Locked == nil || !*msg1.Locked {
		t.Fatalf("expected lock1 to acquire successfully, got: %+v", msg1)
	}

	cmd2 := exec.Command(sharedHostBin, "controller-lock", lockName)
	out2, _ := cmd2.CombinedOutput()

	var msg2 OutputMessage
	lines2 := strings.Split(strings.TrimSpace(string(out2)), "\n")
	var foundLockResponse bool
	for _, l := range lines2 {
		if err := json.Unmarshal([]byte(strings.TrimSpace(l)), &msg2); err == nil && msg2.Type == "lock" {
			foundLockResponse = true
			break
		}
	}

	if !foundLockResponse {
		t.Fatalf("cmd2 did not output lock response: %s", string(out2))
	}
	if msg2.Locked == nil || *msg2.Locked != false {
		t.Errorf("expected cmd2 to fail acquiring held lock, got: %+v", msg2)
	}
}
