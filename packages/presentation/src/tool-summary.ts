/** Summaries use named tool fields, never arbitrary prompt/code payloads. */
export function toolSummary(name: string | undefined, args: any) {
  const first = (...values: unknown[]) =>
    values.find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const path = first(
    args.TargetFile,
    args.AbsolutePath,
    args.FilePath,
    args.path,
    args.file_path,
  );
  const command = first(args.CommandLine, args.command, args.cmd);
  const cwd = first(args.Cwd, args.cwd, args.working_directory);
  if (
    path &&
    /(?:^|[/\\])(?:handoff\.json|HANDOFF\.md)$/i.test(path) &&
    ["view_file", "sed_file", "devflow_read_file"].includes(name ?? "")
  )
    return {
      title: "读取任务说明",
      text: "读取本轮任务要求和已有进度",
      command,
      cwd,
    };
  const query = first(
    args.Query,
    args.SearchPattern,
    args.Pattern,
    args.query,
    args.pattern,
  );
  const directory = first(
    args.SearchDirectory,
    args.DirectoryPath,
    args.directory,
  );
  const names: Record<string, string> = {
    run_command: "执行命令",
    command_status: "查看命令结果",
    send_command_input: "向命令输入",
    view_file: "读取文件",
    write_to_file: "写入文件",
    replace_file_content: "修改文件",
    multi_replace_file_content: "修改文件",
    sed_file: "读取文件片段",
    list_dir: "查看目录",
    grep_search: "搜索源码",
    find_by_name: "查找文件",
    manage_task: "查看后台任务",
    open_browser_url: "打开网页",
    read_browser_page: "读取网页",
    read_url_content: "读取网页",
    devflow_environment: "准备验证环境",
    devflow_deliver: "提交交付核验",
    devflow_review_read_file: "读取文件",
    devflow_review_context: "读取审查材料",
    devflow_review_search: "搜索源码",
    devflow_review_evidence: "读取测试证据",
    devflow_review_hash_document: "核对文档哈希",
  };
  const target = first(
    path,
    directory,
    args.Url,
    args.URL,
    args.url,
    args.test_id,
    args.task_id,
    args.TaskId,
    args.CommandId,
    args.section,
  );
  const internalSearch =
    !!query && /(?:tool_name|step_type|step_update|event_seq)/.test(query);
  const text = internalSearch
    ? ""
    : command
      ? command + (cwd ? `\n工作目录：${cwd}` : "")
      : query
        ? `${query}${target ? ` · ${target}` : ""}`
        : (target ?? "");
  return { title: name ? names[name] : undefined, text, command, cwd };
}

export function toolOutputSummary(output: unknown, name?: string) {
  if (typeof output !== "string" || !output.trim()) return "";
  // Never display arbitrary stdout, source snippets, JSON or stack traces.
  // Reading a file containing error/test text is not an execution result.
  if (
    !name ||
    ![
      "run_command",
      "terminal",
      "exec",
      "command_status",
      "manage_task",
    ].includes(name)
  )
    return "";
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const summary = [...text.matchAll(/^\s*Tests\s+(.+)$/gm)].at(-1)?.[1];
  if (summary && /\d+\s+(?:passed|failed|skipped)/.test(summary)) {
    const count = (s: string) =>
      Number(summary.match(new RegExp(`(\\d+)\\s+${s}\\b`))?.[1] ?? 0);
    return `测试输出：${count("passed")} 项通过，${count("failed")} 项失败，${count("skipped")} 项跳过。`;
  }
  if (/(?:invalid|illegal) character.*(?:BOM|FEFF)/i.test(text))
    return "编译遇到文件编码问题，需要修正后重试。";
  if (/SyntaxError:|Unexpected token|Expected .*but found/i.test(text))
    return "命令或代码存在语法错误，操作未完成。";
  if (
    /Cannot find module|Failed to resolve import|ModuleNotFoundError/i.test(
      text,
    )
  )
    return "找不到所需的代码模块或依赖，操作未完成。";
  if (/EADDRINUSE|address already in use/i.test(text))
    return "所需端口已被占用，服务未能启动。";
  if (/ECONNREFUSED|connection refused/i.test(text))
    return "无法连接所需服务，需要检查服务是否已启动。";
  if (/BUILD FAILURE/.test(text)) return "构建或测试未通过，需要修复后重试。";
  if (/BUILD SUCCESS/.test(text)) return "本次构建已通过。";
  return "";
}
