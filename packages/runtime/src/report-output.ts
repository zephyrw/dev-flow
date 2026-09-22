import { existsSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Engine } from "../../core/src/engine.js";
import type { Evidence, Workspace } from "../../contracts/src/index.js";
import { hash, atomicWrite } from "../../core/src/util.js";
import { safePath } from "../../workspace/src/files.js";
import { git } from "../../git/src/git.js";

/** A registered report is temporary output, not a source edit. Preserve any
 * pre-existing file and archive the newly generated report before restoring. */
export function takeReportSlot(path: string) {
  const directory = dirname(path);
  const preservePaths = new Set(
    existsSync(directory)
      ? readdirSync(directory).map((name) => join(directory, name))
      : [],
  );
  const prior = existsSync(path) ? readFileSync(path) : undefined;
  if (prior !== undefined) unlinkSync(path);
  let restored = false;
  return Object.assign(
    () => {
      if (restored) return;
      restored = true;
      if (prior !== undefined) atomicWrite(path, prior);
      else if (existsSync(path)) unlinkSync(path);
    },
    { preservePaths },
  );
}

/** Repair outputs left by older runners only when an immutable archived report
 * proves ownership. Tracked or modified files never qualify. */
export async function cleanArchivedReports(
  engine: Engine,
  workflow: string,
  current: {
    files?: Evidence["files"];
    preservePaths?: Set<string>;
    directory?: string;
  } = {},
) {
  const w = engine.get(workflow),
    project = engine.project(w.project_id);
  const workspaces = engine.store.list<Workspace>("workspace", workflow);
  const evidence = [
    ...engine.store.list<Evidence>("evidence", workflow),
    ...engine.store.list<Evidence>("development_evidence", workflow),
  ];
  const candidates = new Map<string, { root: string; relative: string }>();
  for (const command of project.commands) {
    if (!command.report_path) continue;
    const ws = command.repo_id
      ? workspaces.find((x) => x.repo_id === command.repo_id)
      : (project.primary_repo_id
          ? workspaces.find((x) => x.repo_id === project.primary_repo_id)
          : workspaces.find((x: any) => x.is_primary || x.primary || x.repo_id === "main" || x.repo_id === "primary") || workspaces[0]);
    if (!ws) continue;
    const reports = [command.report_path];
    const directory = dirname(command.report_path);
    // Command registrations may change report names. Check siblings in the
    // dedicated report directory, never arbitrary workspace files or subtrees.
    if (directory !== ".") {
      const reportDirectory = safePath(ws.root, directory, true);
      if (existsSync(reportDirectory))
        reports.push(
          ...readdirSync(reportDirectory, { withFileTypes: true })
            .filter(
              (entry) => entry.isFile() && /\.(?:json|xml)$/i.test(entry.name),
            )
            .map((entry) => join(directory, entry.name).replaceAll("\\", "/")),
        );
    }
    for (const relative of reports)
      candidates.set(safePath(ws.root, relative, true), {
        root: ws.root,
        relative,
      });
  }
  for (const [path, candidate] of candidates) {
    if (
      current.preservePaths?.has(path) ||
      (current.directory && dirname(path) !== current.directory)
    )
      continue;
    if (!existsSync(path)) continue;
    const digest = hash(readFileSync(path));
    const archive = evidence
      .flatMap((e) => e.files)
      .concat(current.files ?? [])
      .find(
        (f) =>
          /(?:report\.(?:json|xml)|unparsed-report\.txt)$/.test(f.path) &&
          f.hash === digest &&
          existsSync(f.path) &&
          hash(readFileSync(f.path)) === digest,
      );
    if (
      !archive ||
      (await git(candidate.root, ["ls-files", "--", candidate.relative]))
    )
      continue;
    if (hash(readFileSync(path)) !== digest) continue;
    unlinkSync(path);
    engine.store.event(workflow, w.project_id, "ReportOutputArchived", {
      path: candidate.relative,
      archive: archive.path,
      message: "已归档的测试报告已移出源码工作区。",
    });
  }
}
