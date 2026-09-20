/** Shared runtime causes and recovery instructions; safe to use in the browser. */
export interface RuntimeFailureResolution {
  code: string;
  title: string;
  message: string;
  steps: string[];
}

const resolutions: Record<string, Omit<RuntimeFailureResolution, "code">> = {
  CLI_VERSION_UNSUPPORTED: {
    title: "工具版本不兼容",
    message: "当前命令行工具版本不支持所选模型或启动参数，模型未能开始执行。",
    steps: [
      "在“工具与模型”中核对实际使用的 CLI 路径和模型；使用该路径执行 --version，避免检查到另一份安装。",
      "按该工具原有的安装方式升级 CLI；保留原模型、账号和任务工作区。",
      "确认升级后的同一路径可用，再继续原任务。",
    ],
  },
  CLI_NOT_FOUND: {
    title: "找不到执行工具",
    message: "配置的命令行工具不存在或无法通过当前路径找到，模型尚未启动。",
    steps: [
      "安装对应 CLI，或在“工具与模型”中修正可执行文件路径。",
      "使用配置中的路径执行 --version，确认可运行后继续原任务。",
    ],
  },
  CLI_CONFIG_INVALID: {
    title: "工具配置无效",
    message: "命令行工具无法读取或接受当前配置，执行尚未开始。",
    steps: [
      "根据本轮错误核对工具配置、模型和启动参数。",
      "修正配置并验证 CLI 可正常启动后继续原任务。",
    ],
  },
  MODEL_UNAVAILABLE: {
    title: "所选模型不可用",
    message: "当前账号或模型提供方无法提供所选模型。",
    steps: [
      "核对模型名称、提供方及当前账号的模型访问权限。",
      "恢复原模型的访问权限后继续；如需更换模型，先在“工具与模型”中明确修改配置。",
    ],
  },
  MODEL_AUTH: {
    title: "模型登录失效",
    message: "命令行工具的登录凭证无效或已过期，无法调用模型。",
    steps: [
      "使用运行任务的当前系统用户，在对应 CLI 中重新登录。",
      "确认同一 CLI 的登录状态正常后继续原任务，无需重新规划。",
    ],
  },
  MODEL_LOGIN_REQUIRED: {
    title: "模型需要重新登录",
    message: "当前模型账号的登录状态已失效，已保留任务现场。",
    steps: ["使用当前系统用户在对应工具中重新登录。", "重新验证该账号的模型访问后继续原任务。"],
  },
  MODEL_FORBIDDEN: {
    title: "当前账号无权使用模型",
    message: "提供方明确拒绝当前账号访问本轮模型，已保留任务现场。",
    steps: ["核对当前账号的模型访问权限。", "恢复权限并重新验证，或明确选择其他已验证模型后继续。"],
  },
  MODEL_QUOTA: {
    title: "模型额度或速率受限",
    message: "模型提供方暂时拒绝调用，原因是额度不足或请求速率受限。",
    steps: [
      "查看对应账号的额度及服务方返回的恢复时间。",
      "若页面已显示自动继续时间，等待恢复即可；否则恢复额度后继续原任务。",
    ],
  },
  MODEL_CONNECTION_FAILED: {
    title: "模型服务连接失败",
    message: "无法连接模型服务，或服务暂时不可用，本轮没有形成有效修复结果。",
    steps: [
      "检查当前 CLI 使用的服务地址、网络、代理和证书，以及服务方的运行状态。",
      "连接恢复后继续原任务；不要通过关闭证书校验或更换账号绕过问题。",
    ],
  },
  NATIVE_PERMISSION_DENIED: {
    title: "工具操作被拒绝",
    message: "原生工具拒绝了操作，已保留工作区和会话，等待处理权限。",
    steps: [
      "查看执行记录中被拒绝的具体操作和目标。",
      "仅为需要的操作调整对应 CLI 权限，或给出允许范围内的替代指导；确认后继续原任务。",
    ],
  },
  RUNTIME_ACCESS_DENIED: {
    title: "运行环境访问被拒绝",
    message: "当前系统用户无法访问执行所需的程序、目录或文件。",
    steps: [
      "根据错误中的目标路径检查访问权限、文件占用和安全软件拦截。",
      "恢复该目标的必要访问权限后继续，不需要修改业务代码或关闭全局防护。",
    ],
  },
  RUNTIME_PORT_BUSY: {
    title: "运行端口被占用",
    message: "测试服务需要的端口已被其他进程占用，无法启动。",
    steps: [
      "核对报错的端口及本任务的服务配置，选择配置允许的空闲测试端口。",
      "不要停止其他任务或生产服务；配置确认后继续原任务。",
    ],
  },
  DISK_FULL: {
    title: "磁盘空间不足",
    message: "运行环境无法继续写入文件，当前工作已保留。",
    steps: [
      "检查错误中目标磁盘的剩余空间，清理确认可删除的文件或调整存储位置。",
      "确认工作区和临时目录可写后继续原任务。",
    ],
  },
  HOST_REQUIRED: {
    title: "进程运行组件缺失",
    message: "DevFlow 的受管进程组件未安装或配置路径无效，无法启动工具。",
    steps: [
      "按 DevFlow 安装说明安装当前平台的进程组件，并核对配置路径。",
      "确认组件可用后继续原任务。",
    ],
  },
  UNAUTHORIZED: {
    title: "任务授权凭证失效",
    message: "DevFlow 未接受本轮任务凭证，工具操作没有获得授权。",
    steps: [
      "核对 CLI 连接的 DevFlow 地址是否属于当前运行的实例。",
      "使用原任务的恢复入口重新获取本轮授权；不要复制旧轮次令牌或绕过权限检查。",
    ],
  },
  POLICY_FAILED: {
    title: "操作授权检查失败",
    message: "工具无法完成 DevFlow 授权检查，尚未执行请求的操作。",
    steps: [
      "检查 CLI 到 DevFlow 的连接及授权检查日志。",
      "恢复连接或修正授权配置后继续原任务，不需要修改业务代码。",
    ],
  },
  AUTHORIZATION_ROUTING_REQUIRED: {
    title: "操作需要工作台授权",
    message: "请求的操作尚未通过工作台授权，执行模型需要先提交具体操作申请。",
    steps: [
      "让执行模型通过 devflow_request_operation 提交操作、目标路径及影响范围。",
      "在工作台批准或拒绝该操作，再由原任务处理决定；不要改用其他工具绕过。",
    ],
  },
  MCP_AUTH_REQUIRED: {
    title: "工具连接需要认证",
    message: "CLI 的外部工具连接认证失败，当前运行无法使用该连接。",
    steps: [
      "在 CLI 的工具连接配置中找到报错的 MCP 服务，核对地址和认证状态。",
      "恢复该连接的认证后继续原任务。",
    ],
  },
  TIMEOUT: {
    title: "运行达到时限",
    message:
      "本轮达到执行或等待时限，现有修改与日志已保留，尚不能据此判定代码修复失败。",
    steps: [
      "查看最后一条执行记录，确认工具是在等待网络、授权、长时间命令还是模型响应。",
      "处理对应阻塞，必要时调整该步骤的时限，再继续原任务。",
    ],
  },
  NATIVE_RUN_FAILED: {
    title: "工具运行异常，原因待确认",
    message: "命令行工具未正常完成，当前证据不足以判定模型修改失败。",
    steps: [
      "查看本轮执行记录中的第一条错误、退出码及实际 CLI 路径。",
      "先确认工具可启动、登录有效且模型可访问；处理具体原因后继续原任务。",
    ],
  },
  EXECUTION_FAILED: {
    title: "工具运行异常，原因待确认",
    message:
      "执行工具未给出有效结果，需要先核对运行错误，尚不能判定模型修改失败。",
    steps: [
      "查看本轮第一条错误、退出码、工具路径及登录状态。",
      "处理已确认的运行问题后继续；原因不明时保留日志供排查，不重复消耗模型整改次数。",
    ],
  },
  INTERNAL_FAILURE: {
    title: "平台运行异常",
    message: "DevFlow 在运行过程中发生未分类异常，不能据此判定模型修改失败。",
    steps: [
      "查看本轮原始错误及平台日志，核对配置、工具入口和运行环境。",
      "处理确认的原因后继续原任务；现有计划与工作区保留。",
    ],
  },
};

/** Only classify actual runtime failures, never quoted errors in a delivery/review. */
export function runtimeFailureResolution(
  code = "",
  detail = "",
): RuntimeFailureResolution | undefined {
  // CLI errors often embed an API error as an escaped JSON string.
  detail = detail.replace(/\\+"/g, '"');
  let cause = code;
  const inspect =
    !code ||
    [
      "NATIVE_RUN_FAILED",
      "EXECUTION_FAILED",
      "INTERNAL_FAILURE",
      "BUILD_FAILED",
      "SERVICE_START_FAILED",
      "ENVIRONMENT_FAILED",
    ].includes(code);
  if (inspect) {
    if (
      /requires a newer version of|please upgrade (?:to )?(?:the latest )?(?:app|cli)|unsupported (?:cli |client )?version|unknown (?:option|argument)|unrecognized (?:option|argument)|unexpected argument .*found/i.test(
        detail,
      )
    )
      cause = "CLI_VERSION_UNSUPPORTED";
    else if (
      /找不到适配器 .*指定可执行文件|spawn\s+[^\r\n]*\bENOENT\b|(?:command|executable) not found|不是内部或外部命令/i.test(
        detail,
      )
    )
      cause = "CLI_NOT_FOUND";
    else if (
      /failed to (?:load|parse) (?:the )?config|error (?:loading|parsing) config|invalid (?:toml|configuration)|不支持的工具配置项|未实现 providerConfigRef/i.test(
        detail,
      )
    )
      cause = "CLI_CONFIG_INVALID";
    else if (
      /model_not_found|model .* (?:does not exist|is not available|not supported)|do not have access to (?:the )?model/i.test(
        detail,
      )
    )
      cause = "MODEL_UNAVAILABLE";
    else if (
      /AuthRequired(?:Error)?|MCP.*(?:authentication|认证).*(?:failed|失败)/i.test(
        detail,
      )
    )
      cause = "MCP_AUTH_REQUIRED";
    else if (
      /\bunauthenticated\b|\bunauthorized\b|\bmodel_auth\b|invalid_api_key|(?:access|refresh|auth(?:entication)?) token .*expired|please (?:run .*login|log in|login)|登录(?:状态)?(?:失效|过期)|"status"\s*:\s*401\b/i.test(
        detail,
      )
    )
      cause = "MODEL_AUTH";
    else if (
      /\b429\b|\bquota\b|rate.?limit|额度(?:不足|用完)|配额(?:不足|耗尽)/i.test(
        detail,
      )
    )
      cause = "MODEL_QUOTA";
    else if (
      /\bENOSPC\b|disk (?:is )?full|no space left on device|磁盘空间不足/i.test(
        detail,
      )
    )
      cause = "DISK_FULL";
    else if (
      /\bEADDRINUSE\b|address already in use|端口.*已被占用/i.test(detail)
    )
      cause = "RUNTIME_PORT_BUSY";
    else if (
      /\bEACCES\b|\bEPERM\b|access (?:is )?denied|permission denied|拒绝访问/i.test(
        detail,
      )
    )
      cause = "RUNTIME_ACCESS_DENIED";
    else if (
      /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b|certificate verify failed|error sending request|fetch failed|failed to (?:connect|fetch)|"status"\s*:\s*50[0234]\b|\bHTTP\s+50[0234]\b|bad record mac|local error:\s*tls:|streamGenerateContent.*(?:request failed|bad record mac)/i.test(
        detail,
      )
    )
      cause = "MODEL_CONNECTION_FAILED";
    else if (/\b(?:timeout|timed out)\b|超时/i.test(detail)) cause = "TIMEOUT";
  }
  const value = resolutions[cause];
  return value ? { code: cause, ...value } : undefined;
}
