# 通用人机交互规范 (user_interaction)

> 本规范指导执行模型在需要用户人工介入时（如完成受保护的浏览器登录、扫码、或确认业务不确定问题），如何通过 `need_user` 发起标准的人机交互请求，以及用户确认后的续接行为。

---

## 1. 触发场景与交互类型

模型输出结束当前轮次时，返回 `status: "need_user"`，并在输出中提供结构化的 `user_interaction` 字段。统一支持两种类型：

1. **`action_required`（操作请求）**：
   - 场景：需要用户在真实浏览器、控制台或外部客户端完成特定人工操作（如输入密码、扫码、完成 MFA 认证、切换租户等）。
   - 用户完成操作后，点击弹窗主按钮（如“我已完成，继续”）向系统反馈。
2. **`question`（业务问题）**：
   - 场景：需求或已有计划存在业务行为不明确的歧义（非普通代码实现细节），必须由用户决策。
   - 包含明确的问题、不超过 8 个预设选项，并可选择是否允许自由文本输入。

---

## 2. 请求字段结构与示例

### 2.1 数据结构

```typescript
interface UserInteractionInput {
  kind: "action_required" | "question";
  title: string;               // 1..120 字符，精炼的标题
  message: string;             // 1..4000 字符，清楚说明为什么需要用户帮助
  action_label?: string;       // action_required 的操作按钮文案（如“我已完成，继续”，最长 40 字符）
  question?: string;           // question 类型的明确问题
  choices?: Array<{ id: string; label: string }>; // 选项列表，最多 8 项，ID 唯一
  allow_free_text?: boolean;   // 是否允许用户补充文本输入
  target?: {
    url?: string;              // 目标页面安全 URL（只保留安全 http/https，去除 token/密钥/临时凭证）
    tab_id?: number;           // 浏览器标签页 ID
    connection_hint?: string;  // 非敏感的浏览器或客户端定位提示
  };
  resume_note?: string;        // 恢复指引：供模型恢复时知晓当前的停留位置和下一步目标（最长 4000 字符）
}
```

### 2.2 输出示例

#### 操作请求（action_required）
```json
{
  "status": "need_user",
  "summary": "受保护的管理页面需要企业 SSO 登录，其余公开页面验证已完成。",
  "user_interaction": {
    "kind": "action_required",
    "title": "请在浏览器中完成登录",
    "message": "请在刚才打开的测试标签页中完成企业账号登录。不要把账号密码或验证码直接粘贴在此对话中。登录成功后请点击确认，我将复查页面并继续剩余业务链路。",
    "action_label": "我已完成，继续",
    "target": {
      "url": "http://127.0.0.1:15173/auth/sso",
      "tab_id": 102
    },
    "resume_note": "继续原验收项中的数据导出测试；先核验页面 URL 是否已跳转至 /dashboard 且存在登出按钮，再继续点击导出。"
  }
}
```

#### 业务提问（question）
```json
{
  "status": "need_user",
  "summary": "空列表时的展示预期在需求中未明确。",
  "user_interaction": {
    "kind": "question",
    "title": "请确认空列表展示形式",
    "message": "当检索无结果时，系统有两种交互设计方案，需要您确认业务偏好：",
    "question": "无结果时应显示哪种形式？",
    "choices": [
      { "id": "empty_illustration", "label": "展示缺省插画及‘未找到相关内容’提示" },
      { "id": "recommended_items", "label": "展示猜你喜欢的推荐列表" }
    ],
    "allow_free_text": true
  }
}
```

---

## 3. 发起请求前的准备与隐私底线

1. **隐私安全隔离**：
   - 发起登录类请求前，**必须立即停止**针对该标签页的网络捕获、控制台监听和截图操作，避免抓取到用户的密码、Token 或验证码。
2. **状态与停留位置留存**：
   - 填写非敏感的 `target` 与 `resume_note`，明确说明当前停止在哪一步、续接后要检查什么。
3. **轮次自然结束**：
   - 模型发出 `need_user` 后本轮正常结束并释放执行资源。严禁在后台使用 `sleep` 循环轮询用户是否已登录。

---

## 4. 用户确认后的续接原则

1. **现场复查，绝不盲目判定**：
   - 用户点击“我已完成，继续”**不等于**登录已成功或测试已通过。
   - 续接后的执行模型必须重新调用浏览器工具检查当前页面 URL、DOM 元素或状态标志，确认用户确实已完成操作。
   - 若检查发现用户仍未登录或页面出错，应如实记录当前状态，必要时再次发出明确说明的人工请求。
2. **严禁模型自行代点确认**：
   - 执行模型**严禁**使用 OpenTabs、脚本或调用 HTTP API 代替真实用户点击控制台上的确认或回答按钮。
