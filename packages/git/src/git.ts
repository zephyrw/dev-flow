import { captureInitialState } from "./initial-state.js";
import { safePath } from "../../workspace/src/files.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  realpathSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { Store } from "../../store/src/store.js";
import {
  FlowError,
  requireCondition,
  type Project,
  type Workspace,
  type Snapshot,
} from "../../contracts/src/index.js";
import { hash, id, now, objectHash, atomicWrite } from "../../core/src/util.js";
const run = promisify(execFile);
export async function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input?: string,
): Promise<string> {
  if (input !== undefined)
    return new Promise((yes, no) => {
      const p = execFile(
        "git",
        args,
        {
          cwd,
          env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
        },
        (err, out) => (err ? no(err) : yes(out.trimEnd())),
      );
      p.stdin!.end(input);
    });
  return (
    await run("git", args, {
      cwd,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    })
  ).stdout.trimEnd();
}
export async function repositoryInfo(root: string) {
  const path = realpathSync(root);
  return {
    path,
    common_dir: realpathSync(
      resolve(path, await git(path, ["rev-parse", "--git-common-dir"])),
    ),
    head: await git(path, ["rev-parse", "HEAD"]),
    branch: await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  };
}
export class GitManager {
  constructor(
    private store: Store,
    private workspaceRoot: string,
    private storageRoot: string,
  ) {}
  async prepare(
    project: Project,
    workflow: string,
    mode: "existing_workspace" | "new_worktree",
    baselines: Record<string, string>,
  ) {
    const result: Workspace[] = [];
    for (const repo of project.repositories) {
      const existing = this.store
        .list<Workspace>("workspace", workflow)
        .find((w) => w.repo_id === repo.id);
      if (existing) {
        result.push(existing);
        continue;
      }
      const info = await repositoryInfo(repo.path);
      const baseline = baselines[repo.id];
      requireCondition(baseline, "BASELINE_MISSING", "缺少仓库基线");
      requireCondition(
        (await git(repo.path, ["rev-parse", baseline + "^{commit}"])) ===
          baseline,
        "BASELINE_INVALID",
        "基线无效",
      );
      let root = repo.path,
        branch = info.branch;
      if (mode === "new_worktree") {
        root = join(this.workspaceRoot, project.id, workflow, repo.id);
        branch = `devflow/${workflow}/${repo.id}`;
        const intentKey = workflow + "-" + repo.id;
        const previous = this.store.get<{
          root: string;
          branch: string;
          baseline: string;
        }>("workspace_intent", intentKey);
        if (previous)
          requireCondition(
            previous.root === root &&
              previous.branch === branch &&
              previous.baseline === baseline,
            "WORKTREE_INTENT_MISMATCH",
            "工作区创建意图不匹配",
          );
        this.store.put("workspace_intent", intentKey, workflow, {
          root,
          branch,
          baseline,
        });
        mkdirSync(resolve(root, ".."), { recursive: true });
        if (existsSync(root)) {
          requireCondition(
            previous,
            "WORKTREE_EXISTS",
            "目标目录已经存在且不属于本次创建",
          );
          const recovered = await repositoryInfo(root);
          requireCondition(
            recovered.common_dir === info.common_dir &&
              recovered.branch === branch &&
              recovered.head === baseline &&
              (await git(root, ["status", "--porcelain"])).length === 0,
            "WORKTREE_RECOVERY_MISMATCH",
            "残留工作区不符合原创建意图",
          );
        } else {
          let branchHead: string | undefined;
          try {
            branchHead = await git(repo.path, [
              "rev-parse",
              "--verify",
              "refs/heads/" + branch,
            ]);
          } catch {}
          if (branchHead) {
            requireCondition(
              previous && branchHead === baseline,
              "WORKTREE_BRANCH_EXISTS",
              "同名分支不属于原创建意图",
            );
            await git(repo.path, ["worktree", "add", root, branch]);
          } else
            await git(repo.path, [
              "worktree",
              "add",
              "-b",
              branch,
              root,
              baseline,
            ]);
        }
      } else {
        requireCondition(
          info.head === baseline,
          "BASELINE_CHANGED",
          `项目代码已更新：制定计划时为 ${baseline.slice(0, 12)}，当前为 ${info.head.slice(0, 12)}。请在“处理代码更新”中查看变化，选择使用当前代码继续或重新规划。`,
        );
        // Preserve staged and unstaged user edits in a separate initial tree.
      }
      const ws: Workspace = {
        id: id("ws"),
        workflow_id: workflow,
        repo_id: repo.id,
        root: realpathSync(root),
        common_dir: info.common_dir,
        baseline,
        branch,
        owned: mode === "new_worktree",
        source_root: repo.path,
        source_branch: info.branch,
        ...(mode === "existing_workspace" ? captureInitialState(root) : {}),
      };
      requireCondition(
        !this.store
          .list<Workspace>("workspace")
          .some(
            (w) =>
              w.root.toLowerCase() === ws.root.toLowerCase() &&
              w.workflow_id !== workflow &&
              (this.store.get<{ state: string }>("workflow", w.workflow_id)
                ?.state !== "COMMITTED" ||
                ["ready", "starting"].includes(
                  this.store.get<{ status: string }>(
                    "environment",
                    w.workflow_id,
                  )?.status ?? "",
                )),
          ),
        "WORKSPACE_BUSY",
        "该工作区已属于其他工作流",
      );
      this.store.put("workspace", ws.id, workflow, ws);
      this.store.remove("workspace_intent", workflow + "-" + repo.id);
      result.push(ws);
    }
    return result;
  }
  async snapshot(
    workflow: string,
    environment_revision: number,
  ): Promise<Snapshot> {
    const repositories: Snapshot["repositories"] = [];
    for (const ws of this.store.list<Workspace>("workspace", workflow)) {
      const base = ws.execution_base ?? ws.baseline;
      const head = await git(ws.root, ["rev-parse", "HEAD"]);
      const intended = this.store.get<{ repos: Record<string, string> }>(
        "commit_intent",
        workflow,
      )?.repos[ws.repo_id];
      requireCondition(
        head === base || head === intended,
        "BASELINE_CHANGED",
        "HEAD 已变化",
      );
      requireCondition(
        (await git(ws.root, ["symbolic-ref", "--short", "HEAD"])) === ws.branch,
        "BRANCH_CHANGED",
        "任务分支已切换",
      );
      const indexTree = await git(ws.root, ["write-tree"]);
      const baselineTree = await git(ws.root, ["rev-parse", base + "^{tree}"]);
      const committedTree =
        head === intended
          ? await git(ws.root, ["rev-parse", head + "^{tree}"])
          : undefined;
      requireCondition(
        indexTree === (ws.initial_index_tree ?? baselineTree) ||
          (committedTree !== undefined &&
            indexTree ===
              (this.store.get<any>("commit_index", workflow + "-" + ws.repo_id)
                ?.tree ?? committedTree)),
        "INDEX_CHANGED",
        "工作区暂存区已被其他操作修改",
      );
      const files = (
        await git(ws.root, [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
        ])
      )
        .split("\0")
        .filter(Boolean);
      const paths = [...new Set(files)];
      const attributes = await git(
        ws.root,
        ["check-attr", "-z", "filter", "--stdin"],
        {},
        paths.join("\0") + "\0",
      );
      const attrs = attributes.split("\0");
      for (let i = 2; i < attrs.length; i += 3)
        requireCondition(
          ["unspecified", "unset", ""].includes(attrs[i]!),
          "FILTER_UNSUPPORTED",
          "自定义 Git clean filter 需要显式接入",
        );
      const metadata: Snapshot["repositories"][number]["files"] = [];
      for (const p of paths) {
        const full = join(ws.root, p);
        if (!existsSync(full)) continue;
        const stat = lstatSync(full);
        requireCondition(
          stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
          "SNAPSHOT_FILE_TYPE",
          `快照不接受链接/非普通文件 ${p}`,
        );
        metadata.push({
          path: p,
          hash: hash(readFileSync(full)),
          mode: stat.mode & 0o111 ? "100755" : "100644",
        });
      }
      const index = join(this.storageRoot, "indices", id("index"));
      mkdirSync(resolve(index, ".."), { recursive: true });
      const env = { GIT_INDEX_FILE: index };
      try {
        await git(ws.root, ["read-tree", base], env);
        if (paths.length)
          await git(
            ws.root,
            ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"],
            env,
            paths.join("\0") + "\0",
          );
        let tree = await git(ws.root, ["write-tree"], env);
        if (ws.initial_worktree_tree) {
          const patch = await git(ws.root, [
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            ws.initial_worktree_tree,
            tree,
            "--",
          ]);
          await git(ws.root, ["read-tree", base], env);
          if (patch) {
            try {
              await git(
                ws.root,
                ["apply", "--cached", "--whitespace=nowarn", "-"],
                env,
                patch + "\n",
              );
            } catch {
              throw new FlowError(
                "USER_CHANGE_OVERLAP",
                "任务修改与用户原有改动重叠，无法安全分离；保留现场等待处理",
              );
            }
          }
          tree = await git(ws.root, ["write-tree"], env);
        }
        const changed_paths = (
          await git(ws.root, [
            "diff",
            "--name-only",
            "-z",
            this.store.get<any>(
              "integration_candidate",
              workflow + ":" + ws.repo_id,
            )?.source_commit ?? ws.baseline,
            tree,
          ])
        )
          .split("\0")
          .filter(Boolean);
        repositories.push({
          workspace_id: ws.id,
          repo_id: ws.repo_id,
          baseline: base,
          branch: ws.branch,
          tree,
          files: metadata.sort((a, b) => a.path.localeCompare(b.path)),
          changed_paths,
        });
      } finally {
        if (existsSync(index)) unlinkSync(index);
      }
    }
    requireCondition(repositories.length, "NO_WORKSPACE", "没有已准备的工作区");
    const content = {
      workflow_id: workflow,
      environment_revision,
      repositories,
    };
    const snapshot = { ...content, id: objectHash(content), created_at: now() };
    this.store.put("snapshot", snapshot.id, workflow, snapshot);
    return snapshot;
  }
  async matches(snapshot: Snapshot) {
    const current = await this.snapshot(
      snapshot.workflow_id,
      snapshot.environment_revision,
    );
    return current.id === snapshot.id;
  }
  async changes(workflow: string, snapshot?: Snapshot) {
    const result = [];
    for (const ws of this.store.list<Workspace>("workspace", workflow)) {
      const frozen = snapshot?.repositories.find(
        (r) => r.workspace_id === ws.id,
      );
      const base = frozen?.baseline ?? ws.baseline;
      const target = frozen ? [frozen.tree] : [];
      const pairs = (
        await git(ws.root, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--name-status",
          "-z",
          base,
          ...target,
          "--",
        ])
      )
        .split("\0")
        .filter(Boolean);
      const files: { path: string; status: string }[] = [];
      for (let i = 0; i < pairs.length; i += 2)
        files.push({ status: pairs[i]!, path: pairs[i + 1]! });
      if (!frozen)
        for (const path of (
          await git(ws.root, [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
          ])
        )
          .split("\0")
          .filter(Boolean))
          files.push({ path, status: "A" });
      result.push({
        repo_id: ws.repo_id,
        branch: await git(ws.root, ["symbolic-ref", "--short", "HEAD"]),
        baseline: base,
        frozen: !!frozen,
        owned: ws.owned,
        files,
      });
    }
    return result;
  }
  async fileDiff(
    workflow: string,
    repo: string,
    path: string,
    snapshot?: Snapshot,
  ) {
    const summary = (await this.changes(workflow, snapshot)).find(
      (r) => r.repo_id === repo,
    );
    requireCondition(
      summary && summary.files.some((f) => f.path === path),
      "DIFF_FILE_MISSING",
      "此文件不在当前变更清单中",
      404,
    );
    const ws = this.store
      .list<Workspace>("workspace", workflow)
      .find((w) => w.repo_id === repo)!;
    const frozen = snapshot?.repositories.find((r) => r.workspace_id === ws.id);
    let raw = await git(ws.root, [
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      summary.baseline,
      ...(frozen ? [frozen.tree] : []),
      "--",
      path,
    ]);
    if (!raw && !frozen) {
      const file = safePath(ws.root, path);
      if (lstatSync(file).size > 512000)
        return {
          path,
          branch: summary.branch,
          baseline: summary.baseline,
          diff: "文件过大，请在本地编辑器中查看。",
          truncated: true,
        };
      const content = readFileSync(file);
      raw = content.includes(0)
        ? "二进制文件，无法显示文本差异。"
        : content.length > 512000
          ? "文件过大，请在本地编辑器中查看。"
          : "新增文件：" +
            path +
            "\n" +
            content
              .toString("utf8")
              .split("\n")
              .map((l) => "+" + l)
              .join("\n");
    }
    return {
      path,
      branch: summary.branch,
      baseline: summary.baseline,
      diff: raw.slice(0, 512000),
      truncated: raw.length > 512000,
    };
  }
  async liveDiff(workflow: string) {
    const result = [];
    for (const ws of this.store.list<Workspace>("workspace", workflow)) {
      const raw = await git(ws.root, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--stat",
        "--patch",
        ws.baseline,
      ]);
      const paths = (
        await git(ws.root, ["diff", "--name-only", "-z", ws.baseline])
      )
        .split("\0")
        .filter(Boolean);
      const untracked = (
        await git(ws.root, ["ls-files", "--others", "--exclude-standard", "-z"])
      )
        .split("\0")
        .filter(Boolean);
      result.push({
        repo_id: ws.repo_id,
        paths: [...paths, ...untracked],
        diff: raw.slice(0, 512000),
        untracked_paths: untracked,
        truncated: raw.length > 512000,
      });
    }
    return result;
  }
  async diff(snapshot: Snapshot) {
    const output = [];
    for (const r of snapshot.repositories) {
      const ws = this.store.must<Workspace>("workspace", r.workspace_id);
      output.push({
        repo_id: r.repo_id,
        paths: r.changed_paths,
        diff: await git(ws.root, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--stat",
          "--patch",
          this.store.get<any>(
            "integration_candidate",
            snapshot.workflow_id + ":" + r.repo_id,
          )?.source_commit ?? r.baseline,
          r.tree,
        ]),
      });
    }
    return output;
  }
  async commit(snapshot: Snapshot, project: Project, message: string) {
    let identity = project.git;
    if (!identity) {
      const root = project.repositories[0]!.path;
      const name = await git(root, ["config", "user.name"]).catch(() => "");
      const email = await git(root, ["config", "user.email"]).catch(() => "");
      requireCondition(
        name && email,
        "GIT_IDENTITY_REQUIRED",
        "请为项目配置 Git 提交身份",
      );
      identity = {
        author_name: name,
        author_email: email,
        required_hooks: [],
      };
    }
    let intent = this.store.get<{
      snapshot: string;
      message: string;
      date: string;
      repos: Record<string, string>;
    }>("commit_intent", snapshot.workflow_id);
    if (!intent) {
      requireCondition(
        await this.matches(snapshot),
        "SNAPSHOT_CHANGED",
        "代码快照已变化",
      );
      intent = { snapshot: snapshot.id, message, date: now(), repos: {} };
      this.store.put(
        "commit_intent",
        snapshot.workflow_id,
        snapshot.workflow_id,
        intent,
      );
    }
    requireCondition(
      intent.snapshot === snapshot.id,
      "COMMIT_INTENT_CONFLICT",
      "提交意图绑定了其他快照",
    );
    requireCondition(
      await this.matches(snapshot),
      "SNAPSHOT_CHANGED",
      "提交前内容已变化",
    );
    const result = [];
    for (const r of snapshot.repositories) {
      const ws = this.store.must<Workspace>("workspace", r.workspace_id);
      const env = {
        GIT_AUTHOR_NAME: identity.author_name,
        GIT_AUTHOR_EMAIL: identity.author_email,
        GIT_COMMITTER_NAME: identity.author_name,
        GIT_COMMITTER_EMAIL: identity.author_email,
        GIT_AUTHOR_DATE: intent.date,
        GIT_COMMITTER_DATE: intent.date,
      };
      let commit = intent.repos[r.repo_id];
      if (!commit) {
        const args = ["commit-tree", r.tree, "-p", r.baseline];
        if (identity.signing_key) args.push("-S" + identity.signing_key);
        commit = await git(ws.root, args, env, intent.message + "\n");
        intent.repos[r.repo_id] = commit;
        this.store.put(
          "commit_intent",
          snapshot.workflow_id,
          snapshot.workflow_id,
          intent,
        );
      }
      const indexKey = snapshot.workflow_id + "-" + r.repo_id;
      let commitIndex = this.store.get<{ tree: string }>(
        "commit_index",
        indexKey,
      );
      if (!commitIndex) {
        let tree = r.tree;
        if (ws.initial_index_tree) {
          const index = join(this.storageRoot, "indices", id("commit-index"));
          mkdirSync(resolve(index, ".."), { recursive: true });
          const indexEnv = { GIT_INDEX_FILE: index };
          try {
            await git(ws.root, ["read-tree", ws.initial_index_tree], indexEnv);
            const patch = await git(ws.root, [
              "diff",
              "--binary",
              "--no-ext-diff",
              "--no-textconv",
              r.baseline,
              r.tree,
              "--",
            ]);
            if (patch)
              try {
                await git(
                  ws.root,
                  ["apply", "--cached", "--whitespace=nowarn", "-"],
                  indexEnv,
                  patch + "\n",
                );
              } catch {
                throw new FlowError(
                  "USER_INDEX_OVERLAP",
                  "任务补丁与用户暂存改动重叠；未修改分支和索引",
                );
              }
            tree = await git(ws.root, ["write-tree"], indexEnv);
          } finally {
            if (existsSync(index)) unlinkSync(index);
          }
        }
        commitIndex = { tree };
        this.store.put(
          "commit_index",
          indexKey,
          snapshot.workflow_id,
          commitIndex,
        );
      }
      const head = await git(ws.root, ["rev-parse", "refs/heads/" + r.branch]);
      if (head !== commit) {
        requireCondition(
          head === r.baseline,
          "COMMIT_BASE_CHANGED",
          "目标分支已经变化",
        );
        await git(ws.root, [
          "update-ref",
          "refs/heads/" + r.branch,
          commit,
          r.baseline,
        ]);
      }
      // A crash after update-ref can leave the old index. matches() above
      // accepts only the original or intended tree, so this repair is bounded.
      const currentIndex = await git(ws.root, ["write-tree"]);
      requireCondition(
        currentIndex ===
          (ws.initial_index_tree ??
            (await git(ws.root, ["rev-parse", r.baseline + "^{tree}"]))) ||
          currentIndex === commitIndex.tree,
        "INDEX_CHANGED",
        "提交过程中暂存区变化，保留现场",
      );
      await git(ws.root, ["read-tree", commitIndex.tree]);
      requireCondition(
        (await git(ws.root, ["rev-parse", commit + "^{tree}"])) === r.tree,
        "COMMIT_TREE_MISMATCH",
        "提交树不一致",
      );
      const record = {
        repo_id: r.repo_id,
        commit,
        tree: r.tree,
        parent: r.baseline,
      };
      this.store.put(
        "commit_result",
        snapshot.workflow_id + "-" + r.repo_id,
        snapshot.workflow_id,
        record,
      );
      result.push(record);
    }
    return result;
  }
}
