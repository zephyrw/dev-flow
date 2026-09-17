import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  Id,
  requireCondition,
  type Workflow,
} from "../../contracts/src/index.js";
import { git, repositoryInfo } from "../../git/src/git.js";
import { WorkspaceFingerprintService } from "../../workspace/src/fingerprint.js";
import type { Engine } from "./engine.js";
import { DocumentService } from "./document-service.js";
import { FeedbackService } from "./feedback-service.js";
import { readPlanMaterial } from "./plan-review.js";
import { hash, id, now, objectHash } from "./util.js";

interface SourceVersion {
  repo_id: string;
  root: string;
  branch: string;
  common_dir: string;
  previous_commit: string;
  current_commit: string;
  fingerprint: string;
  index_hash: string;
  local_changes: string;
  commits: string[];
  changed_files: string[];
}
export interface SourceChangePreview {
  id: string;
  workflow_id: string;
  version: number;
  plan_revision: number;
  plan_hash: string;
  project_hash: string;
  repositories: SourceVersion[];
  created_at: string;
}
export interface SourceInput extends SourceChangePreview {
  choice: "continue" | "replan";
  next_plan_revision: number;
}
export const SourceChoiceSchema = z
  .object({
    request_id: Id,
    preview_id: Id,
    choice: z.enum(["continue", "replan"]),
    instructions: z.string().trim().max(20000).default(""),
  })
  .strict();

export function canResolveSourceChange(engine: Engine, w: Workflow) {
  return (
    w.state === "BLOCKED" &&
    w.blocker?.code === "BASELINE_CHANGED" &&
    w.workspace_mode === "existing_workspace" &&
    engine.store.list("workspace", w.id).length === 0 &&
    !engine.store
      .list<any>("run", w.id)
      .some((r) => !["planning", "aside"].includes(r.stage))
  );
}

async function capture(engine: Engine, key: string): Promise<SourceVersion[]> {
  const project = engine.project(engine.get(key).project_id);
  const roots = engine.store.get<{ roots: Record<string, string> }>(
    "entry_context",
    key,
  )?.roots;
  const baseline = engine.plan(key).plan.baselines;
  return Promise.all(
    project.repositories.map(async (repo) => {
      const root = roots?.[repo.id] ?? repo.path;
      const [info, registered] = await Promise.all([
        repositoryInfo(root),
        repositoryInfo(repo.path),
      ]);
      requireCondition(
        info.common_dir.toLowerCase() === registered.common_dir.toLowerCase(),
        "PROJECT_MISMATCH",
        "当前文件夹已不属于该项目，请先恢复正确的项目位置",
        409,
      );
      const previous = baseline[repo.id]!;
      const readGit = (args: string[]) =>
        git(root, args, { GIT_OPTIONAL_LOCKS: "0" });
      const index = resolve(
        root,
        await readGit(["rev-parse", "--git-path", "index"]),
      );
      const indexHash = () =>
        existsSync(index) ? hash(readFileSync(index)) : "missing";
      const beforeIndex = indexHash();
      const fingerprint = WorkspaceFingerprintService.compute(root).fingerprint;
      const [local, commits, files, head] = await Promise.all([
        readGit([
          "-c",
          "core.quotepath=false",
          "status",
          "--porcelain=v1",
          "--untracked-files=normal",
        ]),
        readGit(["log", "-20", "--format=%h %s", `${previous}..${info.head}`]),
        readGit([
          "-c",
          "core.quotepath=false",
          "diff",
          "--name-status",
          previous,
          info.head,
          "--",
        ]),
        readGit(["rev-parse", "HEAD"]),
      ]);
      requireCondition(
        head === info.head &&
          indexHash() === beforeIndex &&
          fingerprint === WorkspaceFingerprintService.compute(root).fingerprint,
        "SOURCE_CHANGED",
        "读取期间项目代码又有变化，请重新查看代码更新",
        409,
      );
      return {
        repo_id: repo.id,
        root: info.path,
        branch: info.branch,
        common_dir: info.common_dir,
        previous_commit: previous,
        current_commit: info.head,
        fingerprint,
        index_hash: beforeIndex,
        local_changes: local,
        commits: commits ? commits.split("\n") : [],
        changed_files: files ? files.split("\n") : [],
      };
    }),
  );
}

function signature(repositories: SourceVersion[]) {
  return objectHash(
    repositories.map(
      ({ previous_commit, commits, changed_files, ...stable }) => stable,
    ),
  );
}

// Recheck the exact code the user saw before any model or execution is started.
export async function assertSelectedSource(engine: Engine, w: Workflow) {
  const selected = engine.store.get<SourceInput>("source_input", w.id);
  if (!selected || engine.store.list("workspace", w.id).length) return;
  const applicable =
    w.state === "PLANNING"
      ? selected.choice === "replan" && w.plan_hash === selected.plan_hash
      : w.plan_revision === selected.next_plan_revision;
  if (!applicable) return;
  requireCondition(
    signature(await capture(engine, w.id)) === signature(selected.repositories),
    "BASELINE_CHANGED",
    "你确认后项目代码又发生了变化，请重新查看并选择使用哪个代码版本。",
    409,
  );
}

export class SourceChangeService {
  constructor(private engine: Engine) {}

  async preview(key: string, expectedVersion: number) {
    const w = this.engine.get(key);
    this.assertEligible(w);
    requireCondition(
      w.version === expectedVersion,
      "VERSION_CONFLICT",
      "任务状态已更新，请关闭窗口后重试",
      409,
    );
    const repositories = await capture(this.engine, key);
    requireCondition(
      this.engine.get(key).version === w.version,
      "VERSION_CONFLICT",
      "任务状态已更新，请关闭窗口后重试",
      409,
    );
    const preview: SourceChangePreview = {
      id: id("source-preview"),
      workflow_id: key,
      version: w.version,
      plan_revision: w.plan_revision,
      plan_hash: w.plan_hash!,
      project_hash: objectHash(this.engine.project(w.project_id)),
      repositories,
      created_at: now(),
    };
    this.engine.store.put("source_change_preview", preview.id, key, preview);
    return preview;
  }

  private assertEligible(w: Workflow) {
    requireCondition(
      canResolveSourceChange(this.engine, w),
      "SOURCE_CHOICE_UNAVAILABLE",
      "此入口用于开始开发前的代码更新。已有执行记录的任务需保留现场，通过计划调整处理。",
      409,
    );
  }

  async resolve(key: string, input: unknown) {
    const body = SourceChoiceSchema.parse(input),
      resultKey = `${key}:${body.request_id}`;
    const replay = () => {
      const previous = this.engine.store.get<{
        hash: string;
        workflow: Workflow;
      }>("source_change_result", resultKey);
      requireCondition(
        !previous || previous.hash === objectHash(body),
        "IDEMPOTENCY_CONFLICT",
        "同一次操作的选择发生了变化，请重新提交",
        409,
      );
      return previous?.workflow;
    };
    const prior = replay();
    if (prior) return prior;
    const preview = this.engine.store.must<SourceChangePreview>(
      "source_change_preview",
      body.preview_id,
    );
    requireCondition(
      preview.workflow_id === key,
      "FORBIDDEN",
      "代码更新记录不属于此任务",
      403,
    );
    this.assertEligible(this.engine.get(key));
    requireCondition(
      Date.now() - Date.parse(preview.created_at) < 600000,
      "PREVIEW_EXPIRED",
      "代码更新信息已过期，请重新查看",
      409,
    );
    const current = await capture(this.engine, key);
    requireCondition(
      signature(current) === signature(preview.repositories),
      "SOURCE_CHANGED",
      "查看后项目代码又有变化，尚未执行。请重新查看代码更新后再选择。",
      409,
    );
    return this.engine.store.transaction(() => {
      const previous = replay();
      if (previous) return previous;
      const w = this.engine.get(key);
      this.assertEligible(w);
      requireCondition(
        w.version === preview.version &&
          w.plan_hash === preview.plan_hash &&
          objectHash(this.engine.project(w.project_id)) ===
            preview.project_hash,
        "VERSION_CONFLICT",
        "计划或任务配置已变化，请重新查看后再选择",
        409,
      );
      const selected: SourceInput = {
        ...preview,
        choice: body.choice,
        next_plan_revision: w.plan_revision + 1,
      };
      this.engine.store.put("source_input", key, key, selected);
      this.engine.store.put("source_choice", preview.id, key, {
        ...selected,
        instructions: body.instructions,
        confirmed_at: now(),
      });
      let workflow: Workflow;
      if (body.choice === "continue") {
        const material = readPlanMaterial(
          this.engine.store,
          key,
          w.plan_revision,
        );
        const markdown =
          material.markdown +
          "\n\n## 本次执行使用的代码版本\n\n" +
          "用户已查看项目代码更新，选择保留原任务范围、实施步骤和验收要求，使用当前主工作区继续。以下记录替代上文旧的起始代码版本；已有本地修改作为输入保留。\n\n" +
          preview.repositories
            .map(
              (r) =>
                `- ${r.repo_id}：${r.previous_commit} → ${r.current_commit}（${r.branch}）`,
            )
            .join("\n") +
          "\n";
        const plan = {
          ...material.plan,
          revision: w.plan_revision + 1,
          markdown,
          baselines: Object.fromEntries(
            preview.repositories.map((r) => [r.repo_id, r.current_commit]),
          ),
          ...(material.plan.design_ref
            ? {
                design_ref: {
                  ...material.plan.design_ref,
                  content_hash: hash(markdown.replace(/\r\n/g, "\n")),
                },
              }
            : {}),
        };
        const doc = new DocumentService(
          this.engine.store,
          this.engine.config.storage_root,
        ).publishDocument(key, "plan", markdown, w.plan_revision + 1);
        this.engine.submitPlan(
          key,
          plan,
          w.version,
          "source-choice-" + preview.id,
        );
        this.engine.store.put("planning_document", key, key, {
          document_id: doc.id,
          plan_revision: w.plan_revision + 1,
        });
        const binding = this.engine.binding(key, "approve");
        const receipt = this.engine.auth.recordConfirmation("approve", binding);
        workflow = this.engine.approve(key, receipt, binding);
      } else {
        const text =
          "项目代码已经更新。请以用户确认的当前代码重新核对原需求并修正完整计划，保留原任务范围，提交后等待人工批准。" +
          "\n" +
          preview.repositories
            .map(
              (r) =>
                `${r.repo_id}: ${r.previous_commit} -> ${r.current_commit}`,
            )
            .join("\n") +
          (body.instructions ? "\n补充要求：" + body.instructions : "");
        new FeedbackService(this.engine.store).submitFeedback({
          request_id: "source-" + body.request_id,
          workflow_id: key,
          kind: "planning",
          text,
          target_document_revision: w.plan_revision,
        });
        this.engine.invalidate(key, "用户选择按当前代码重新规划");
        workflow = this.engine.transition(
          key,
          ["BLOCKED"],
          "PLANNING",
          "planning",
          {
            blocker: undefined,
            run_id: undefined,
            feedback: [...w.feedback, text],
          },
        );
        this.engine.scheduler.enqueue(key, w.project_id);
        this.engine.store.enqueue(key, "dispatch_run", { purpose: "planning" });
      }
      this.engine.store.event(key, w.project_id, "SourceVersionSelected", {
        choice: body.choice,
        preview_id: preview.id,
        plan_revision: workflow.plan_revision,
        message:
          body.choice === "continue"
            ? "已确认使用当前代码，按原计划继续"
            : "已选择按当前代码重新规划，等待新计划批准",
      });
      this.engine.store.put("source_change_result", resultKey, key, {
        hash: objectHash(body),
        workflow,
      });
      return workflow;
    });
  }
}
