import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AcceptanceAccess } from "../../apps/web/src/workbench.js";

const detail = {
  workflow: { id: "wf-access", state: "HUMAN_PENDING" },
  project: { services: [{ id: "web", port_pool: "frontend" }, { id: "api", port_pool: "backend" }] },
  environment: { status: "ready", data_directory: "private-technical-path", services: [
    { id: "web", status: "ready", origin: "http://127.0.0.1:15321" },
    { id: "api", status: "ready", origin: "http://127.0.0.1:15322" },
  ] },
};
const render = (value: any) => renderToStaticMarkup(<AcceptanceAccess detail={value} onReleaseEnvironment={() => {}} onLockBrowser={() => {}} onReleaseBrowser={() => {}} />);

it("retains the real ready frontend acceptance URL and existing controls without technical page details", () => {
  const html = render(detail);
  expect(html).toContain('href="http://127.0.0.1:15321"');
  expect(html).not.toContain("15322");
  expect(html).toContain("释放环境");
  expect(html).toContain("占用人工核验浏览器");
  expect(html).toContain("释放人工核验浏览器");
  expect(html).not.toMatch(/本机验证副本|环境技术详情|private-technical-path|<pre/);
});
it.each(["starting", "failed", "stopped"])("does not advertise unavailable %s environments as acceptance links", status => {
  expect(render({ ...detail, environment: { ...detail.environment, status } })).not.toContain("href=");
});
it("does not expose a failed frontend, fabricated address, or an acceptance panel during development", () => {
  expect(render({ ...detail, environment: { status: "ready", services: [{ id: "web", status: "failed", origin: "http://127.0.0.1:15321" }] } })).not.toContain("href=");
  expect(render({ ...detail, environment: null })).not.toContain("href=");
  expect(render({ ...detail, workflow: { ...detail.workflow, state: "EXECUTING" } })).toBe("");
});
it("shows the native executor's acceptance address even without a platform-managed environment", () => {
  const html = render({ ...detail, environment: null, acceptance_handoff: {
    summary: "前后端已启动，请访问 [当前任务验收页面](http://127.0.0.1:16321)。验收后再关闭服务。",
  } });
  expect(html).toContain('href="http://127.0.0.1:16321"');
  expect(html).toContain("前后端已启动");
  expect(html).not.toContain("释放环境");
});
