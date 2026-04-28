import { useState } from "react";

const SECTIONS = [
  {
    title: "项目概述",
    content: `Replit2Api 是一个统一的 AI API 代理网关，将 OpenAI、Anthropic、Google Gemini 和 OpenRouter 四大主流 AI 服务商整合为单一入口。

客户端只需配置一个 Base URL 和一个 API Key，即可访问所有后端的模型，无需为每个服务商分别维护不同的 SDK、认证方式和请求格式。

主要特性：
- 统一 OpenAI 兼容格式，自动转换请求和响应
- 子节点集群优先路由，本地账号可选兜底
- 完整支持流式输出（SSE）、工具调用、扩展思考
- 假流式支持：将非流式 JSON 自动模拟为 SSE 流
- 零配置一键 Remix 部署`,
  },
  {
    title: "请求路由机制",
    content: `网关根据请求中的模型名称自动判断目标服务商：

OpenAI 模型：gpt-5.2, gpt-5.1, gpt-5, gpt-4.1, gpt-4o, o3, o4-mini 等
Anthropic 模型：claude-opus-4-6, claude-sonnet-4-5, claude-haiku-4-5 等
Gemini 模型：gemini-3.1-pro, gemini-2.5-flash 等
OpenRouter 模型：包含 "/" 的模型名（如 openai/gpt-4o）以及注册的第三方模型

路由优先级：
1. 健康子节点优先（轮询）
2. 所有子节点不可用时，根据「主号兜底」开关决定是否回退本地
3. 失败自动重试下一个可用节点`,
  },
  {
    title: "认证方式",
    content: `支持三种认证方式（任选其一）：

1. Authorization: Bearer <proxy-key>（OpenAI 标准）
2. x-api-key: <proxy-key>（Anthropic 风格）
3. URL 查询参数 ?key=<proxy-key>（适合调试）

所有管理 API（/v1/admin/*）都需要认证。
聊天补全端点（/v1/chat/completions）需要认证。
健康检查（/healthz）不需要认证。`,
  },
  {
    title: "API 端点详解",
    content: `聊天补全：
POST /v1/chat/completions — OpenAI 兼容的聊天接口，自动路由到对应后端

Anthropic 原生：
POST /v1/messages — Claude 原生格式透传

模型列表：
GET /v1/models — 返回 OpenAI 兼容的模型列表

管理端点：
GET /v1/stats — 查看统计数据和路由设置
GET/PATCH /v1/admin/routing — 读取/修改路由策略
GET/POST/DELETE /v1/admin/backends — 管理动态子节点
GET/PATCH /v1/admin/models — 管理模型启用/禁用
GET /v1/admin/logs — 获取请求日志
GET /v1/admin/logs/stream — SSE 实时日志流

健康检查：
GET /healthz — 系统健康状态`,
  },
  {
    title: "格式转换矩阵",
    content: `发送 Claude 模型：
- OpenAI messages → Anthropic messages 自动转换
- system 消息 → Anthropic system 参数
- OpenAI tools → Anthropic tool_use blocks
- thinking 模式 → extended_thinking 参数

发送 Gemini 模型：
- OpenAI messages → Gemini contents 格式
- system 消息 → systemInstruction 参数
- thinking 模式 → thinkingConfig.thinkingBudget

响应始终转换回 OpenAI 兼容格式。`,
  },
  {
    title: "思考模式（Extended Thinking）",
    content: `在模型名后添加后缀即可启用：

-thinking：思考过程隐藏，只返回最终回答
-thinking-visible：思考过程可见，包裹在 <thinking> 标签中

示例：
claude-sonnet-4-5-thinking → 隐藏思考
claude-sonnet-4-5-thinking-visible → 可见思考
gemini-2.5-flash-thinking → Gemini 思考模式

Claude 模型使用 Anthropic extended_thinking API。
Gemini 模型使用 thinkingConfig.thinkingBudget。
OpenAI o-series 模型原生支持推理，无需后缀。`,
  },
  {
    title: "流式输出（SSE）",
    content: `完整支持 Server-Sent Events 流式输出：

请求时设置 "stream": true 即可启用。

假流式（Fake Streaming）：
当后端不支持流式或流式请求失败时，如果开启了「假流式」开关，网关会自动将完整 JSON 响应拆分为 SSE chunks，模拟逐字输出效果（4 字符/chunk，10ms 间隔）。

可通过路由策略面板的「假流式」开关控制。`,
  },
  {
    title: "SillyTavern 兼容模式",
    content: `SillyTavern 等角色扮演客户端可能发送不符合 Claude API 要求的消息序列（例如最后一条消息不是 user 角色）。

启用此模式后，网关会自动在末尾追加一条空的 user 消息，修复 Claude 的角色顺序要求。

可在首页的开关中启用/禁用。`,
  },
  {
    title: "SDK 集成示例",
    content: `Node.js（openai 库）：
const openai = new OpenAI({
  baseURL: "https://your-app.replit.app/v1",
  apiKey: "your-proxy-key",
});
const response = await openai.chat.completions.create({
  model: "claude-sonnet-4-5",
  messages: [{ role: "user", content: "Hello!" }],
});

Python（openai 库）：
from openai import OpenAI
client = OpenAI(
    base_url="https://your-app.replit.app/v1",
    api_key="your-proxy-key",
)
response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello!"}],
)`,
  },
];

export default function PageDocs() {
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));

  const toggle = (i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <p style={{ color: "#64748b", fontSize: "13px", margin: "0 0 8px" }}>
        以下是本 AI Proxy Gateway 的全部技术细节。
      </p>
      {SECTIONS.map((sec, i) => (
        <div key={i} style={{
          background: "rgba(0,0,0,0.25)", borderRadius: "10px",
          border: "1px solid rgba(255,255,255,0.06)",
          overflow: "hidden",
        }}>
          <button
            onClick={() => toggle(i)}
            style={{
              width: "100%", padding: "14px 16px",
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: "none", border: "none", cursor: "pointer",
              color: "#e2e8f0", fontSize: "14px", fontWeight: 600,
              textAlign: "left",
            }}
          >
            <span>{sec.title}</span>
            <span style={{
              transform: expanded.has(i) ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.2s", fontSize: "12px", color: "#64748b",
            }}>&#9654;</span>
          </button>
          {expanded.has(i) && (
            <div style={{
              padding: "0 16px 16px",
              color: "#94a3b8", fontSize: "13px", lineHeight: "1.8",
              whiteSpace: "pre-wrap",
              borderTop: "1px solid rgba(255,255,255,0.04)",
            }}>
              {sec.content}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
