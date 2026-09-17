package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
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

func emit(msg OutputMessage) {
	bytes, err := json.Marshal(msg)
	if err == nil {
		fmt.Println(string(bytes))
	}
}

func isVersionFlag(arg string) bool {
	clean := strings.TrimLeft(arg, "-")
	return clean == "v" || clean == "version"
}

func main() {
	if len(os.Args) > 1 {
		cmdName := os.Args[1]
		if isVersionFlag(cmdName) {
			fmt.Println("devflow-host v1.0.0 (Go)")
			return
		}
		if cmdName == "help" || cmdName == "-h" || cmdName == "--help" {
			fmt.Println("DevFlow Cross-Platform Go Host")
			fmt.Println("Usage:")
			fmt.Println("  devflow-host [version|-v|--version]")
			fmt.Println("  devflow-host controller-lock <lock-name>")
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

	job, err := setupJobObject()
	if err != nil {
		emit(OutputMessage{Type: "error", Message: fmt.Sprintf("failed to initialize host job: %v", err)})
		os.Exit(1)
	}

	cmd := exec.Command(spec.Executable, spec.Args...)
	if spec.Cwd != "" {
		cmd.Dir = spec.Cwd
	}

	if len(spec.Env) > 0 {
		envList := os.Environ()
		for k, v := range spec.Env {
			envList = append(envList, fmt.Sprintf("%s=%s", k, v))
		}
		cmd.Env = envList
	}

	prepareCmdAttrs(cmd)

	var childStdin io.WriteCloser
	if spec.Stdin != "" {
		stdinPipe, err := cmd.StdinPipe()
		if err == nil {
			childStdin = stdinPipe
		}
	}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		emit(OutputMessage{Type: "error", Message: fmt.Sprintf("failed to create stdout pipe: %v", err)})
		os.Exit(1)
	}

	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		emit(OutputMessage{Type: "error", Message: fmt.Sprintf("failed to create stderr pipe: %v", err)})
		os.Exit(1)
	}

	if err := cmd.Start(); err != nil {
		emit(OutputMessage{Type: "error", Message: fmt.Sprintf("failed to start process: %v", err)})
		os.Exit(1)
	}

	if err := job.assignProcess(cmd); err != nil {
        _ = cmd.Process.Kill()
        _ = cmd.Wait()
        emit(OutputMessage{Type: "error", Message: "cannot attach process containment: " + err.Error()})
        os.Exit(1)
    }

	emit(OutputMessage{
		Type:  "started",
		Pid:   cmd.Process.Pid,
		JobId: spec.Id,
	})

	// 精确超时调度 (RQ-19 & H02)
	var timeoutTimer *time.Timer
	if spec.TimeoutMs > 0 {
		timeoutTimer = time.AfterFunc(time.Duration(spec.TimeoutMs)*time.Millisecond, func() {
			_ = job.terminate(1)
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			_ = stdoutPipe.Close()
			_ = stderrPipe.Close()
		})
	}

	if childStdin != nil {
		go func() {
			_, _ = io.WriteString(childStdin, spec.Stdin)
			_ = childStdin.Close()
		}()
	}

	var wg sync.WaitGroup
	wg.Add(2)

	// 流式读取 stdout
	go func() {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		for {
			n, err := stdoutPipe.Read(buf)
			if n > 0 {
				emit(OutputMessage{
					Type: "stdout",
					Data: base64.StdEncoding.EncodeToString(buf[:n]),
				})
			}
			if err != nil {
				break
			}
		}
	}()

	// 流式读取 stderr
	go func() {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		for {
			n, err := stderrPipe.Read(buf)
			if n > 0 {
				emit(OutputMessage{
					Type: "stderr",
					Data: base64.StdEncoding.EncodeToString(buf[:n]),
				})
			}
			if err != nil {
				break
			}
		}
	}()

	// 监听后续 stdin 指令（如 stop）
	go func() {
		for {
			line, err := reader.ReadString('\n')
            if err != nil {
                // The controller disappeared: terminate this job, never orphan its children.
                _ = job.terminate(1)
                _ = cmd.Process.Kill()
                _ = stdoutPipe.Close()
                _ = stderrPipe.Close()
                return
            }
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			var cmdMap map[string]interface{}
			if err := json.Unmarshal([]byte(line), &cmdMap); err == nil {
				if act, ok := cmdMap["action"].(string); ok && act == "stop" {
					if timeoutTimer != nil {
						timeoutTimer.Stop()
					}
					_ = job.terminate(1)
					if cmd.Process != nil {
						_ = cmd.Process.Kill()
					}
					return
				}
			}
		}
	}()

	wg.Wait()
	err = cmd.Wait()
	if timeoutTimer != nil {
		timeoutTimer.Stop()
	}

	exitCode := 0
	if err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			exitCode = exitError.ExitCode()
		} else {
			exitCode = -1
		}
	}

	// 显式序列化退出码 code: 0 (RQ-19 & H01)
	emit(OutputMessage{
		Type: "exit",
		Code: &exitCode,
	})
	_ = job.terminate(0)
}
