import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "../../core/src/engine.js";
import { requireCondition } from "../../contracts/src/index.js";
import { atomicWrite, hash, id, now, objectHash } from "../../core/src/util.js";
import {
  BrowserRecipeSchema,
  assertResult,
  pointer,
  template,
  toolData,
} from "./recipe.js";
export type { BrowserAction } from "./recipe.js";
// Recipes can interact only with tabs created by this run, on its approved origins.
const tabTools = new Set([
  "browser_get_tab_info",
  "browser_navigate_tab",
  "browser_get_tab_content",
  "browser_get_page_html",
  "browser_click_element",
  "browser_type_text",
  "browser_select_option",
  "browser_wait_for_element",
  "browser_query_elements",
  "browser_screenshot_tab",
  "browser_get_console_logs",
  "browser_close_tab",
]);
export class BrowserGateway {
  private active = new Map<
    string,
    { client?: Client; cancelled: boolean; completion: Promise<void> }
  >();
  constructor(private engine: Engine) {}
  async connect() {
    const config = this.engine.config.opentabs;
    const client = new Client({
      name: "devflow-browser-gateway",
      version: "0.1.0",
    });
    let token = config.secret_file
      ? readFileSync(config.secret_file, "utf8").trim()
      : undefined;
    if (token?.startsWith("{")) token = JSON.parse(token).secret;
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(config.endpoint), {
          requestInit: {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          },
        }),
      );
      return client;
    } catch (e) {
      await client.close();
      throw e;
    }
  }
  async discover() {
    const client = await this.connect();
    try {
      const tools = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools({ cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return { tools };
    } finally {
      await client.close();
    }
  }
  async reconcile(workflow: string) {
    const w = this.engine.get(workflow);
    requireCondition(
      ["RECOVERY_REQUIRED", "STOPPED", "BLOCKED", "COMMIT_PARTIAL"].includes(
        w.state,
      ),
      "INVALID_STATE",
      "当前不能恢复浏览器",
    );
    const lease = this.engine.store.get<{ owner: string; run_id: string }>(
      "lease",
      "browser:shared",
    );
    if (!lease || lease.owner !== workflow) return;
    const session = this.engine.store.get<{
      tabs: number[];
      origins: string[];
    }>("browser_session", lease.run_id);
    requireCondition(
      session,
      "BROWSER_RECONCILIATION_REQUIRED",
      "缺少测试标签页记录，请由人工释放浏览器接管锁",
    );
    const client = await this.connect();
    try {
      for (const tabId of session.tabs) {
        const result = await client.callTool(
          { name: "browser_get_tab_info", arguments: { tabId } },
          { timeout: 10000 },
        );
        if (result.isError) {
          const text = JSON.stringify(result);
          requireCondition(
            /no tab|not found|does not exist|不存在/i.test(text),
            "BROWSER_RECONCILIATION_FAILED",
            "无法确认测试标签页是否已关闭",
          );
          continue;
        }
        const info = toolData(result);
        requireCondition(
          session.origins.includes(new URL(info.url).origin),
          "BROWSER_ORIGIN_DENIED",
          "旧标签页已离开测试环境，需要人工检查",
        );
        const closed = await client.callTool(
          { name: "browser_close_tab", arguments: { tabId } },
          { timeout: 10000 },
        );
        requireCondition(
          !closed.isError,
          "BROWSER_RECONCILIATION_FAILED",
          "测试标签页关闭失败",
        );
      }
      this.engine.store.put("browser_session", lease.run_id, workflow, {
        ...session,
        tabs: [],
        status: "closed",
      });
      this.engine.scheduler.release(
        workflow,
        lease.run_id,
        ["browser:shared"],
        true,
      );
    } finally {
      await client.close();
    }
  }
  async stop(run: string) {
    const active = this.active.get(run);
    if (active) {
      active.cancelled = true;
      await active.completion;
    }
  }
  async run(workflow: string, run: string, sceneId: string) {
    const w = this.engine.get(workflow),
      project = this.engine.project(w.project_id),
      scene = project.browser_scenes.find((s) => s.id === sceneId);
    requireCondition(scene, "SCENE_MISSING", "浏览器场景不存在");
    const stored = this.engine.store.get<Record<string, unknown>>(
      "browser_recipe",
      `${w.project_id}-${sceneId}`,
    );
    requireCondition(
      stored && stored.project_hash === objectHash(project),
      "SCENE_NOT_CALIBRATED",
      "请登记与当前项目配置匹配的固定浏览器场景",
    );
    const { project_hash, ...input } = stored;
    const recipe = BrowserRecipeSchema.parse(input);
    requireCondition(!project.browser_recipe_hashes || project.browser_recipe_hashes[sceneId] === objectHash(recipe),
      "SCENE_CHANGED", "浏览器动作已变化，需要重新规划并批准");
    const env = this.engine.store.must<{
      services: { id: string; origin: string }[];
    }>("environment", workflow);
    const vars: Record<string, unknown> = {
      DEVFLOW_WORKFLOW_ID: workflow,
      DEVFLOW_BASE_URL: env.services.at(-1)?.origin,
    };
    for (const service of env.services)
      vars[
        `DEVFLOW_${service.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_ORIGIN`
      ] = service.origin;
    const allowed = new Set([
      ...env.services.map((s) => s.origin),
      ...this.engine.config.opentabs.allowed_test_origins,
    ]);
    const origins = recipe.origins.map((o) => String(template(o, vars)));
    requireCondition(
      origins.every((origin) => {
        const url = new URL(origin);
        return !(
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
          Number(url.port || 80) === this.engine.config.server.port
        );
      }),
      "CONTROLLER_ORIGIN_DENIED",
      "业务浏览器场景不能进入控制器人工审批入口",
    );
    requireCondition(
      origins.every((o) => allowed.has(o)),
      "BROWSER_ORIGIN_DENIED",
      "场景目标与当前环境不匹配",
    );
    const assertUrl = (url: unknown) => {
      requireCondition(
        typeof url === "string" && origins.includes(new URL(url).origin),
        "BROWSER_ORIGIN_DENIED",
        "标签页离开批准的测试源",
      );
    };
    requireCondition(
      !this.active.has(run) &&
        this.engine.scheduler.acquire(workflow, run, ["browser:shared"]),
      "BROWSER_BUSY",
      "共享浏览器正被占用",
    );
    let complete!: () => void;
    const active: {
      client?: Client;
      cancelled: boolean;
      completion: Promise<void>;
    } = {
      cancelled: false,
      completion: new Promise<void>((r) => (complete = r)),
    };
    this.active.set(run, active);
    const persistTabs = (tabs: Set<number>, status = "running") =>
      this.engine.store.put("browser_session", run, workflow, {
        tabs: [...tabs],
        origins,
        status,
      });
    const transcript: unknown[] = [],
      cases = new Set<string>(),
      tabs = new Set<number>();
    let failed: unknown;
    const path = join(
      this.engine.config.storage_root,
      "evidence",
      workflow,
      id("browser") + ".json",
    );
    try {
      const client = await this.connect();
      active.client = client;
      const available = (await client.listTools()).tools;
      const call = async (name: string, args: Record<string, unknown>) => {
        requireCondition(!active.cancelled, "RUN_REVOKED", "浏览器验收已停止");
        const current = this.engine.get(workflow);
        requireCondition(
          current.run_id === run &&
            ["EXECUTING", "VERIFYING"].includes(current.state),
          "RUN_REVOKED",
          "执行轮次已经结束",
        );
        const result = await client.callTool(
          { name, arguments: args },
          { timeout: 30000 },
        );
        transcript.push({ tool: name, arguments: args, result, time: now() });
        requireCondition(
          !result.isError,
          "BROWSER_TOOL_FAILED",
          "OpenTabs 返回失败",
        );
        return toolData(result);
      };
      for (const action of recipe.actions) {
        requireCondition(
          scene.allowed_tools.includes(action.tool) &&
            available.some((t) => t.name === action.tool) &&
            (action.tool === "browser_open_tab" || tabTools.has(action.tool)),
          "BROWSER_TOOL_DENIED",
          "场景工具不在可执行列表中",
        );
        const args = template(action.arguments, vars) as Record<
          string,
          unknown
        >;
        requireCondition(
          !("filePath" in args),
          "BROWSER_FILE_PATH_DENIED",
          "截图只能作为控制器证据保存",
        );
        if (
          action.tool === "browser_open_tab" ||
          action.tool === "browser_navigate_tab"
        )
          assertUrl(args.url);
        if (action.tool !== "browser_open_tab") {
          requireCondition(
            typeof args.tabId === "number" && tabs.has(args.tabId),
            "BROWSER_TAB_DENIED",
            "只能操作本轮新建的测试标签页",
          );
          let info = await call("browser_get_tab_info", { tabId: args.tabId });
          // A newly created Chrome tab can briefly report an empty URL while navigating.
          const deadline = Date.now() + 5000;
          while (
            (!info.url || info.url === "about:blank") &&
            Date.now() < deadline
          ) {
            await new Promise((r) => setTimeout(r, 100));
            info = await call("browser_get_tab_info", { tabId: args.tabId });
          }
          assertUrl(info.url);
        }
        const data = await call(action.tool, args);
        if (action.tool === "browser_open_tab") {
          const tab = data.id ?? data.tabId;
          requireCondition(
            Number.isSafeInteger(tab),
            "BROWSER_TAB_MISSING",
            "OpenTabs 没有返回标签页编号",
          );
          tabs.add(tab);
          persistTabs(tabs);
        }
        if (action.tool === "browser_close_tab") {
          tabs.delete(args.tabId as number);
          persistTabs(tabs);
        }
        for (const c of assertResult(data, action.assertions, vars))
          cases.add(c);
        for (const [name, source] of Object.entries(action.capture)) {
          requireCondition(
            !Object.hasOwn(vars, name),
            "VARIABLE_OVERWRITE",
            "捕获变量不能覆盖已有环境",
          );
          vars[name] = pointer(data, source);
          requireCondition(
            vars[name] !== undefined,
            "CAPTURE_MISSING",
            "结果缺少捕获值",
          );
        }
      }
      requireCondition(
        cases.size > 0,
        "BROWSER_CASES_MISSING",
        "没有实际执行的测试用例断言",
      );
    } catch (e) {
      failed = e;
    } finally {
      // Wait for the current bounded operation before releasing the shared browser.
      // Close only tabs created here. A cleanup failure keeps the lease suspect.
      let cleaned = true;
      for (const tabId of tabs)
        try {
          const closed = await active.client?.callTool(
            { name: "browser_close_tab", arguments: { tabId } },
            { timeout: 10000 },
          );
          requireCondition(
            closed && !closed.isError,
            "BROWSER_CLEANUP_FAILED",
            "标签页关闭失败",
          );
        } catch {
          cleaned = false;
        }
      await active.client?.close();
      atomicWrite(
        path,
        JSON.stringify(
          {
            workflow,
            run,
            scene_id: sceneId,
            status: failed ? "failed" : "passed",
            cases: [...cases],
            transcript,
          },
          null,
          2,
        ),
      );
      if (cleaned)
        this.engine.scheduler.release(workflow, run, ["browser:shared"], true);
      else {
        const lease = this.engine.store.must<any>("lease", "browser:shared");
        this.engine.store.put("lease", lease.id, workflow, {
          ...lease,
          status: "suspect",
        });
        failed ??= new Error("浏览器标签页清理失败，租约保留等待核实");
      }
      persistTabs(cleaned ? new Set() : tabs, cleaned ? "closed" : "suspect");
      this.active.delete(run);
      complete();
    }
    if (failed) throw failed;
    return {
      path,
      hash: hash(readFileSync(path)),
      steps: transcript.length,
      case_ids: [...cases],
    };
  }
}
