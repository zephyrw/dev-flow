package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

type ProcessSpec struct {
	Id         string            `json:"id"`
	WorkflowId string            `json:"workflow_id,omitempty"`
	Executable string            `json:"executable"`
	Args       []string          `json:"args"`
	Cwd        string            `json:"cwd"`
	Env        map[string]string `json:"env"`
	TimeoutMs  int64             `json:"timeout_ms"`
	Stdin      string            `json:"stdin,omitempty"`
}

type OutputMessage struct {
	Type    string `json:"type"`
	Data    string `json:"data,omitempty"`
	Code    *int   `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
	Pid     int    `json:"pid,omitempty"`
	JobId   string `json:"job_id,omitempty"`
	Locked  *bool  `json:"locked,omitempty"`
}

var emitMu sync.Mutex

func emit(msg interface{}) {
	emitMu.Lock()
	defer emitMu.Unlock()
	bytes, err := json.Marshal(msg)
	if err == nil {
		fmt.Println(string(bytes))
	}
}

func isVersionFlag(arg string) bool {
	clean := strings.TrimLeft(arg, "-")
	return clean == "v" || clean == "version"
}

type HostCapabilities struct {
	Version        int    `json:"version"`
	OS             string `json:"os"`
	SuspendedSpawn bool   `json:"suspended_spawn"`
	KillOnClose    bool   `json:"kill_on_close"`
	Reason         string `json:"reason,omitempty"`
}
type JobStatus struct {
	Id              string `json:"id"`
	Alive           bool   `json:"alive"`
	ActiveProcesses uint32 `json:"active_processes"`
}

var validJobID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,150}$`)

func jobObjectName(id string) (string, error) {
	if !validJobID.MatchString(id) {
		return "", fmt.Errorf("invalid job identifier")
	}
	return `Local\DevFlow.` + id, nil
}
func main() {
	if len(os.Args) > 1 {
		cmdName := os.Args[1]
		if cmdName == "doctor" {
			caps, err := platformDoctor()
			if err != nil {
				caps.Reason = err.Error()
			}
			emit(caps)
			if err != nil {
				os.Exit(1)
			}
			return
		}
		if cmdName == "job-status" {
			if len(os.Args) != 3 {
				emit(OutputMessage{Type: "error", Message: "job-status requires an identifier"})
				os.Exit(1)
			}
			status, err := platformJobStatus(os.Args[2])
			if err != nil {
				emit(OutputMessage{Type: "error", Message: err.Error()})
				os.Exit(1)
			}
			emit(status)
			return
		}
		if isVersionFlag(cmdName) {
			fmt.Println("devflow-host v1.0.0 (Go)")
			return
		}
		if cmdName == "help" || cmdName == "-h" || cmdName == "--help" {
			fmt.Println("DevFlow Cross-Platform Go Host")
			fmt.Println("Usage:")
			fmt.Println("  devflow-host [version|-v|--version]")
			fmt.Println("  devflow-host controller-lock <lock-name>")
			fmt.Println("  devflow-host doctor | job-status <job-id>")
			fmt.Println("  devflow-host [run] < (stdin ProcessSpec JSON)")
			return
		}

		// controller-lock 子命令处理 (RQ-19 & H03)
		if cmdName == "controller-lock" {
			lockName := "default"
			if len(os.Args) > 2 {
				lockName = os.Args[2]
			}
			release, err := acquireHostControllerLock(lockName)
			if err != nil {
				lockedFalse := false
				emit(OutputMessage{
					Type:    "lock",
					Locked:  &lockedFalse,
					Message: err.Error(),
				})
				os.Exit(1)
			}
			defer release()
			lockedTrue := true
			emit(OutputMessage{
				Type:   "lock",
				Locked: &lockedTrue,
			})

			// 保持互斥锁占用，直到控制器的 stdin 关闭
			reader := bufio.NewReader(os.Stdin)
			for {
				_, err := reader.ReadByte()
				if err != nil {
					break
				}
			}
			return
		}
	}

	reader := bufio.NewReader(os.Stdin)
	firstLine, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		emit(OutputMessage{Type: "error", Message: fmt.Sprintf("failed to read process spec: %v", err)})
		os.Exit(1)
	}

	firstLine = strings.TrimSpace(firstLine)
	if firstLine == "" {
		emit(OutputMessage{Type: "error", Message: "empty process spec"})
		os.Exit(1)
	}

	var spec ProcessSpec
	if err := json.Unmarshal([]byte(firstLine), &spec); err != nil {
		emit(OutputMessage{Type: "error", Message: fmt.Sprintf("invalid process spec JSON: %v", err)})
		os.Exit(1)
	}

	if err := runProcess(reader, spec); err != nil {
		emit(OutputMessage{Type: "error", Message: err.Error()})
		os.Exit(1)
	}
}

func runProcess(reader *bufio.Reader, spec ProcessSpec) error {
	job, err := setupJobObject(spec.Id)
	if err != nil {
		return fmt.Errorf("initialize job: %w", err)
	}
	defer job.close()
	cmd := exec.Command(spec.Executable, spec.Args...)
	cmd.Dir = spec.Cwd
	if len(spec.Env) > 0 {
		cmd.Env = os.Environ()
		for k, v := range spec.Env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}
	prepareCmdAttrs(cmd)
	// Own read ends so Cmd.Wait cannot close pipes before descendants are killed.
	stdout, stdoutWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer stdout.Close()
	defer stdoutWrite.Close()
	stderr, stderrWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer stderr.Close()
	defer stderrWrite.Close()
	cmd.Stdout, cmd.Stderr = stdoutWrite, stderrWrite
	var input io.WriteCloser
	if spec.Stdin != "" {
		input, err = cmd.StdinPipe()
		if err != nil {
			return err
		}
		defer input.Close()
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start process: %w", err)
	}
	stdoutWrite.Close()
	stderrWrite.Close()
	if err := job.assignProcess(cmd); err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		return fmt.Errorf("attach containment: %w", err)
	}
	if err := resumeProcess(cmd); err != nil {
		job.terminate(1)
		cmd.Process.Kill()
		cmd.Wait()
		return fmt.Errorf("resume contained process: %w", err)
	}
	emit(OutputMessage{Type: "started", Pid: cmd.Process.Pid, JobId: spec.Id})
	var wg sync.WaitGroup
	stream := func(kind string, pipe *os.File) {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		for {
			n, err := pipe.Read(buf)
			if n > 0 {
				emit(OutputMessage{Type: kind, Data: base64.StdEncoding.EncodeToString(buf[:n])})
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go stream("stdout", stdout)
	go stream("stderr", stderr)
	if input != nil {
		go func() { io.WriteString(input, spec.Stdin); input.Close() }()
	}
	stop := func() {
		if err := job.terminate(1); err != nil {
			emit(OutputMessage{Type: "error", Message: err.Error()})
			cmd.Process.Kill()
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
	// Root can exit while a grandchild holds stdout open. Kill all descendants
	// before draining inherited pipes, and confirm containment before emitting exit.
	waitErr := cmd.Wait()
	if timer != nil {
		timer.Stop()
	}
	if err := job.terminate(0); err != nil {
		return err
	}
	if err := job.waitStopped(); err != nil {
		return err
	}
	wg.Wait()
	code := 0
	if waitErr != nil {
		if e, ok := waitErr.(*exec.ExitError); ok {
			code = e.ExitCode()
		} else {
			code = -1
		}
	}
	emit(OutputMessage{Type: "exit", Code: &code})
	return nil
}
