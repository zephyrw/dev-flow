import { test, expect } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createNative,
  fixtureState,
  openExecutionSidebar,
  setNativeFixture,
  waitForSubagents,
  waitForWorkflowState,
  workCard,
  workCardRow,
} from "./native-helper.js";

test.describe.configure({ mode: "serial" });

function sidecarCandidates(fileName: string) {
  const state = fixtureState();
  const files = [join(state.nativeRepo, fileName)];
  const runDir = state.runDir || dirname(state.stateFile);
  const worktrees = join(runDir, "worktrees");
  if (!existsSync(worktrees)) return files;
  for (const name of readdirSync(worktrees)) {
    files.push(join(worktrees, name, fileName));
  }
  return files;
}

function pidsFileCandidates() {
  return sidecarCandidates(".devflow-fixture-pids.json");
}

function lastPromptText() {
  const filePath = sidecarCandidates(".devflow-fixture-last-prompt.txt").find(
    (path) => existsSync(path),
  );
  return filePath ? readFileSync(filePath, "utf8") : "";
}

function clearLastPrompts() {
  for (const filePath of sidecarCandidates(".devflow-fixture-last-prompt.txt")) {
    if (existsSync(filePath)) unlinkSync(filePath);
  }
}

function heldPids() {
  const filePath = pidsFileCandidates().find((path) => existsSync(path));
  if (!filePath) return { parent: 0, children: [] as number[] };
  return JSON.parse(readFileSync(filePath, "utf8")) as {
    parent: number;
    children: number[];
  };
}

function pidAlive(pid: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function anyHeldPidAlive() {
  const pids = heldPids();
  return pidAlive(pids.parent) || pids.children.some(pidAlive);
}

test("SA-E11 pause all stops fixture processes and resume restores unfinished work", async ({
  page,
}) => {
  test.setTimeout(120000);
  await setNativeFixture(page, { mixed: true, hold_ms: 25000 });
  const id = await createNative(
    page,
    "E11 暂停全部并继续",
    "new_worktree",
    false,
  );
  await openExecutionSidebar(page);
  await waitForSubagents(page, id, 3);
  await expect.poll(anyHeldPidAlive, { timeout: 20_000 }).toBe(true);
  const before = heldPids();
  await workCard(page).getByRole("button", { name: "暂停当前主工作会话及全部子 Agent" }).click();
  await expect(page.locator(".conversation-view-notice, .attention-strip")).toContainText(
    /暂停/,
    { timeout: 20000 },
  );
  await expect
    .poll(() => heldPids().children.some(pidAlive), { timeout: 20000 })
    .toBe(false);
  const tree = await (
    await page.request.get(`/api/workflows/${id}/conversations`)
  ).json();
  const live = (tree.attempts ?? []).filter((attempt: { status: string }) =>
    ["running", "starting", "waiting", "pausing"].includes(attempt.status),
  );
  expect(live.length).toBeGreaterThanOrEqual(0);
  await expect(workCard(page)).toContainText(/暂停|已暂停|失败/);
  await setNativeFixture(page, {});
  await page.getByRole("button", { name: /继续这个任务|立即重试/ }).click();
  await expect
    .poll(async () => {
      const detail = await (await page.request.get(`/api/workflows/${id}`)).json();
      return detail.workflow.state;
    }, { timeout: 45000 })
    .not.toBe("STOPPED");
});

test("SA-E12 child-view pause is scoped; another task keeps working", async ({
  page,
}) => {
  test.setTimeout(180000);
  await setNativeFixture(page, { nested: true, hold_ms: 25000, detach_children: true });
  const first = await createNative(
    page,
    "E12 被暂停的任务",
    "new_worktree",
    false,
  );
  await openExecutionSidebar(page);
  await waitForSubagents(page, first, 1);
  await setNativeFixture(page, { nested: true, hold_ms: 20000 });
  const second = await createNative(
    page,
    "E12 仍应继续的任务",
    "new_worktree",
    false,
  );
  await page.goto(`/?workflow=${first}`);
  await openExecutionSidebar(page);
  const tree = await (
    await page.request.get(`/api/workflows/${first}/conversations`)
  ).json();
  const child = (tree.nodes ?? []).find(
    (node: { kind?: string }) => node.kind === "subagent",
  );
  await workCardRow(page, child.title).click();
  await expect(page.locator(".execution-sidebar")).toHaveAttribute(
    "data-child-view",
    "true",
  );
  await page
    .getByRole("button", { name: "暂停当前主工作会话及全部子 Agent" })
    .click();
  await expect(
    page.locator(".conversation-view-notice, .attention-strip"),
  ).toContainText(/暂停|待确认/, {
    timeout: 20000,
  });
  const paused = await (
    await page.request.get(`/api/workflows/${first}`)
  ).json();
  expect(["STOPPING", "STOPPED", "BLOCKED", "PLANNING"].includes(paused.workflow.state)).toBe(
    true,
  );
  const other = await (
    await page.request.get(`/api/workflows/${second}`)
  ).json();
  expect(other.workflow.state).not.toBe("STOPPED");
  await page.goto(`/?workflow=${second}`);
  await openExecutionSidebar(page);
  await expect(workCard(page)).toBeVisible();
});

test("SA-E13 quota interrupt injects recovery prompt and manual pause cancels retry", async ({
  page,
}) => {
  test.setTimeout(300000);
  await setNativeFixture(page, { nested: true, quota: true, hold_ms: 3000 });
  const id = await createNative(
    page,
    "E13 额度中断恢复",
    "new_worktree",
    false,
  );
  await openExecutionSidebar(page);
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    /额度|暂停|阻塞|排队|需要处理/,
    { timeout: 90000 },
  );
  await setNativeFixture(page, { nested: true, hold_ms: 8000, quota: false });
  clearLastPrompts();
  const resume = page
    .getByRole("button", {
      name: /立即重试|继续这个任务|已处理，继续原任务/,
    })
    .first();
  await expect(resume).toBeVisible({ timeout: 30000 });
  const recovered = page.waitForResponse(
    (response) =>
      response.url().includes("/recover") &&
      response.request().method() === "POST",
    { timeout: 60000 },
  );
  await resume.click();
  expect((await recovered).ok()).toBe(true);
  await expect
    .poll(lastPromptText, { timeout: 45000 })
    .toMatch(/原任务的继续|恢复清单|不要重跑/);
  await expect(page.locator("body")).toContainText(/恢复|等待|已安排/);
  const pauseAuto = page.getByRole("button", {
    name: "暂停自动继续",
    exact: true,
  });
  const pauseAll = workCard(page).getByRole("button", {
    name: "暂停当前主工作会话及全部子 Agent",
  });
  await expect(pauseAuto.or(pauseAll).first()).toBeVisible({ timeout: 30000 });
  await pauseAuto.or(pauseAll).first().click();
  const afterPause = await (
    await page.request.get(`/api/workflows/${id}`)
  ).json();
  expect(["STOPPED", "STOPPING"].includes(afterPause.workflow.state)).toBe(true);
  await page.waitForTimeout(4000);
  const later = await (await page.request.get(`/api/workflows/${id}`)).json();
  expect(["STOPPED", "STOPPING"].includes(later.workflow.state)).toBe(true);
});
