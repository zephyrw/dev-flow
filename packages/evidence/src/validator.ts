import { statSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import type { Store } from "../../store/src/store.js";
import {
  type Workflow,
  type Run,
  type Plan,
  type Delivery,
  type InputManifest,
  type DeliveryIssue,
  type AcceptanceResult,
  type Workspace,
  FlowError,
} from "../../contracts/src/index.js";
import { id, now } from "../../core/src/util.js";
import { parseReport } from "./parse.js";
import type { NativeRunRecordReader } from "./native-run-records.js";
import { WorkspaceFingerprintService } from "../../workspace/src/fingerprint.js";
import { reportKey, reportSourceKey } from "./native-execution-observer.js";
import { objectHash } from "../../core/src/util.js";
import { safePath } from "../../workspace/src/files.js";
import { matchesScopePath } from "../../contracts/src/path-scope.js";
import { changesFromInitialInput } from "../../git/src/initial-state.js";

export interface ValidationResult {
  passed: boolean;
  issues: DeliveryIssue[];
  acceptanceResults: AcceptanceResult[];
}

export class EvidenceValidator {
  constructor(private store: Store) {}

  validate(options: {
    workflow: Workflow;
    run: Run;
    plan: Plan;
    delivery: Delivery;
    archivedReports: Map<
      string,
      { path: string; hash: string; rawContent: string }
    >;
    hostRecordReader: NativeRunRecordReader;
    currentInputManifest: InputManifest;
    inputFingerprints?: Record<string, string>;
    workspaceRoot: string;
    workspaces?: Workspace[];
  }): ValidationResult {
    const {
      workflow,
      run,
      plan,
      delivery,
      archivedReports,
      hostRecordReader,
      currentInputManifest,
      workspaceRoot,
      workspaces,
    } = options;

    const issues: DeliveryIssue[] = [];
    const acceptanceResults: AcceptanceResult[] = [];
    const manifest = delivery.manifest;
    const repositories = workspaces?.length
      ? workspaces
      : [{ repo_id: "main", root: workspaceRoot } as Workspace];
    const repoFor = (repo?: string) =>
      repositories.find(
        (w) =>
          w.repo_id ===
          (repo ??
            (repositories.length === 1 ? repositories[0]!.repo_id : undefined)),
      );
    const currentFingerprints = options.inputFingerprints ?? {
      [repositories[0]!.repo_id]: currentInputManifest.fingerprint,
    };
    const conversation = this.store.get<{ id: string }>(
      "conversation",
      workflow.id,
    )?.id;

    const addIssue = (
      code: string,
      message: string,
      moduleId?: string,
      sceneId?: string,
    ) => {
      const key = objectHash({ code, message, moduleId, sceneId });
      if (issues.some((i) => i.issue_key === key)) return;
      issues.push({
        issue_key: key,
        id: id("iss"),
        workflow_id: workflow.id,
        delivery_id: delivery.id,
        code,
        message,
        module_id: moduleId,
        scene_id: sceneId,
        status: "open",
        created_at: now(),
      });
    };

    // 1. 检查实现项覆盖与路径存在性 (F04 / R6)
    if (!manifest.implementations || manifest.implementations.length === 0) {
      addIssue("IMPLEMENTATIONS_EMPTY", "交付清单中的实现项列表不能为空");
    } else {
      const implementedTaskIds = new Set(
        manifest.implementations.map((i) => i.task_id).filter(Boolean),
      );
      for (const task of plan.tasks) {
        if (!implementedTaskIds.has(task.id)) {
          addIssue(
            "TASK_NOT_IMPLEMENTED",
            `任务 '${task.id}' (${task.title}) 未在交付实现项中声明`,
          );
        }
      }
      for (const impl of manifest.implementations) {
        try {
          const ws = repoFor(impl.repo_id);
          if (!ws) throw new Error("Unknown repository");
          const task = plan.tasks.find((t) => t.id === impl.task_id);
          if (
            !task ||
            (task.repo_id ?? repositories[0]!.repo_id) !== ws.repo_id
          )
            throw new Error("Task repository mismatch");
          const fullImplPath = safePath(ws.root, impl.path);
          if (!existsSync(fullImplPath)) {
            addIssue(
              "IMPLEMENTATION_PATH_NOT_FOUND",
              `实现文件 '${impl.path}' 在工作区中不存在`,
            );
          }
        } catch {
          addIssue(
            "IMPLEMENTATION_PATH_INVALID",
            `实现文件路径 '${impl.path}' 非法`,
          );
        }
      }
    }

    // 2. 检查未解决的设计冲突与未完成项 (F04 / R6)
    if (manifest.plan_conflicts && manifest.plan_conflicts.length > 0) {
      for (const c of manifest.plan_conflicts) {
        addIssue(
          "UNRESOLVED_PLAN_CONFLICT",
          `存在未解决的设计冲突 '${c.id}': ${c.description}`,
        );
      }
    }
    if (manifest.unfinished_items && manifest.unfinished_items.length > 0) {
      for (const item of manifest.unfinished_items) {
        addIssue(
          "UNFINISHED_ITEM",
          `清单中包含未完成项 '${item.id}': ${item.reason}`,
        );
      }
    }

    for (const field of [
      "schema_version",
      "submission_id",
      "workflow_id",
      "run_id",
      "conversation_id",
      "plan_revision",
      "plan_hash",
    ] as const) {
      if (manifest[field] == null || manifest[field] === "")
        addIssue("IDENTITY_MISSING", "缺少原生交付身份字段: " + field);
    }
    if (!conversation || conversation !== manifest.conversation_id)
      addIssue("IDENTITY_MISMATCH", "交付会话与服务端当前会话不一致");
    const calls = manifest.test_executions.map((e) => e.tool_call_id);
    if (new Set(calls).size !== calls.length)
      addIssue("DUPLICATE_EXECUTION", "执行 ID 重复，无法唯一映射");
    // 0. 校验身份、运行轮次与计划版本先验一致性 (B03 / S04, R10)
    if (manifest.schema_version && manifest.schema_version !== "v2") {
      addIssue(
        "SCHEMA_VERSION_INVALID",
        `清单 schema_version 必须为 'v2'，收到: '${manifest.schema_version}'`,
      );
    }
    if (manifest.conversation_id) {
      const facts = hostRecordReader?.getAllFacts() ?? [];
      const factWithConv = facts.find((f) => f.conversation_id);
      if (
        factWithConv &&
        factWithConv.conversation_id !== manifest.conversation_id
      ) {
        addIssue(
          "IDENTITY_MISMATCH",
          `清单声明的 conversation_id (${manifest.conversation_id}) 与宿主事实中的会话 (${factWithConv.conversation_id}) 不一致`,
        );
      }
    }
    if (manifest.workflow_id && manifest.workflow_id !== workflow.id) {
      addIssue(
        "IDENTITY_MISMATCH",
        `清单声明的 workflow_id (${manifest.workflow_id}) 与实际工作流 (${workflow.id}) 不一致`,
      );
    }
    if (manifest.run_id && manifest.run_id !== run.id) {
      addIssue(
        "RUN_MISMATCH",
        `清单声明的 run_id (${manifest.run_id}) 与实际运行轮次 (${run.id}) 不一致`,
      );
    }
    if (
      manifest.plan_revision != null &&
      manifest.plan_revision !== workflow.plan_revision
    ) {
      addIssue(
        "PLAN_REVISION_MISMATCH",
        `清单声明的 plan_revision (${manifest.plan_revision}) 与实际计划版本 (${workflow.plan_revision}) 不一致`,
      );
    }
    if (
      manifest.plan_hash &&
      workflow.plan_hash &&
      manifest.plan_hash !== workflow.plan_hash
    ) {
      addIssue(
        "PLAN_HASH_MISMATCH",
        `清单声明的 plan_hash 与实际计划哈希不一致`,
      );
    }

    // 3. 核对宿主原始执行记录与退出码
    const validExecutions = new Set<string>();
    for (const exec of manifest.test_executions) {
      const ws = repoFor(exec.repo_id);
      const fact = hostRecordReader.getFact(exec.tool_call_id);
      if (!ws)
        addIssue(
          "REPOSITORY_INVALID",
          "执行引用未知或未明确的仓库: " + exec.repo_id,
        );
      if (
        !fact ||
        fact.workflow_id !== workflow.id ||
        fact.run_id !== run.id ||
        fact.plan_hash !== workflow.plan_hash ||
        fact.conversation_id !== conversation
      )
        addIssue(
          "HOST_IDENTITY_MISMATCH",
          "宿主事实不属于当前会话、轮次和计划: " + exec.tool_call_id,
        );
      if (
        !fact?.started_at ||
        !fact.ended_at ||
        !Number.isFinite(Date.parse(fact.started_at)) ||
        !Number.isFinite(Date.parse(fact.ended_at)) ||
        Date.parse(fact.ended_at) < Date.parse(fact.started_at)
      )
        addIssue(
          "HOST_TIME_MISSING",
          "缺少可信的执行开始/结束记录: " + exec.tool_call_id,
        );
      if (fact?.evidence_error)
        addIssue("INPUT_EVIDENCE_INVALID", fact.evidence_error);
      if (
        !fact?.input_fingerprints ||
        Object.keys(currentFingerprints).some(
          (repo) =>
            fact.input_fingerprints?.[repo] !== currentFingerprints[repo],
        )
      )
        addIssue(
          "FINGERPRINT_STALE",
          "测试时输入版本缺失或与当前代码不同: " + exec.tool_call_id,
        );
      if (!fact?.cwd || !exec.cwd)
        addIssue("EXECUTION_CWD_MISSING", "缺少实际测试工作目录");
      if (ws && fact?.cwd) {
        try {
          const rel = relative(realpathSync(ws.root), realpathSync(fact.cwd));
          if (
            rel === ".." ||
            rel.startsWith("..\\") ||
            rel.startsWith("../") ||
            isAbsolute(rel)
          )
            addIssue(
              "EXECUTION_REPOSITORY_MISMATCH",
              "测试工作目录位于声明仓库之外",
            );
        } catch {
          addIssue("EXECUTION_REPOSITORY_MISMATCH", "无法核验测试工作目录");
        }
      }
      const verification = hostRecordReader.verify({
        tool_call_id: exec.tool_call_id,
        command: exec.command,
        cwd: exec.cwd,
      });
      if (!verification.valid) {
        addIssue(
          "HOST_EXECUTION_INVALID",
          verification.reason ?? "宿主执行校验未通过",
        );
      } else {
        validExecutions.add(exec.tool_call_id);
      }
    }

    // 4. 解析归档报告
    const parsedReports = new Map<
      string,
      { id: string; status: "passed" | "failed" | "skipped" }[]
    >();
    const reportFormatMap = new Map<string, string>();
    for (const exec of manifest.test_executions) {
      for (const p of exec.report_paths) {
        if (exec.format && exec.format !== "auto") {
          reportFormatMap.set(
            reportKey(
              repoFor(exec.repo_id)?.repo_id ?? "",
              exec.tool_call_id,
              p,
            ),
            exec.format,
          );
        }
      }
    }

    for (const [relPath, info] of archivedReports.entries()) {
      try {
        let parser = reportFormatMap.get(relPath);
        if (!parser) {
          const raw = info.rawContent.trim();
          if (
            relPath.endsWith(".xml") ||
            raw.startsWith("<?xml") ||
            raw.includes("<testsuite")
          ) {
            parser = "junit";
          } else if (
            raw.includes('"suites"') ||
            raw.includes('"specs"') ||
            relPath.includes("playwright")
          ) {
            parser = "playwright_json";
          } else {
            parser = "vitest_json";
          }
        }
        const parsed = parseReport(parser, info.rawContent);
        if (parsed.cases.length === 0) {
          addIssue(
            "EMPTY_REPORT",
            `测试报告 '${relPath}' 中未包含任何测试用例结果`,
          );
        }
        if (new Set(parsed.cases.map((c) => c.id)).size !== parsed.cases.length)
          addIssue("DUPLICATE_CASE", "报告案例 ID 重复: " + relPath);
        if (parsed.cases.some((c) => c.status === "failed"))
          addIssue("REPORT_CASE_FAILED", "报告包含失败案例: " + relPath);
        parsedReports.set(relPath, parsed.cases);
      } catch (err: any) {
        addIssue(
          "REPORT_PARSE_FAILED",
          `解析测试报告 '${relPath}' 失败: ${err.message ?? err}`,
        );
      }
    }

    const isMultiRepo = (options.workspaces?.length ?? 0) > 1;
    // 检查清单中声明的报告是否全部归档成功 (C03 / R04)
    for (const exec of manifest.test_executions) {
      const repoId = repoFor(exec.repo_id)?.repo_id ?? "";
      for (const reportPath of exec.report_paths) {
        const repoReportKey = reportKey(repoId, exec.tool_call_id, reportPath);
        const hasReport = archivedReports.has(repoReportKey);
        const info = archivedReports.get(repoReportKey);
        const fact = hostRecordReader.getFact(exec.tool_call_id);
        if (
          info &&
          fact?.report_hashes?.[reportSourceKey(repoId, reportPath)] !==
            info.hash
        )
          addIssue(
            "REPORT_EXECUTION_MISMATCH",
            "报告不是该宿主调用完成时记录的原始结果: " + reportPath,
          );
        if (!hasReport) {
          addIssue(
            "REPORT_MISSING",
            `仓库 '${repoId}' 测试执行声明的报告文件 '${reportPath}' 缺失或无法读取`,
          );
        }
      }
    }

    // 5. 校验必需验收项覆盖、映射与报告归属 (B03 / S09, R04, R05)
    for (const test of plan.tests) {
      if (plan.exemptions?.some((e) => e.layer === test.layer)) {
        continue;
      }

      for (const expectedCaseId of test.expected_case_ids) {
        const mapping = manifest.acceptance_mappings.find(
          (m) =>
            m.requirement_id === test.id &&
            (m.scene_id === expectedCaseId || m.case_id === expectedCaseId),
        );

        if (!mapping) {
          addIssue(
            "ACCEPTANCE_ITEM_MISSING",
            `验收项 '${test.id}' 中的场景用例 '${expectedCaseId}' 未在交付清单中提供测试映射`,
            test.task_ids?.[0],
            expectedCaseId,
          );
          continue;
        }

        const declaredExec = manifest.test_executions.find(
          (e) => e.tool_call_id === mapping.test_execution_id,
        );
        if (!declaredExec) {
          addIssue(
            "INVALID_EXECUTION_REFERENCE",
            `验收项 '${test.id}' 映射引用的测试执行 '${mapping.test_execution_id}' 在清单中不存在`,
            test.task_ids?.[0],
            expectedCaseId,
          );
          continue;
        }

        // 报告归属核查 (S09)：mapping.report_path 必须声明在对应 test_execution 的 report_paths 中
        const normMappingReport = mapping.report_path
          .replaceAll("\\", "/")
          .replace(/^\/+/, "");
        const normExecReports = declaredExec.report_paths.map((p) =>
          p.replaceAll("\\", "/").replace(/^\/+/, ""),
        );
        if (!normExecReports.includes(normMappingReport)) {
          addIssue(
            "REPORT_EXECUTION_MISMATCH",
            `验收项 '${test.id}' 映射引用的报告 '${mapping.report_path}' 不属于测试执行 '${mapping.test_execution_id}' (该执行报告列表: ${declaredExec.report_paths.join(", ") || "空"})`,
            test.task_ids?.[0],
            expectedCaseId,
          );
          continue;
        }

        const repoId = repoFor(declaredExec.repo_id)?.repo_id ?? "";
        const repoReportKey = reportKey(
          repoId,
          declaredExec.tool_call_id,
          mapping.report_path,
        );
        const cases = parsedReports.get(repoReportKey);
        if (!cases) {
          addIssue(
            "MAPPING_REPORT_UNAVAILABLE",
            `验收项用例 '${expectedCaseId}' 映射的仓库 '${repoId}' 报告 '${mapping.report_path}' 不可用`,
            test.task_ids?.[0],
            expectedCaseId,
          );
          continue;
        }

        const taskRepos = test.task_ids.map(
          (taskId) =>
            plan.tasks.find((t) => t.id === taskId)?.repo_id ??
            repositories[0]!.repo_id,
        );
        if (!taskRepos.includes(repoId))
          addIssue(
            "ACCEPTANCE_REPOSITORY_MISMATCH",
            "场景报告来自其他仓库: " + test.id,
          );
        const caseResult = cases.find((c) => c.id === mapping.case_id);
        if (!caseResult) {
          addIssue(
            "CASE_NOT_FOUND_IN_REPORT",
            `验收项用例 '${expectedCaseId}' 在报告 '${mapping.report_path}' 中未找到匹配的实际结果`,
            test.task_ids?.[0],
            expectedCaseId,
          );
          continue;
        }

        if (caseResult.status === "failed") {
          addIssue(
            "ACCEPTANCE_CASE_FAILED",
            `验收项 '${test.id}' 的测试用例 '${caseResult.id}' 处于失败状态`,
            test.task_ids?.[0],
            expectedCaseId,
          );
        } else if (caseResult.status === "skipped") {
          addIssue(
            "ACCEPTANCE_CASE_SKIPPED",
            `验收项 '${test.id}' 的测试用例 '${caseResult.id}' 被跳过，必需验收项不允许跳过`,
            test.task_ids?.[0],
            expectedCaseId,
          );
        }

        acceptanceResults.push({
          id: id("acr"),
          workflow_id: workflow.id,
          delivery_id: delivery.id,
          requirement_id: test.id,
          scene_id: mapping.scene_id || test.id,
          test_execution_id: mapping.test_execution_id,
          case_id: caseResult.id,
          status: caseResult.status,
          reason:
            caseResult.status !== "passed"
              ? `测试状态为 ${caseResult.status}`
              : undefined,
        });
      }
    }

    // 6. 工作区多仓整体范围与变动文件检查 (B04 / S05, S10)
    const allWorkspaces =
      options.workspaces && options.workspaces.length > 0
        ? options.workspaces
        : [{ id: "ws-main", repo_id: "main", root: workspaceRoot } as any];

    const reportPathsSet = new Set(
      manifest.test_executions.flatMap((e) =>
        e.report_paths.map((p) => p.replaceAll("\\", "/")),
      ),
    );

    const allChangedFilesWithRoot: { rel: string; wsRoot: string }[] = [];

    for (const ws of allWorkspaces) {
      const wsRoot = ws.root || workspaceRoot;
      const allowedPaths = new Set(
        (
          plan.scope?.repository_paths?.[ws.repo_id] ??
          plan.scope?.allowed_paths ??
          []
        ).map((p) => p.replaceAll("\\", "/")),
      );

      let wsChanged: string[] = [];
      try {
        if (ws.initial_worktree_tree) {
          wsChanged = changesFromInitialInput(wsRoot, ws.initial_worktree_tree);
          allChangedFilesWithRoot.push(
            ...wsChanged.map((rel) => ({ rel, wsRoot })),
          );
        } else {
          const raw = execFileSync(
            "git",
            ["status", "--porcelain", "-z", "-uall"],
            {
              cwd: wsRoot,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            },
          );
          if (raw) {
            const rawEntries = raw.split("\0");
            for (let i = 0; i < rawEntries.length; i++) {
              const entry = rawEntries[i];
              if (!entry) continue;
              const status = entry.slice(0, 2);
              let rel = entry.slice(3).trim().replaceAll("\\", "/");
              // 重命名 (R) 或 复制 (C) 在 -z 下紧跟原路径 (B04)
              if (
                (status[0] === "R" || status[0] === "C" || status[1] === "R") &&
                i + 1 < rawEntries.length
              ) {
                const origPath = rawEntries[++i]?.trim().replaceAll("\\", "/");
                if (origPath) {
                  wsChanged.push(origPath);
                  allChangedFilesWithRoot.push({ rel: origPath, wsRoot });
                }
              }
              if (!rel) continue;

              // 递归展开未跟踪目录 (B04)
              const fullPath = join(wsRoot, rel);
              if (
                rel.endsWith("/") ||
                (existsSync(fullPath) && statSync(fullPath).isDirectory())
              ) {
                const expandDir = (subRel: string) => {
                  const absSub = join(wsRoot, subRel);
                  if (!existsSync(absSub)) return;
                  const entries = readdirSync(absSub, { withFileTypes: true });
                  for (const ent of entries) {
                    const childRel = `${subRel.replace(/\/+$/, "")}/${ent.name}`;
                    if (ent.isDirectory()) {
                      expandDir(childRel);
                    } else if (ent.isFile()) {
                      wsChanged.push(childRel);
                      allChangedFilesWithRoot.push({ rel: childRel, wsRoot });
                    }
                  }
                };
                expandDir(rel.replace(/\/+$/, ""));
              } else {
                wsChanged.push(rel);
                allChangedFilesWithRoot.push({ rel, wsRoot });
              }
            }
          }
        }
      } catch (err: any) {
        addIssue(
          "GIT_OPERATION_FAILED",
          `工作区 '${ws.repo_id ?? "main"}' Git 状态检查失败: ${err.message ?? err}`,
        );
      }

      // 范围核对：该仓库变动必须在允许范围内
      for (const f of wsChanged) {
        const within = (p: string) =>
          matchesScopePath(f, p, /^[A-Za-z]:/.test(wsRoot));
        if (plan.scope.protected_paths.some(within)) {
          addIssue(
            "PROTECTED_PATH",
            `工作区 '${ws.repo_id}' 修改了受保护路径 '${f}'`,
          );
          continue;
        }
        if (
          !plan.scope.allow_dependency_changes &&
          /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pom\.xml|requirements.*\.txt)$/.test(
            f,
          )
        ) {
          addIssue(
            "DEPENDENCY_DENIED",
            `工作区 '${ws.repo_id}' 的依赖文件 '${f}' 未获修改批准`,
          );
          continue;
        }
        if (f.startsWith(".reports/") || f.startsWith("reports/")) {
          continue;
        }
        if (![...allowedPaths].some(within)) {
          addIssue(
            "OUTSIDE_SCOPE_FILE",
            `工作区 '${ws.repo_id ?? "main"}' 文件 '${f}' 超出了计划批准的修改范围`,
          );
        }
      }

      // 多仓报告存在性检查 (S10)：若该仓库在计划中有任务或测试，必须有对应的报告
      const hasTasksInRepo = plan.tasks.some((t) => t.repo_id === ws.repo_id);
      if (hasTasksInRepo) {
        const hasReportInRepo = manifest.test_executions.some(
          (e) =>
            (e.repo_id === ws.repo_id || !e.repo_id) &&
            e.report_paths.length > 0,
        );
        if (!hasReportInRepo) {
          addIssue(
            "REPORT_MISSING",
            `仓库 '${ws.repo_id}' 存在计划任务但缺少测试执行报告`,
          );
        }
      }
    }

    // 7. 处理核验结果持久化
    const passed = issues.length === 0;

    return this.store.transaction(() => {
      // 存储所有产生的 issues
      for (const issue of issues) {
        this.store.put("delivery_issue", issue.id, workflow.id, issue);
      }

      // 更新 delivery 状态
      const updatedDelivery: Delivery = {
        ...delivery,
        status: passed ? "pending" : "rejected",
      };
      this.store.put("delivery", delivery.id, workflow.id, updatedDelivery);

      if (passed) {
        // 存储验收结果
        for (const res of acceptanceResults) {
          this.store.put("acceptance_result", res.id, workflow.id, res);
        }
      }

      return {
        passed,
        issues,
        acceptanceResults,
      };
    });
  }
}
