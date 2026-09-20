//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func isolatedID(t *testing.T) string {
	return fmt.Sprintf("test-%d-%d", os.Getpid(), time.Now().UnixNano())
}
func testNode(t *testing.T) string {
	t.Helper()
	p, e := exec.LookPath("node")
	if e != nil {
		t.Fatal("node required for isolated containment tests")
	}
	return p
}

// The marker is application code: it must not execute before assignment and resume.
func TestSuspendedAssignmentAndConcurrentTermination(t *testing.T) {
	id := isolatedID(t)
	job, err := setupJobObject(id)
	if err != nil {
		t.Fatal(err)
	}
	defer job.close()
	defer job.terminate(1)
	marker := filepath.Join(t.TempDir(), "ran.txt")
	cmd := exec.Command(testNode(t), "-e", `require('fs').writeFileSync(process.argv[1],'ran');setInterval(()=>{},1000)`, marker)
	prepareCmdAttrs(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	time.Sleep(100 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("application ran before containment")
	}
	if err := job.assignProcess(cmd); err != nil {
		t.Fatal(err)
	}
	status, err := platformJobStatus(id)
	if err != nil || status.ActiveProcesses != 1 || !status.Alive {
		t.Fatalf("assigned status: %+v %v", status, err)
	}
	if duplicate, err := setupJobObject(id); err == nil {
		duplicate.close()
		t.Fatal("duplicate job was accepted")
	}
	if err := resumeProcess(cmd); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("resumed application never ran")
		}
		time.Sleep(10 * time.Millisecond)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := job.terminate(1); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if err := job.waitStopped(); err != nil {
		t.Fatal(err)
	}
	status, err = platformJobStatus(id)
	if err != nil || status.Alive || status.ActiveProcesses != 0 {
		t.Fatalf("stopped status: %+v %v", status, err)
	}
}

func TestDoctorAndJobIdentifierValidation(t *testing.T) {
	out, err := exec.Command(sharedHostBin, "doctor").CombinedOutput()
	if err != nil {
		t.Fatalf("doctor: %v %s", err, out)
	}
	var caps HostCapabilities
	if json.Unmarshal(out, &caps) != nil || !caps.SuspendedSpawn || !caps.KillOnClose {
		t.Fatalf("capabilities: %s", out)
	}
	id := isolatedID(t)
	out, err = exec.Command(sharedHostBin, "job-status", id).CombinedOutput()
	if err != nil {
		t.Fatal(err)
	}
	var status JobStatus
	if json.Unmarshal(out, &status) != nil || status.Id != id || status.Alive {
		t.Fatalf("missing status: %s", out)
	}
	for _, bad := range []string{"", `other\job`, "../bad", strings.Repeat("a", 151)} {
		if _, err := jobObjectName(bad); err == nil {
			t.Fatalf("accepted identifier %q", bad)
		}
	}
}

// Spawn one descendant that keeps inherited stdout open. Root exits naturally;
// host must kill that descendant and drain output before its exit receipt.
func TestNaturalExitKillsDescendantsBeforeExitReceipt(t *testing.T) {
	id := isolatedID(t)
	source := `const cp=require('child_process');const c=cp.spawn(process.execPath,['-e',"console.log('grandchild');setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});c.on('spawn',()=>{console.log('root');setTimeout(()=>process.exit(0),150)})`
	spec := ProcessSpec{Id: id, Executable: testNode(t), Args: []string{"-e", source}, TimeoutMs: 10000}
	host := exec.Command(sharedHostBin, "run")
	stdin, err := host.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := host.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { stdin.Close(); host.Process.Kill(); host.Wait() }()
	data, _ := json.Marshal(spec)
	stdin.Write(append(data, '\n'))
	timer := time.AfterFunc(15*time.Second, func() { host.Process.Kill() })
	defer timer.Stop()
	scanner := bufio.NewScanner(stdout)
	foundExit := false
	for scanner.Scan() {
		var msg OutputMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			t.Fatal(err)
		}
		if foundExit {
			t.Fatalf("message after exit: %s", scanner.Text())
		}
		if msg.Type == "error" {
			t.Fatalf("host error: %s", msg.Message)
		}
		if msg.Type == "exit" {
			foundExit = true
			status, err := platformJobStatus(id)
			if err != nil || status.Alive {
				t.Fatalf("exit before containment empty: %+v %v", status, err)
			}
		}
	}
	if !foundExit {
		t.Fatal("no exit; descendant inherited pipe prevented completion")
	}
}

func TestControllerEOFAndTimeoutStopOnlyOwnJob(t *testing.T) {
	for _, mode := range []string{"eof", "timeout", "stop"} {
		t.Run(mode, func(t *testing.T) {
			id := isolatedID(t)
			spec := ProcessSpec{Id: id, Executable: testNode(t), Args: []string{"-e", "setInterval(()=>{},1000)"}, TimeoutMs: 10000}
			if mode == "timeout" {
				spec.TimeoutMs = 300
			}
			host := exec.Command(sharedHostBin, "run")
			stdin, _ := host.StdinPipe()
			stdout, _ := host.StdoutPipe()
			if err := host.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { stdin.Close(); host.Process.Kill(); host.Wait() }()
			data, _ := json.Marshal(spec)
			stdin.Write(append(data, '\n'))
			timer := time.AfterFunc(15*time.Second, func() { host.Process.Kill() })
			defer timer.Stop()
			scanner := bufio.NewScanner(stdout)
			done := false
			for scanner.Scan() {
				var msg OutputMessage
				json.Unmarshal(scanner.Bytes(), &msg)
				if msg.Type == "error" {
					t.Fatal(msg.Message)
				}
				if msg.Type == "started" {
					status, err := platformJobStatus(id)
					if err != nil || !status.Alive {
						t.Fatalf("live status: %+v %v", status, err)
					}
					if mode == "eof" {
						stdin.Close()
					}
					if mode == "stop" {
						stdin.Write([]byte("{\"action\":\"stop\"}\n"))
					}
				}
				if msg.Type == "exit" {
					done = true
					status, err := platformJobStatus(id)
					if err != nil || status.Alive {
						t.Fatalf("remaining processes: %+v %v", status, err)
					}
				}
			}
			if !done {
				t.Fatal("host failed to emit exit")
			}
		})
	}
}

func TestJobCloseKillsContainedProcess(t *testing.T) {
	job, err := setupJobObject(isolatedID(t))
	if err != nil {
		t.Fatal(err)
	}
	defer job.close()
	cmd := exec.Command(testNode(t), "-e", "setInterval(()=>{},1000)")
	prepareCmdAttrs(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	if err := job.assignProcess(cmd); err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		t.Fatal(err)
	}
	if err := resumeProcess(cmd); err != nil {
		job.terminate(1)
		cmd.Wait()
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	if err := job.close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		cmd.Process.Kill()
		<-done
		t.Fatal("closing the final job handle did not terminate the child")
	}
}
