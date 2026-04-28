import { useState, useEffect, useCallback } from "react";
import SetupWizard from "./components/SetupWizard";
import UpdateBadge from "./components/UpdateBadge";
import PageLogs from "./components/PageLogs";
import PageDocs from "./components/PageDocs";

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

type Provider = "openai" | "anthropic" | "gemini" | "openrouter";

interface ModelEntry {
  id: string;
  label: string;
  provider: Provider;
  desc: string;
  badge?: "thinking" | "thinking-visible" | "tools" | "reasoning" | "image";
  context?: string;
}

const OPENAI_MODELS: ModelEntry[] = [
  { id: "gpt-5.2", label: "GPT-5.2", provider: "openai", desc: "最新旗舰多模态模型", context: "128K", badge: "tools" },
  { id: "gpt-5.1", label: "GPT-5.1", provider: "openai", desc: "旗舰多模态模型", context: "128K", badge: "tools" },
  { id: "gpt-5", label: "GPT-5", provider: "openai", desc: "旗舰多模态模型", context: "128K", badge: "tools" },
  { id: "gpt-5-mini", label: "GPT-5 Mini", provider: "openai", desc: "高性价比快速模型", context: "128K", badge: "tools" },
  { id: "gpt-5-nano", label: "GPT-5 Nano", provider: "openai", desc: "超轻量边缘模型", context: "128K", badge: "tools" },
  { id: "gpt-4.1", label: "GPT-4.1", provider: "openai", desc: "稳定通用旗舰模型", context: "1M", badge: "tools" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 Mini", provider: "openai", desc: "均衡速度与质量", context: "1M", badge: "tools" },
  { id: "gpt-4.1-nano", label: "GPT-4.1 Nano", provider: "openai", desc: "超高速轻量模型", context: "1M", badge: "tools" },
  { id: "gpt-4o", label: "GPT-4o", provider: "openai", desc: "多模态旗舰（图文音）", context: "128K", badge: "tools" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini", provider: "openai", desc: "轻量多模态模型", context: "128K", badge: "tools" },
  { id: "o4-mini", label: "o4 Mini", provider: "openai", desc: "推理模型，快速高效", context: "200K", badge: "reasoning" },
  { id: "o4-mini-thinking", label: "o4 Mini (thinking)", provider: "openai", desc: "o4 Mini 思考别名", context: "200K", badge: "thinking" },
  { id: "o3", label: "o3", provider: "openai", desc: "强推理旗舰模型", context: "200K", badge: "reasoning" },
  { id: "o3-thinking", label: "o3 (thinking)", provider: "openai", desc: "o3 思考别名", context: "200K", badge: "thinking" },
  { id: "o3-mini", label: "o3 Mini", provider: "openai", desc: "高效推理模型", context: "200K", badge: "reasoning" },
  { id: "o3-mini-thinking", label: "o3 Mini (thinking)", provider: "openai", desc: "o3 Mini 思考别名", context: "200K", badge: "thinking" },
];

const ANTHROPIC_MODELS: ModelEntry[] = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", provider: "anthropic", desc: "最新旗舰推理模型", context: "200K", badge: "tools" },
  { id: "claude-opus-4-7-thinking", label: "Claude Opus 4.7 (thinking)", provider: "anthropic", desc: "扩展思考（隐藏）", context: "200K", badge: "thinking" },
  { id: "claude-opus-4-7-thinking-visible", label: "Claude Opus 4.7 (thinking visible)", provider: "anthropic", desc: "扩展思考（可见）", context: "200K", badge: "thinking-visible" },
  { id: "claude-opus-4-7-300k-thinking", label: "Claude Opus 4.7 (300k thinking)", provider: "anthropic", desc: "300k 超长输出 + 最强思考", context: "1M", badge: "thinking" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", provider: "anthropic", desc: "顶级推理与智能体任务", context: "200K", badge: "tools" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (thinking)", provider: "anthropic", desc: "扩展思考（隐藏）", context: "200K", badge: "thinking" },
  { id: "claude-opus-4-6-thinking-visible", label: "Claude Opus 4.6 (thinking visible)", provider: "anthropic", desc: "扩展思考（可见）", context: "200K", badge: "thinking-visible" },
  { id: "claude-opus-4-6-300k-thinking", label: "Claude Opus 4.6 (300k thinking)", provider: "anthropic", desc: "300k 超长输出 + 最强思考", context: "1M", badge: "thinking" },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5", provider: "anthropic", desc: "旗舰推理模型", context: "200K", badge: "tools" },
  { id: "claude-opus-4-5-thinking", label: "Claude Opus 4.5 (thinking)", provider: "anthropic", desc: "扩展思考（隐藏）", context: "200K", badge: "thinking" },
  { id: "claude-opus-4-5-thinking-visible", label: "Claude Opus 4.5 (thinking visible)", provider: "anthropic", desc: "扩展思考（可见）", context: "200K", badge: "thinking-visible" },
  { id: "claude-opus-4-1", label: "Claude Opus 4.1", provider: "anthropic", desc: "旗舰模型（稳定版）", context: "200K", badge: "tools" },
  { id: "claude-opus-4-1-thinking", label: "Claude Opus 4.1 (thinking)", provider: "anthropic", desc: "扩展思考（隐藏）", context: "200K", badge: "thinking" },
  { id: "claude-opus-4-1-thinking-visible", label: "Claude Opus 4.1 (thinking visible)", provider: "anthropic", desc: "扩展思考（可见）", context: "200K", badge: "thinking-visible" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", desc: "速度与智能最佳平衡", context: "200K", badge: "tools" },
  { id: "claude-sonnet-4-6-thinking", label: "Claude Sonnet 4.6 (thinking)", provider: "anthropic", desc: "扩展思考（隐藏）", context: "200K", badge: "thinking" },
  { id: "claude-sonnet-4-6-thinking-visible", label: "Claude Sonnet 4.6 (thinking visible)", provider: "anthropic", desc: "扩展思考（可见）", context: "200K", badge: "thinking-visible" },
  { id: "claude-sonnet-4-6-300k-thinking", label: "Claude Sonnet 4.6 (300k thinking)", provider: "anthropic", desc: "300k 超长输出 + 最强思考", context: "1M", badge: "thinking" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", provider: "anthropic", desc: "均衡性价比旗舰", context: "200K", badge: "tools" },
  { id: "claude-sonnet-4-5-thinking", label: "Claude Sonnet 4.5 (thinking)", provider: "anthropic", desc: "扩展思考（隐藏）", context: "200K", badge: "thinking" },
  { id: "claude-sonnet-4-5-thinking-visible", label: "Claude Sonnet 4.5 (thinking visible)", provider: "anthropic", desc: "扩展思考（可见）", context: "200K", badge: "thinking-visible" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", desc: "超快速轻量模型", context: "200K", badge: "tools" },
  { id: "claude-haiku-4-5-thinking", label: "Claude Haiku 4.5 (thinking)", provider: "anthropic", desc: "扩展思考（隐藏）", context: "200K", badge: "thinking" },
  { id: "claude-haiku-4-5-thinking-visible", label: "Claude Haiku 4.5 (thinking visible)", provider: "anthropic", desc: "扩展思考（可见）", context: "200K", badge: "thinking-visible" },
];

const GEMINI_MODELS: ModelEntry[] = [
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", provider: "gemini", desc: "最新旗舰多模态模型", context: "2M", badge: "tools" },
  { id: "gemini-3.1-pro-preview-thinking", label: "Gemini 3.1 Pro Preview (thinking)", provider: "gemini", desc: "扩展思考（隐藏）", context: "2M", badge: "thinking" },
  { id: "gemini-3.1-pro-preview-thinking-visible", label: "Gemini 3.1 Pro Preview (thinking visible)", provider: "gemini", desc: "扩展思考（可见）", context: "2M", badge: "thinking-visible" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview", provider: "gemini", desc: "极速多模态模型", context: "1M", badge: "tools" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "gemini", desc: "推理旗舰，强代码能力", context: "1M", badge: "tools" },
  { id: "gemini-2.5-pro-thinking", label: "Gemini 2.5 Pro (thinking)", provider: "gemini", desc: "扩展思考（隐藏）", context: "1M", badge: "thinking" },
  { id: "gemini-2.5-pro-thinking-visible", label: "Gemini 2.5 Pro (thinking visible)", provider: "gemini", desc: "扩展思考（可见）", context: "1M", badge: "thinking-visible" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "gemini", desc: "速度与质量兼备", context: "1M", badge: "tools" },
  { id: "gemini-2.5-flash-thinking", label: "Gemini 2.5 Flash (thinking)", provider: "gemini", desc: "扩展思考（隐藏）", context: "1M", badge: "thinking" },
  { id: "gemini-2.5-flash-thinking-visible", label: "Gemini 2.5 Flash (thinking visible)", provider: "gemini", desc: "扩展思考（可见）", context: "1M", badge: "thinking-visible" },
];

const OPENROUTER_MODELS: ModelEntry[] = [
  { id: "x-ai/grok-4.20", label: "Grok 4.20", provider: "openrouter", desc: "xAI 最新旗舰推理模型", badge: "tools" },
  { id: "x-ai/grok-4.1-fast", label: "Grok 4.1 Fast", provider: "openrouter", desc: "xAI 高速对话模型", badge: "tools" },
  { id: "x-ai/grok-4-fast", label: "Grok 4 Fast", provider: "openrouter", desc: "xAI 快速模型", badge: "tools" },
  { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick", provider: "openrouter", desc: "Meta 多模态旗舰" },
  { id: "meta-llama/llama-4-scout", label: "Llama 4 Scout", provider: "openrouter", desc: "Meta 长上下文模型", context: "10M" },
  { id: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2", provider: "openrouter", desc: "中文/代码强模型", badge: "tools" },
  { id: "deepseek/deepseek-r1", label: "DeepSeek R1", provider: "openrouter", desc: "开源强推理模型", badge: "reasoning" },
  { id: "deepseek/deepseek-r1-0528", label: "DeepSeek R1 0528", provider: "openrouter", desc: "R1 最新版本", badge: "reasoning" },
  { id: "mistralai/mistral-small-2603", label: "Mistral Small 2603", provider: "openrouter", desc: "轻量高效模型", badge: "tools" },
  { id: "qwen/qwen3.5-122b-a10b", label: "Qwen 3.5 122B", provider: "openrouter", desc: "Alibaba 大参数旗舰" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (OR)", provider: "openrouter", desc: "通过 OpenRouter 的 Gemini" },
  { id: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6 (OR)", provider: "openrouter", desc: "通过 OpenRouter 的 Claude", badge: "tools" },
  { id: "anthropic/claude-opus-4.6-fast", label: "Claude Opus 4.6 Fast (OR)", provider: "openrouter", desc: "Claude Opus 4.6 高速版", badge: "tools" },
  { id: "anthropic/claude-opus-4.6-thinking", label: "Claude Opus 4.6 (OR thinking)", provider: "openrouter", desc: "OpenRouter 思维链（隐藏）", badge: "thinking" },
  { id: "anthropic/claude-opus-4.6-thinking-visible", label: "Claude Opus 4.6 (OR thinking visible)", provider: "openrouter", desc: "OpenRouter 思维链（可见）", badge: "thinking-visible" },
  { id: "anthropic/claude-opus-4.7", label: "Claude Opus 4.7 (OR)", provider: "openrouter", desc: "通过 OpenRouter 的 Claude Opus 4.7", badge: "tools" },
  { id: "anthropic/claude-opus-4.7-fast", label: "Claude Opus 4.7 Fast (OR)", provider: "openrouter", desc: "Claude Opus 4.7 高速版", badge: "tools" },
  { id: "anthropic/claude-opus-4.7-thinking", label: "Claude Opus 4.7 (OR thinking)", provider: "openrouter", desc: "OpenRouter 思维链（隐藏）", badge: "thinking" },
  { id: "anthropic/claude-opus-4.7-thinking-visible", label: "Claude Opus 4.7 (OR thinking visible)", provider: "openrouter", desc: "OpenRouter 思维链（可见）", badge: "thinking-visible" },
  { id: "cohere/command-a", label: "Command A", provider: "openrouter", desc: "Cohere 企业级模型", badge: "tools" },
  { id: "amazon/nova-premier-v1", label: "Nova Premier V1", provider: "openrouter", desc: "Amazon 旗舰多模态" },
  { id: "baidu/ernie-4.5-300b-a47b", label: "ERNIE 4.5 300B", provider: "openrouter", desc: "百度 MoE 大参数模型" },
  { id: "z-ai/glm-5.1", label: "GLM 5.1", provider: "openrouter", desc: "智谱 AI 旗舰模型" },
  { id: "qwen/qwen3.6-plus", label: "Qwen 3.6 Plus", provider: "openrouter", desc: "Alibaba Qwen 3.6 增强版" },
  { id: "openai/gpt-5.4", label: "GPT-5.4 (OR)", provider: "openrouter", desc: "通过 OpenRouter 的 GPT-5.4", badge: "tools" },
  { id: "openai/gpt-5.4-pro", label: "GPT-5.4 Pro (OR)", provider: "openrouter", desc: "通过 OpenRouter 的 GPT-5.4 Pro", badge: "tools" },
  { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini (OR)", provider: "openrouter", desc: "通过 OpenRouter 的 GPT-5.4 Mini" },
  { id: "openai/gpt-5.4-nano", label: "GPT-5.4 Nano (OR)", provider: "openrouter", desc: "通过 OpenRouter 的 GPT-5.4 Nano" },
  { id: "openai/gpt-5-image", label: "GPT-5 Image (OR)", provider: "openrouter", desc: "文字+图片 → 生成图片", badge: "image" },
  { id: "openai/gpt-5-image-mini", label: "GPT-5 Image Mini (OR)", provider: "openrouter", desc: "文字+图片 → 生成图片", badge: "image" },
  { id: "google/gemini-3.1-flash-image-preview", label: "Gemini 3.1 Flash Image (OR)", provider: "openrouter", desc: "文字+图片 → 生成图片", badge: "image" },
  { id: "google/gemini-3-pro-image-preview", label: "Gemini 3 Pro Image (OR)", provider: "openrouter", desc: "文字+图片 → 生成图片", badge: "image" },
  { id: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image (OR)", provider: "openrouter", desc: "文字+图片 → 生成图片", badge: "image" },
];

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const PROVIDER_COLORS: Record<Provider, { bg: string; border: string; dot: string; text: string; label: string }> = {
  openai: { bg: "rgba(59,130,246,0.1)", border: "rgba(59,130,246,0.25)", dot: "#60a5fa", text: "#93c5fd", label: "OpenAI" },
  anthropic: { bg: "rgba(251,146,60,0.1)", border: "rgba(251,146,60,0.25)", dot: "#fb923c", text: "#fdba74", label: "Anthropic" },
  gemini: { bg: "rgba(52,211,153,0.08)", border: "rgba(52,211,153,0.25)", dot: "#34d399", text: "#6ee7b7", label: "Google Gemini" },
  openrouter: { bg: "rgba(167,139,250,0.08)", border: "rgba(167,139,250,0.2)", dot: "#a78bfa", text: "#c4b5fd", label: "OpenRouter" },
};

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const el = document.createElement("textarea");
      el.value = text; document.body.appendChild(el); el.select();
      document.execCommand("copy"); document.body.removeChild(el);
    }
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={handleCopy} style={{
      background: copied ? "rgba(74,222,128,0.15)" : "rgba(255,255,255,0.07)",
      border: `1px solid ${copied ? "rgba(74,222,128,0.4)" : "rgba(255,255,255,0.12)"}`,
      color: copied ? "#4ade80" : "#94a3b8", borderRadius: "6px",
      padding: "4px 10px", fontSize: "12px", cursor: "pointer",
      transition: "all 0.15s", whiteSpace: "nowrap", flexShrink: 0,
    }}>
      {copied ? "已复制!" : (label ?? "复制")}
    </button>
  );
}

function CodeBlock({ code, copyText }: { code: string; copyText?: string }) {
  return (
    <div style={{ position: "relative", marginTop: "8px" }}>
      <pre style={{
        background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: "8px", padding: "12px 16px", fontFamily: "Menlo, monospace",
        fontSize: "12.5px", color: "#e2e8f0", overflowX: "auto", margin: 0, paddingRight: "72px",
        lineHeight: "1.6",
      }}>{code}</pre>
      <div style={{ position: "absolute", top: "8px", right: "8px" }}>
        <CopyButton text={copyText ?? code} />
      </div>
    </div>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)",
      borderRadius: "12px", padding: "24px", ...style,
    }}>{children}</div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{
      fontSize: "11px", fontWeight: 700, color: "#64748b", letterSpacing: "0.1em",
      textTransform: "uppercase", marginBottom: "16px", marginTop: 0,
    }}>{children}</h2>
  );
}

function Badge({ variant }: { variant: string }) {
  const styles: Record<string, { color: string; bg: string; border: string }> = {
    thinking: { color: "#c084fc", bg: "rgba(192,132,252,0.15)", border: "rgba(192,132,252,0.35)" },
    "thinking-visible": { color: "#34d399", bg: "rgba(52,211,153,0.12)", border: "rgba(52,211,153,0.3)" },
    tools: { color: "#fbbf24", bg: "rgba(251,191,36,0.1)", border: "rgba(251,191,36,0.3)" },
    reasoning: { color: "#f472b6", bg: "rgba(244,114,182,0.1)", border: "rgba(244,114,182,0.3)" },
    image: { color: "#38bdf8", bg: "rgba(56,189,248,0.1)", border: "rgba(56,189,248,0.3)" },
  };
  const labels: Record<string, string> = { thinking: "思考", "thinking-visible": "思考可见", tools: "工具", reasoning: "推理", image: "图片" };
  const s = styles[variant] ?? styles.tools;
  return (
    <span style={{
      fontSize: "10px", fontWeight: 600, color: s.color,
      background: s.bg, border: `1px solid ${s.border}`,
      borderRadius: "4px", padding: "1px 5px", flexShrink: 0,
    }}>{labels[variant] ?? variant}</span>
  );
}

function MethodBadge({ method }: { method: "GET" | "POST" }) {
  return (
    <span style={{
      background: method === "GET" ? "rgba(34,197,94,0.15)" : "rgba(99,102,241,0.2)",
      color: method === "GET" ? "#4ade80" : "#818cf8",
      border: `1px solid ${method === "GET" ? "rgba(34,197,94,0.3)" : "rgba(99,102,241,0.3)"}`,
      borderRadius: "5px", padding: "2px 8px", fontSize: "11px", fontWeight: 700,
      fontFamily: "Menlo, monospace", flexShrink: 0,
    }}>{method}</span>
  );
}

function ModelGroup({ title, models, provider, expanded, onToggle }: {
  title: string; models: ModelEntry[]; provider: Provider;
  expanded: boolean; onToggle: () => void;
}) {
  const c = PROVIDER_COLORS[provider];
  const base = models.filter((m) => !m.badge || (m.badge !== "thinking" && m.badge !== "thinking-visible"));
  const thinking = models.filter((m) => m.badge === "thinking" || m.badge === "thinking-visible");
  return (
    <div style={{ marginBottom: "10px" }}>
      <button onClick={onToggle} style={{
        display: "flex", alignItems: "center", gap: "10px", width: "100%",
        background: c.bg, border: `1px solid ${c.border}`, borderRadius: "8px",
        padding: "10px 14px", cursor: "pointer", textAlign: "left",
      }}>
        <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: c.dot, flexShrink: 0 }} />
        <span style={{ fontWeight: 600, color: c.text, fontSize: "13px", flex: 1 }}>{title}</span>
        <span style={{ fontSize: "12px", color: "#475569" }}>{base.length} 基础 · {thinking.length > 0 ? `${thinking.length} 思考变体` : "–"}</span>
        <span style={{ fontSize: "11px", color: "#475569", marginLeft: "4px" }}>{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div style={{ marginTop: "5px", display: "flex", flexDirection: "column", gap: "3px" }}>
          {models.map((m) => (
            <div key={m.id} style={{
              display: "flex", alignItems: "center", gap: "10px",
              background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.05)",
              borderRadius: "7px", padding: "7px 12px",
            }}>
              <code style={{ fontFamily: "Menlo, monospace", fontSize: "12px", color: c.text, flex: 1, wordBreak: "break-all" }}>{m.id}</code>
              <span style={{ fontSize: "12px", color: "#475569", flexShrink: 0, minWidth: "100px", textAlign: "right" }}>{m.desc}</span>
              {m.context && (
                <span style={{ fontSize: "10px", color: "#334155", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "3px", padding: "1px 5px", flexShrink: 0 }}>{m.context}</span>
              )}
              {m.badge && <Badge variant={m.badge} />}
              <CopyButton text={m.id} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page components
// ---------------------------------------------------------------------------

function PageHome({
  displayUrl, apiKey, setApiKey, sillyTavernMode, stLoading, onToggleSTMode,
}: {
  displayUrl: string;
  apiKey: string;
  setApiKey: (k: string) => void;
  sillyTavernMode: boolean;
  stLoading: boolean;
  onToggleSTMode: () => void;
}) {
  return (
    <>
      {/* Changelog */}
      <Card style={{ marginBottom: "20px", borderColor: "rgba(99,102,241,0.25)", background: "rgba(99,102,241,0.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px" }}>
          <span style={{ fontSize: "15px" }}>📋</span>
          <SectionTitle>更新日志 · Changelog</SectionTitle>
        </div>
        {(() => {
          const releases = [
            {
              version: "v1.1.7",
              date: "2026-04-08",
              items: [
                { zh: "按模型定价：预估开销改为根据每个模型的官方价格（输入/输出分别定价）精确计算，涵盖 47 个模型", en: "Per-model pricing: cost estimation now uses official per-model input/output rates for 47 models across all 4 providers" },
                { zh: "按模型统计：后端新增 per-model token 统计（调用次数 / 输入 / 输出 token），持久化到 usage_stats.json", en: "Per-model stats: backend now tracks calls, prompt tokens, and completion tokens per model; persisted to usage_stats.json" },
                { zh: "「按模型开销」卡片：统计面板第 6 格改为按模型维度展示费用排行，显示每个模型的调用次数和精确费用", en: "Per-model cost card: 6th summary card now shows cost breakdown by model (sorted by cost desc) with call count and precise cost" },
                { zh: "定价覆盖：OpenAI GPT-5/4.1/4o/o-series、Anthropic Claude Opus/Sonnet/Haiku 4.x/3.x、Gemini 3.1/3/2.5/2.0/1.5、OpenRouter Grok/Llama/DeepSeek/Mistral/Qwen 等全部覆盖", en: "Pricing coverage: OpenAI GPT-5/4.1/4o/o-series, Anthropic Claude 4.x/3.x, Gemini 3.1–1.5, OpenRouter Grok/Llama/DeepSeek/Mistral/Qwen and more" },
                { zh: "模型名智能匹配：自动剥离 provider 前缀（anthropic/、x-ai/ 等）和后缀（-thinking、-preview、日期戳），确保定价命中率", en: "Smart model name matching: strips provider prefixes and suffixes (-thinking, -preview, date stamps) for reliable pricing lookup" },
              ],
            },
            {
              version: "v1.1.6",
              date: "2026-04-08",
              items: [
                { zh: "假流式支持：后端不支持流式或流式请求失败时，自动将完整 JSON 响应拆分为 SSE 流式输出，模拟逐字输出效果", en: "Fake streaming: when backends return JSON for stream requests or real streaming fails, automatically converts to SSE chunks with typewriter effect" },
                { zh: "假流式开关：路由策略面板新增「假流式」开关，可独立启用/关闭，支持 API 控制和持久化", en: "Fake stream toggle: new switch in routing settings panel, controllable via API and persisted across restarts" },
                { zh: "持久化竞态修复：路由设置、动态节点、禁用模型、统计数据全部在服务器启动前加载完成，彻底消除刷新页面后设置重置的问题", en: "Persistence race fix: routing settings, dynamic backends, disabled models, and stats are all loaded before server accepts requests — eliminates settings reset on page refresh" },
                { zh: "写入错误不再静默吞掉，所有持久化失败均输出日志以便排查", en: "Write errors are no longer silently swallowed — all persistence failures are logged for debugging" },
              ],
            },
            {
              version: "v1.1.5",
              date: "2026-04-07",
              items: [
                { zh: "子节点优先路由：有健康子节点时只在子节点间轮询，本地账号仅在所有子节点不可用时作为兜底，防止主账号余额耗尽拖垮整个轮询", en: "Friend-first routing: requests are round-robined across healthy friend nodes only; local backend is used as fallback only when all friends are down — prevents main account balance exhaustion from breaking the pool" },
                { zh: "健康检查误标红修复：请求成功后立即将子节点标记为健康（不再仅依赖后台探测）；探测超时从 5 秒提升到 15 秒以适应 Replit 冷启动", en: "Health check false-red fix: successful requests immediately mark friend nodes as healthy; probe timeout raised from 5s to 15s to accommodate Replit cold starts" },
                { zh: "添加节点时健康缓存 key 统一使用归一化 URL，修复 raw URL 与 normalized URL 不匹配导致的状态丢失", en: "Add-backend health cache now uses normalized URL as key, fixing cache miss caused by raw vs normalized URL mismatch" },
                { zh: "配置助手提示词改为 setupReplitAIIntegrations() 编程接口，四个 provider 逐条执行，零歧义；禁止索取 Key 的声明覆盖全部四家", en: "Setup wizard prompt now uses setupReplitAIIntegrations() API calls for all 4 providers — sequential, unambiguous; API key ban text covers all four providers" },
              ],
            },
            {
              version: "v1.1.4",
              date: "2026-04-07",
              items: [
                { zh: "Gemini 和 OpenRouter 接入 Replit 内置 AI Integrations：四大后端（OpenAI / Anthropic / Gemini / OpenRouter）全部使用平台原生集成，无需任何第三方 API Key", en: "Gemini & OpenRouter now use Replit built-in AI Integrations — all 4 backends (OpenAI / Anthropic / Gemini / OpenRouter) run natively, no third-party API keys needed" },
                { zh: "Gemini 模型走 @google/genai SDK 原生调用，支持流式/非流式及 thinking 模式，自动进行 OpenAI ↔ Gemini 格式转换", en: "Gemini models routed via @google/genai SDK natively with full streaming, non-streaming, and thinking mode support; auto-converts between OpenAI and Gemini formats" },
                { zh: "OpenRouter 模型复用 OpenAI SDK，指向 Replit OpenRouter 集成代理端点，无缝支持 Grok / Llama / DeepSeek / Mistral 等长尾模型", en: "OpenRouter models reuse OpenAI SDK pointed at Replit's OpenRouter integration proxy — seamless support for Grok, Llama, DeepSeek, Mistral and more" },
                { zh: "设置向导和健康检查更新：新增 Gemini / OpenRouter Integration 的添加说明和环境变量检测", en: "Setup wizard and health check updated: now includes Gemini / OpenRouter integration setup instructions and env var detection" },
              ],
            },
            {
              version: "v1.1.3",
              date: "2026-04-07",
              items: [
                { zh: "配置助手自动检测 AI Integrations 和存储状态，动态生成仅需要的步骤", en: "Setup wizard auto-detects AI Integrations & storage status; dynamically generates only the steps actually needed" },
                { zh: "Remix 和 GitHub 导入的用户自动跳过已配置好的步骤", en: "Remix and GitHub-import users skip pre-configured steps automatically" },
              ],
            },
            {
              version: "v1.1.2",
              date: "2026-04-07",
              items: [
                { zh: "配置助手重新设计：用户现在可以自行设定访问密码，密码明文写入发给 Agent 的指令中，Agent 直接配置，无需二次询问", en: "Setup wizard redesign: user sets their own access password; key is written directly into the Agent prompt — no random-generated key, no follow-up question" },
                { zh: "配置完成后门户首页「API Key」输入框自动填入用户设定的密码，无需手动复制", en: "Portal auto-fills the API Key field on wizard completion — user doesn't need to type their key a second time" },
                { zh: "用量统计通过 cloudPersist 持久化到存储（开发环境写本地文件，生产环境写对象存储）：服务器重启或重新部署后统计数据不丢失", en: "Usage stats now persisted via cloudPersist (local file in dev, object storage in prod) — survives restarts and Publish redeploys" },
                { zh: "认证失败提示语简化：密码由用户自定义，提示只需告知去 Secrets 面板查看或重新运行配置助手", en: "Auth error message simplified to match the new self-defined key flow" },
              ],
            },
            {
              version: "v1.1.1",
              date: "2026-04-07",
              items: [
                { zh: "流式超时从 120 秒提升到 600 秒（10 分钟），彻底解决长回复（≥5000 token）在传输途中被截断的问题", en: "Streaming fetch timeout raised from 120 s to 600 s — prevents truncation of long responses (5 000+ tokens)" },
                { zh: "SSE 保活间隔从每 3 秒改为每 15 秒，减少不必要带宽消耗，同时仍可防止代理 60 秒空闲超时", en: "SSE keepalive interval changed from 3 s to 15 s — less overhead while still preventing proxy idle timeouts" },
                { zh: "统计页「添加节点」区块新增 ENV 节点配置复制框：提示词内容直接可见，点击一键复制发给 Replit Agent", en: "Stats page: ENV node prompt is now displayed in a copyable block — no more hidden-behind-button UX" },
                { zh: "日志页面只展示最新一条更新，其余历史版本折叠进滚动栏，首页核心功能无需滚动即可看全", en: "Changelog now shows only the latest release by default; all older entries are in a scrollable history section" },
              ],
            },
            {
              version: "v1.1.0",
              date: "2026-04-06",
              items: [
                { zh: "子节点请求失败自动重试（最多 3 次）：5xx 和网络错误均会自动换一个健康节点重试，不返回错误给客户端", en: "Friend proxy auto-retry: up to 3 attempts, skipping failed nodes on 5xx or network errors — client sees a clean response" },
                { zh: "区分 HTTP 错误（5xx）与网络错误，精准标记节点不健康并决定是否重试", en: "FriendProxyHttpError distinguishes upstream 5xx from network/timeout errors for smarter retry decisions" },
                { zh: "流式请求改为首个 chunk 到达后再发 SSE 头，确保在 chunk 来临前仍可切换节点", en: "Streaming: SSE headers committed only after first chunk arrives, preserving the retry window" },
                { zh: "子节点未返回 usage 时按字符数自动估算 token 用量（≈4字符/token），统计页面不再显示 0", en: "Token fallback: estimate prompt + completion tokens from char count when sub-node omits usage field" },
              ],
            },
            {
              version: "v1.0.9",
              date: "2026-04-06",
              items: [
                { zh: "配置助手弹窗逻辑修复：改为查询服务器是否已设置 PROXY_API_KEY，只在未完成初始化时才自动弹出；配置完成后无论换浏览器或清缓存均不再弹出", en: "Setup wizard no longer auto-pops on every load; now queries server setup status — only shows when PROXY_API_KEY is not yet configured" },
                { zh: "更新方式改为「复制提示词给 Replit Agent」：点击版本徽标→「复制提示词」→粘贴到 Replit AI 对话框，由 Agent 自动拉取最新代码并重启", en: "Update flow changed to 'Copy prompt for Replit Agent': click version badge → copy prompt → paste in Replit AI chat; Agent handles pull + restart" },
                { zh: "修复用量统计「刷新」按钮被上方元素遮挡无法点击的问题（去除 marginTop: -16px）", en: "Fix: stats refresh button was overlapped and unclickable due to negative margin; now properly positioned" },
                { zh: "统计加载失败时区分错误类型：服务器未配置 PROXY_API_KEY（500）vs API Key 不正确（401），显示针对性提示", en: "Stats error messages now differentiate: 'PROXY_API_KEY not configured' (500) vs 'API Key mismatch' (401)" },
              ],
            },
            {
              version: "v1.0.8",
              date: "2026-04-06",
              items: [
                { zh: "节点管理：全选 / 多选现在覆盖所有子节点（含 ENV 节点），批量启用 / 禁用 / 移除；ENV 节点无移除按钮", en: "Node management: select-all / multi-select now covers all sub-nodes (incl. ENV nodes); batch enable / disable / remove; ENV nodes have no remove button" },
                { zh: "更新日志加入滚动：仅展示最新 2 条，历史记录通过滚动查看", en: "Changelog scrollable: only 2 latest entries shown by default; scroll to view history" },
                { zh: "配置助手第 3 步：开通 App Storage，fork 用户的子节点配置 publish 后不再丢失", en: "Setup wizard step 3: provision App Storage so fork users' sub-node configs survive redeploys" },
              ],
            },
            {
              version: "v1.0.7",
              date: "2026-04-06",
              items: [
                { zh: "修复子节点 / 禁用模型数据 publish 后丢失：改用 Replit 云端对象存储（GCS）持久化，重新部署不再清空", en: "Fix: dynamic backends and disabled models now persisted to GCS — data survives redeploys" },
                { zh: "修复「重新检测」按钮在错误状态下不可点击的问题；点击后显示 loading 旋转和完成提示", en: "Fix: 'Re-check' button is now always clickable even after an error; shows spinner and completion feedback" },
                { zh: "修复「检测更新」弹窗按钮在 error 状态重置流程；新增无更新时「已是最新版本」提示", en: "Fix update modal error-state reset flow; show 'Already up to date' notice when no update is available" },
                { zh: "统计页面：/v1/stats 现在包含全部后端节点（含禁用的），禁用节点以红色边框 + 「已禁用」标签区分", en: "Stats page: /v1/stats now includes all backends including disabled ones; disabled rows show red border + badge" },
              ],
            },
            {
              version: "v1.0.6",
              date: "2026-04-06",
              items: [
                { zh: "新增「模型管理」标签页：支持按组一键全部启用/禁用，或逐条切换每个模型的开关状态", en: "New 'Model Management' tab: group-level one-click enable/disable and per-model toggle switches" },
                { zh: "禁用的模型从 /v1/models 响应中过滤，调用时返回 403 错误（model_disabled）", en: "Disabled models are filtered from /v1/models and return 403 (model_disabled) when called" },
                { zh: "状态持久化到 disabled_models.json，重启后保留设置", en: "State persisted to disabled_models.json, survives server restarts" },
                { zh: "「立即更新」按钮恢复：一键从 GitHub 拉取最新代码 + 自动重启", en: "Restored one-click update button: pulls latest code from GitHub and auto-restarts" },
              ],
            },
            {
              version: "v1.0.5",
              date: "2026-04-06",
              items: [
                { zh: "配置助手重写：单步模式，一条指令完成所有初始化（Secret + AI Integrations + 重启），明确禁止 Agent 索取第三方 API Key", en: "SetupWizard rewrite: single-step prompt covers all init (Secret + AI Integrations + restart); forbids Agent from asking for third-party API keys" },
                { zh: "版本比较修复：正确处理预发布后缀（a/b/rc1 等），stable > 同号 pre-release", en: "Version comparison fix: correctly handles pre-release suffixes (a/b/rc1…); stable > same-number pre-release" },
                { zh: "子节点 URL 自动补全 /api 后缀（服务端路由层 + 前端统计页）", en: "Sub-node URL auto-normalization: auto-appends /api suffix in server routing and frontend Stats page" },
                { zh: "X-Proxy-Version header 修复：过滤非 ASCII 字符，彻底解决 ERR_INVALID_CHAR 崩溃", en: "X-Proxy-Version header fix: strip non-ASCII chars, eliminating ERR_INVALID_CHAR crash" },
                { zh: "后端批量管理：多选批量启用 / 禁用 / 删除", en: "Batch backend management: multi-select for bulk enable / disable / remove" },
              ],
            },
            {
              version: "v1.0.1",
              date: "2026-04-06",
              items: [
                { zh: "完整 tool calling 支持 — Claude、Gemini 自动格式互转（tool_use / functionDeclarations）", en: "Full tool calling support — auto-conversion for Claude (tool_use) and Gemini (functionDeclarations)" },
                { zh: "Claude 流式工具调用：input_json_delta 逐块转发，finish_reason 正确映射为 tool_calls", en: "Claude streaming tool calls: input_json_delta forwarded chunk-by-chunk with correct tool_calls finish_reason" },
                { zh: "前端三栏重构：首页 / 统计 & 节点 / 端点文档，布局更清晰", en: "Frontend redesigned into 3-tab layout: Home / Stats & Nodes / API Docs" },
                { zh: "新增 Fleet Manager — 子节点批量版本检测与一键更新", en: "New Fleet Manager — batch version check and one-click update for sub-nodes" },
              ],
            },
            {
              version: "v1.0.0",
              date: "2026-04-06",
              items: [
                { zh: "正式版发布 — 统一接入 OpenAI / Anthropic / Gemini / OpenRouter 四大后端", en: "Initial release — unified gateway for OpenAI / Anthropic / Gemini / OpenRouter" },
                { zh: "支持 SillyTavern 兼容模式、CherryStudio 接入、多种认证方式", en: "SillyTavern compatibility mode, CherryStudio integration, multiple auth methods" },
                { zh: "Replit 文件包热更新机制（无需 GitHub，跨实例推送）", en: "Replit file-bundle hot-update system (no GitHub required, cross-instance push)" },
              ],
            },
          ];

          const renderRelease = (release: typeof releases[0]) => (
            <div key={release.version} style={{ marginBottom: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                <span style={{ fontFamily: "Menlo, monospace", fontSize: "13px", fontWeight: 700, color: "#a5b4fc" }}>{release.version}</span>
                <span style={{ fontSize: "11px", color: "#334155" }}>{release.date}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "5px", paddingLeft: "4px" }}>
                {release.items.map((item, i) => (
                  <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                    <span style={{ color: "#4f46e5", marginTop: "2px", flexShrink: 0, fontSize: "11px" }}>▸</span>
                    <div>
                      <div style={{ fontSize: "12.5px", color: "#94a3b8", lineHeight: "1.5" }}>{item.zh}</div>
                      <div style={{ fontSize: "11px", color: "#334155", lineHeight: "1.5", fontStyle: "italic" }}>{item.en}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );

          return (
            <div style={{ maxHeight: "260px", overflowY: "auto", paddingRight: "4px" }}>
              {releases.map(renderRelease)}
            </div>
          );
        })()}
      </Card>

      {/* Feature Cards */}
      <div style={{ marginBottom: "20px" }}>
        <SectionTitle>核心功能</SectionTitle>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px,1fr))", gap: "10px" }}>
          {[
            { icon: "🔀", title: "多后端路由", desc: "按模型名称自动路由到 OpenAI、Anthropic、Gemini 或 OpenRouter。", color: "#6366f1" },
            { icon: "📐", title: "多格式兼容", desc: "同时支持 OpenAI、Claude Messages、Gemini Native 三种请求格式，自动转换。", color: "#3b82f6" },
            { icon: "🔧", title: "工具 / 函数调用", desc: "完整支持 OpenAI tools + tool_calls，自动转换到各后端原生格式。", color: "#f59e0b" },
            { icon: "🧠", title: "扩展思考模式", desc: "Claude、Gemini、o-series 均支持 -thinking 和 -thinking-visible 后缀别名。", color: "#a855f7" },
            { icon: "🔑", title: "多种认证方式", desc: "支持 Bearer Token、x-goog-api-key 请求头、?key= URL 参数三种方式。", color: "#10b981" },
            { icon: "⚡", title: "流式输出 SSE", desc: "所有端点均支持 SSE 流式输出，包括 Claude 和 Gemini 原生格式端点。", color: "#f43f5e" },
          ].map((f) => (
            <div key={f.title} style={{
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: "10px", padding: "16px", borderTopColor: `${f.color}30`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                <span style={{ fontSize: "18px", width: "32px", height: "32px", background: `${f.color}15`, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center" }}>{f.icon}</span>
                <span style={{ fontWeight: 600, color: "#cbd5e1", fontSize: "13px" }}>{f.title}</span>
              </div>
              <p style={{ margin: 0, fontSize: "12.5px", color: "#475569", lineHeight: "1.6" }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Base URL */}
      <Card style={{ marginBottom: "14px" }}>
        <SectionTitle>Base URL</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <code style={{
            flex: 1, background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: "8px", padding: "10px 16px", fontFamily: "Menlo, monospace",
            fontSize: "14px", color: "#a78bfa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{displayUrl}</code>
          <CopyButton text={displayUrl} label="复制 URL" />
        </div>
        <div style={{ marginTop: "10px", display: "flex", gap: "8px", alignItems: "flex-start" }}>
          <span style={{
            fontSize: "10px", fontWeight: 700, color: "#fbbf24",
            background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.3)",
            borderRadius: "4px", padding: "1px 6px", flexShrink: 0, marginTop: "1px",
          }}>DEV</span>
          <p style={{ margin: 0, fontSize: "12.5px", color: "#475569", lineHeight: "1.6" }}>
            当前显示为开发预览地址。将本项目 <strong style={{ color: "#94a3b8" }}>Publish（发布）</strong> 后，请以生产环境域名（<code style={{ color: "#a78bfa", fontSize: "11.5px" }}>https://your-app.replit.app</code>）作为正式 Base URL 使用。
          </p>
        </div>
      </Card>

      {/* API Key + SillyTavern */}
      <Card>
        <SectionTitle>访问密码 & 设置</SectionTitle>
        <div style={{ marginBottom: "14px" }}>
          <label style={{ fontSize: "12px", color: "#64748b", display: "block", marginBottom: "6px" }}>API Key（PROXY_API_KEY）</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); localStorage.setItem("proxy_api_key", e.target.value); }}
            placeholder="输入你的 PROXY_API_KEY"
            style={{
              width: "100%", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: "8px", padding: "8px 12px", color: "#e2e8f0",
              fontFamily: "Menlo, monospace", fontSize: "13px", outline: "none", boxSizing: "border-box",
            }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, color: "#cbd5e1", fontSize: "13.5px", marginBottom: "3px" }}>SillyTavern 兼容模式</div>
            <p style={{ margin: 0, color: "#475569", fontSize: "12.5px", lineHeight: "1.5" }}>
              启用后对 Claude 自动追加空 user 消息，修复角色顺序要求。
            </p>
          </div>
          <button
            onClick={onToggleSTMode}
            disabled={stLoading || !apiKey}
            style={{
              width: "52px", height: "28px", borderRadius: "14px", border: "none",
              background: sillyTavernMode ? "#6366f1" : "rgba(255,255,255,0.12)",
              cursor: (stLoading || !apiKey) ? "not-allowed" : "pointer",
              position: "relative", transition: "background 0.2s", flexShrink: 0,
              opacity: (stLoading || !apiKey) ? 0.5 : 1,
            }}
          >
            <div style={{
              width: "22px", height: "22px", borderRadius: "50%", background: "#fff",
              position: "absolute", top: "3px", left: sillyTavernMode ? "27px" : "3px",
              transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            }} />
          </button>
        </div>
        <div style={{
          marginTop: "10px", padding: "7px 12px",
          background: sillyTavernMode ? "rgba(99,102,241,0.1)" : "rgba(255,255,255,0.03)",
          border: `1px solid ${sillyTavernMode ? "rgba(99,102,241,0.3)" : "rgba(255,255,255,0.06)"}`,
          borderRadius: "8px", fontSize: "12px",
          color: sillyTavernMode ? "#818cf8" : "#475569", fontWeight: 500, transition: "all 0.2s",
        }}>
          {sillyTavernMode ? '已启用 — 自动追加 {role:"user", content:"继续"} 给 Claude 模型' : "已禁用 — 消息原样发送"}
        </div>
      </Card>
    </>
  );
}

type BackendStat = { calls: number; errors: number; streamingCalls: number; promptTokens: number; completionTokens: number; totalTokens: number; avgDurationMs: number; avgTtftMs: number | null; health: string; url?: string; dynamic?: boolean; enabled?: boolean };
type ModelStat = { calls: number; promptTokens: number; completionTokens: number };

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-5.2": { input: 2.5, output: 10 },
  "gpt-5.1": { input: 2.5, output: 10 },
  "gpt-5": { input: 2.5, output: 10 },
  "gpt-5-mini": { input: 0.15, output: 0.6 },
  "gpt-5-nano": { input: 0.075, output: 0.3 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-4": { input: 30, output: 60 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3": { input: 10, output: 40 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o1": { input: 15, output: 60 },
  "o1-mini": { input: 3, output: 12 },
  "o1-pro": { input: 150, output: 600 },
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-opus-4-5": { input: 15, output: 75 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-opus": { input: 15, output: 75 },
  "claude-3-sonnet": { input: 3, output: 15 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
  "gemini-3.1-pro": { input: 1.25, output: 10 },
  "gemini-3-flash": { input: 0.15, output: 0.6 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.3 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-flash-8b": { input: 0.0375, output: 0.15 },
  "grok-4": { input: 3, output: 15 },
  "grok-4.1": { input: 3, output: 15 },
  "grok-4.20": { input: 3, output: 15 },
  "llama-4": { input: 0.2, output: 0.8 },
  "deepseek-v3": { input: 0.27, output: 1.1 },
  "deepseek-r1": { input: 0.55, output: 2.19 },
  "mistral-small": { input: 0.1, output: 0.3 },
  "qwen3": { input: 0.3, output: 1.2 },
  "command-a": { input: 2.5, output: 10 },
  "nova-premier": { input: 2.5, output: 10 },
  "ernie-4.5": { input: 1, output: 4 },
};

const DEFAULT_PRICING = { input: 3, output: 15 };

function getModelPrice(model: string): { input: number; output: number } {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const stripped = model.replace(/^[a-z0-9_-]+\//, "");
  if (MODEL_PRICING[stripped]) return MODEL_PRICING[stripped];
  const base = stripped.replace(/-(thinking-visible|thinking|latest|preview)$/g, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (MODEL_PRICING[base]) return MODEL_PRICING[base];
  for (const [key, val] of Object.entries(MODEL_PRICING)) {
    if (stripped.startsWith(key) || base.startsWith(key)) return val;
  }
  return DEFAULT_PRICING;
}

function estimateModelCost(model: string, prompt: number, completion: number): number {
  const p = getModelPrice(model);
  return (prompt * p.input + completion * p.output) / 1_000_000;
}

function PageStats({
  baseUrl, apiKey, stats, statsError, onRefresh,
  addUrl, setAddUrl, addState, addMsg, onAddBackend, onRemoveBackend,
  onToggleBackend, onBatchToggle, onBatchRemove,
  routing, onToggleRouting, modelStats,
}: {
  baseUrl: string;
  apiKey: string;
  stats: Record<string, BackendStat> | null;
  statsError: false | "auth" | "server";
  onRefresh: () => void;
  addUrl: string;
  setAddUrl: (u: string) => void;
  addState: "idle" | "loading" | "ok" | "err";
  addMsg: string;
  onAddBackend: (e: React.FormEvent) => void;
  onRemoveBackend: (label: string) => void;
  onToggleBackend: (label: string, enabled: boolean) => void;
  onBatchToggle: (labels: string[], enabled: boolean) => void;
  onBatchRemove: (labels: string[]) => void;
  routing: { localEnabled: boolean; localFallback: boolean; fakeStream: boolean };
  onToggleRouting: (field: "localEnabled" | "localFallback" | "fakeStream", value: boolean) => void;
  modelStats: Record<string, ModelStat> | null;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [envPromptCopied, setEnvPromptCopied] = useState(false);
  const [resetting, setResetting] = useState(false);

  const ENV_NODE_PROMPT =
    `请在当前 Replit 项目中添加一个环境变量，将子节点注册为永久 ENV 节点（Publish 后不会丢失）：\n\n` +
    `步骤 1：检查以下环境变量名，按顺序找到第一个尚未设置的空位：\n` +
    `   FRIEND_PROXY_URL → FRIEND_PROXY_URL_2 → FRIEND_PROXY_URL_3 → … → FRIEND_PROXY_URL_20\n` +
    `   （可在 Secrets 面板或 viewEnvVars() 中查看已占用的名称）\n\n` +
    `步骤 2：通过 Replit Secrets 面板为该空位添加 Secret，值填写子节点 Publish 后的站点地址：\n` +
    `   https://【填入你的子节点 Publish 后的站点】\n` +
    `   示例：https://my-proxy.replit.app\n\n` +
    `步骤 3：重启服务器（Shell 中执行重启，或点击 Replit Run 按钮）\n\n` +
    `说明：\n` +
    `• 地址只填根路径即可（无需加 /api），程序会自动补全\n` +
    `• 重启后该节点会立刻出现在统计页面，且 Publish 后仍然保留\n` +
    `• ENV 节点与动态节点共存，自动负载均衡`;

  const copyEnvPrompt = () => {
    navigator.clipboard.writeText(ENV_NODE_PROMPT).then(() => {
      setEnvPromptCopied(true);
      setTimeout(() => setEnvPromptCopied(false), 2000);
    });
  };

  const resetStats = () => {
    setResetting(true);
    fetch(`${baseUrl}/api/v1/admin/stats/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    }).then(() => { onRefresh(); setResetting(false); })
      .catch(() => setResetting(false));
  };

  const allSubNodes = stats
    ? Object.entries(stats).filter(([l]) => l !== "local")
    : [];
  const dynamicNodes = allSubNodes.filter(([, s]) => s.dynamic);

  const allSelected = allSubNodes.length > 0 && allSubNodes.every(([l]) => selected.has(l));
  const someSelected = selected.size > 0;

  const toggleSelect = (label: string) =>
    setSelected((prev) => { const s = new Set(prev); s.has(label) ? s.delete(label) : s.add(label); return s; });

  const toggleSelectAll = () =>
    setSelected(allSelected ? new Set() : new Set(allSubNodes.map(([l]) => l)));

  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toString();

  const totalModelCost = modelStats
    ? Object.entries(modelStats).reduce((sum, [model, ms]) => sum + estimateModelCost(model, ms.promptTokens, ms.completionTokens), 0)
    : null;

  const totalModelInputCost = modelStats
    ? Object.entries(modelStats).reduce((sum, [model, ms]) => sum + (ms.promptTokens * getModelPrice(model).input) / 1_000_000, 0)
    : null;

  const totalModelOutputCost = modelStats
    ? Object.entries(modelStats).reduce((sum, [model, ms]) => sum + (ms.completionTokens * getModelPrice(model).output) / 1_000_000, 0)
    : null;

  const estimateCostFallback = (prompt: number, completion: number) => {
    return (prompt * DEFAULT_PRICING.input + completion * DEFAULT_PRICING.output) / 1_000_000;
  };

  const totals = stats ? Object.values(stats).reduce((acc, s) => ({
    calls: acc.calls + s.calls,
    errors: acc.errors + s.errors,
    streamingCalls: acc.streamingCalls + (s.streamingCalls ?? 0),
    promptTokens: acc.promptTokens + s.promptTokens,
    completionTokens: acc.completionTokens + s.completionTokens,
    totalTokens: acc.totalTokens + s.totalTokens,
    totalDuration: acc.totalDuration + (s.avgDurationMs * s.calls),
    totalTtft: acc.totalTtft + ((s.avgTtftMs ?? 0) * (s.streamingCalls ?? 0)),
    totalStreamCalls: acc.totalStreamCalls + (s.streamingCalls ?? 0),
  }), { calls: 0, errors: 0, streamingCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalDuration: 0, totalTtft: 0, totalStreamCalls: 0 }) : null;

  const statCardStyle: React.CSSProperties = {
    background: "rgba(0,0,0,0.3)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: "12px",
    padding: "18px 20px",
  };

  const statLabelStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: "8px",
    fontSize: "13px", fontWeight: 600, color: "#94a3b8", marginBottom: "14px",
  };

  const bigNumStyle: React.CSSProperties = {
    fontSize: "26px", fontWeight: 700, fontFamily: "'JetBrains Mono', Menlo, monospace",
    letterSpacing: "-0.02em",
  };

  const subNumStyle: React.CSSProperties = {
    fontSize: "12px", color: "#475569", marginTop: "2px",
  };

  return (
    <>
      {/* Stats Panel Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: "4px", height: "20px", background: "linear-gradient(180deg, #6366f1, #8b5cf6)", borderRadius: "2px" }} />
          <span style={{ fontSize: "17px", fontWeight: 700, color: "#f1f5f9" }}>统计面板</span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={onRefresh} style={{
            padding: "6px 16px", borderRadius: "8px", fontSize: "12px", fontWeight: 600,
            background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
            color: "#94a3b8", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px",
          }}>&#8635; 刷新</button>
          <button onClick={resetStats} disabled={resetting || !apiKey} style={{
            padding: "6px 16px", borderRadius: "8px", fontSize: "12px", fontWeight: 600,
            background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
            color: "#f87171", cursor: (!apiKey || resetting) ? "not-allowed" : "pointer",
            opacity: (!apiKey || resetting) ? 0.5 : 1,
          }}>重置</button>
        </div>
      </div>

      {!apiKey ? (
        <Card><p style={{ margin: 0, fontSize: "13px", color: "#475569" }}>请先在首页填入 API Key 后查看统计。</p></Card>
      ) : statsError === "server" ? (
        <Card><p style={{ margin: 0, fontSize: "13px", color: "#f87171" }}>服务器未配置 PROXY_API_KEY — 请运行配置助手完成初始化。</p></Card>
      ) : statsError === "auth" ? (
        <Card>
          <div style={{ fontSize: "13px", color: "#f87171", lineHeight: "1.7" }}>
            <div style={{ fontWeight: 600, marginBottom: "6px" }}>认证失败（API Key 不匹配）</div>
            <div style={{ color: "#94a3b8", fontSize: "12.5px" }}>
              首页填入的 API Key 需与配置时设定的密码完全一致。
            </div>
            <div style={{ color: "#475569", fontSize: "12px", marginTop: "6px" }}>
              如果忘记了密码，请在 Replit 左侧边栏 <strong style={{ color: "#94a3b8" }}>&#128274; Secrets</strong> 面板中查看
              <code style={{ color: "#a78bfa", fontFamily: "Menlo, monospace", marginLeft: "4px" }}>PROXY_API_KEY</code>
              的值，也可以重新运行配置助手修改密码。
            </div>
          </div>
        </Card>
      ) : !stats ? (
        <Card><p style={{ margin: 0, fontSize: "13px", color: "#475569" }}>加载中...</p></Card>
      ) : (
        <>
          {/* 6 Summary Cards - 3x2 Grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "12px", marginBottom: "16px" }}>
            {/* 使用统计 */}
            <div style={statCardStyle}>
              <div style={statLabelStyle}>
                <span style={{ fontSize: "15px" }}>&#128202;</span>
                <span>使用统计</span>
              </div>
              <div style={{ display: "flex", gap: "24px" }}>
                <div>
                  <div style={subNumStyle}>请求次数</div>
                  <div style={{ ...bigNumStyle, color: "#818cf8" }}>{totals!.calls}</div>
                </div>
                <div>
                  <div style={subNumStyle}>流式请求</div>
                  <div style={{ ...bigNumStyle, color: "#3b82f6" }}>{totals!.streamingCalls}</div>
                </div>
              </div>
            </div>

            {/* Token 用量 */}
            <div style={statCardStyle}>
              <div style={statLabelStyle}>
                <span style={{ fontSize: "15px" }}>&#9889;</span>
                <span style={{ color: "#fbbf24" }}>Token 用量</span>
              </div>
              <div style={{ display: "flex", gap: "24px" }}>
                <div>
                  <div style={subNumStyle}>输入</div>
                  <div style={{ ...bigNumStyle, color: "#34d399" }}>{fmt(totals!.promptTokens)}</div>
                </div>
                <div>
                  <div style={subNumStyle}>输出</div>
                  <div style={{ ...bigNumStyle, color: "#34d399" }}>{fmt(totals!.completionTokens)}</div>
                </div>
              </div>
            </div>

            {/* 预估开销 */}
            <div style={statCardStyle}>
              <div style={statLabelStyle}>
                <span style={{ fontSize: "15px" }}>&#128176;</span>
                <span style={{ color: "#f59e0b" }}>预估开销</span>
                {totalModelCost !== null && <span style={{ fontSize: "10px", color: "#475569", marginLeft: "auto" }}>按模型定价</span>}
              </div>
              <div>
                <div style={subNumStyle}>总开销</div>
                <div style={{ ...bigNumStyle, color: "#f59e0b" }}>
                  ${(totalModelCost ?? estimateCostFallback(totals!.promptTokens, totals!.completionTokens)).toFixed(2)}
                </div>
                <div style={{ display: "flex", gap: "12px", marginTop: "4px" }}>
                  <span style={{ fontSize: "11px", color: "#475569" }}>输入 <span style={{ color: "#f59e0b" }}>${(totalModelInputCost ?? (totals!.promptTokens * DEFAULT_PRICING.input / 1_000_000)).toFixed(2)}</span></span>
                  <span style={{ fontSize: "11px", color: "#475569" }}>输出 <span style={{ color: "#f59e0b" }}>${(totalModelOutputCost ?? (totals!.completionTokens * DEFAULT_PRICING.output / 1_000_000)).toFixed(2)}</span></span>
                </div>
              </div>
            </div>

            {/* 成功率 */}
            <div style={statCardStyle}>
              <div style={statLabelStyle}>
                <span style={{ fontSize: "15px" }}>&#9989;</span>
                <span>成功率</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
                <div style={{ position: "relative", width: "52px", height: "52px" }}>
                  <svg width="52" height="52" viewBox="0 0 52 52">
                    <circle cx="26" cy="26" r="20" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
                    {totals!.calls > 0 && (
                      <circle cx="26" cy="26" r="20" fill="none" stroke="#4ade80" strokeWidth="5"
                        strokeDasharray={`${((totals!.calls - totals!.errors) / totals!.calls) * 125.6} 125.6`}
                        strokeLinecap="round" transform="rotate(-90 26 26)" />
                    )}
                  </svg>
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: 700, color: "#94a3b8" }}>
                    {totals!.calls > 0 ? `${Math.round(((totals!.calls - totals!.errors) / totals!.calls) * 100)}%` : "--"}
                  </div>
                </div>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                    <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#4ade80" }} />
                    <span style={{ fontSize: "12px", color: "#94a3b8" }}>成功 <strong style={{ color: "#e2e8f0" }}>{totals!.calls - totals!.errors}</strong></span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#f87171" }} />
                    <span style={{ fontSize: "12px", color: "#94a3b8" }}>失败 <strong style={{ color: "#e2e8f0" }}>{totals!.errors}</strong></span>
                  </div>
                </div>
              </div>
            </div>

            {/* 性能指标 */}
            <div style={statCardStyle}>
              <div style={statLabelStyle}>
                <span style={{ fontSize: "15px" }}>&#127919;</span>
                <span style={{ color: "#f43f5e" }}>性能指标</span>
              </div>
              <div style={{ display: "flex", gap: "24px" }}>
                <div>
                  <div style={subNumStyle}>平均耗时</div>
                  <div style={{ ...bigNumStyle, fontSize: "20px", color: "#e2e8f0" }}>
                    {totals!.calls > 0 ? `${Math.round(totals!.totalDuration / totals!.calls)}ms` : "--"}
                  </div>
                </div>
                <div>
                  <div style={subNumStyle}>平均 TTFT</div>
                  <div style={{ ...bigNumStyle, fontSize: "20px", color: "#e2e8f0" }}>
                    {totals!.totalStreamCalls > 0 ? `${Math.round(totals!.totalTtft / totals!.totalStreamCalls)}ms` : "--"}
                  </div>
                </div>
              </div>
            </div>

            {/* 按模型开销 */}
            <div style={statCardStyle}>
              <div style={statLabelStyle}>
                <span style={{ fontSize: "15px" }}>&#128221;</span>
                <span style={{ color: "#a78bfa" }}>按模型开销</span>
              </div>
              {(() => {
                if (!modelStats || Object.keys(modelStats).length === 0) {
                  return <div style={{ fontSize: "12px", color: "#475569" }}>暂无数据</div>;
                }
                const sorted = Object.entries(modelStats)
                  .filter(([, ms]) => ms.calls > 0)
                  .map(([model, ms]) => ({ model, cost: estimateModelCost(model, ms.promptTokens, ms.completionTokens), calls: ms.calls }))
                  .sort((a, b) => b.cost - a.cost);
                if (sorted.length === 0) return <div style={{ fontSize: "12px", color: "#475569" }}>暂无数据</div>;
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: "5px", maxHeight: "120px", overflowY: "auto" }}>
                    {sorted.map(({ model, cost, calls }) => (
                      <div key={model} style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", gap: "8px" }}>
                        <span style={{ color: "#94a3b8", fontFamily: "Menlo, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={model}>{model}</span>
                        <span style={{ color: "#475569", flexShrink: 0 }}>{calls}次</span>
                        <span style={{ color: "#f59e0b", fontWeight: 600, flexShrink: 0 }}>${cost.toFixed(4)}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Per-backend node cards */}
          <Card style={{ marginBottom: "14px" }}>
            <SectionTitle>节点统计</SectionTitle>
            {Object.entries(stats).length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 0" }}>
                <div style={{ fontSize: "40px", marginBottom: "8px", opacity: 0.3 }}>&#128172;</div>
                <div style={{ color: "#64748b", fontSize: "14px", fontWeight: 600 }}>暂无统计数据</div>
                <div style={{ color: "#475569", fontSize: "12px", marginTop: "4px" }}>发起 API 请求后统计将自动开始记录</div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {Object.entries(stats).map(([label, s]) => {
                  const isEnabled = s.enabled !== false;
                  const isHealthy = s.health === "healthy";
                  const cost = estimateCostFallback(s.promptTokens, s.completionTokens);
                  return (
                    <div key={label} style={{
                      background: isEnabled ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.35)",
                      border: `1px solid ${isEnabled ? "rgba(255,255,255,0.06)" : "rgba(248,113,113,0.15)"}`,
                      borderRadius: "10px", padding: "14px 16px",
                      opacity: isEnabled ? 1 : 0.6,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px", flexWrap: "wrap" }}>
                        <div style={{
                          width: "8px", height: "8px", borderRadius: "50%",
                          background: !isEnabled ? "#64748b" : isHealthy ? "#4ade80" : "#f87171",
                          boxShadow: (isEnabled && isHealthy) ? "0 0 6px #4ade80" : undefined,
                        }} />
                        <span style={{ fontSize: "13px", fontWeight: 700, color: isEnabled ? "#e2e8f0" : "#64748b", fontFamily: "'JetBrains Mono', Menlo, monospace" }}>{label}</span>
                        {s.dynamic && <span style={{ fontSize: "10px", color: "#a78bfa", background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.25)", borderRadius: "4px", padding: "1px 6px" }}>动态</span>}
                        {!isEnabled && <span style={{ fontSize: "10px", color: "#f87171", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)", borderRadius: "4px", padding: "1px 6px" }}>已禁用</span>}
                        {s.url && <span style={{ fontSize: "11px", color: "#334155", fontFamily: "Menlo, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{s.url}</span>}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))", gap: "12px" }}>
                        {[
                          { label: "请求", value: s.calls.toString(), color: "#818cf8" },
                          { label: "流式", value: (s.streamingCalls ?? 0).toString(), color: "#3b82f6" },
                          { label: "错误", value: s.errors.toString(), color: s.errors > 0 ? "#f87171" : "#4ade80" },
                          { label: "输入 Token", value: fmt(s.promptTokens), color: "#34d399" },
                          { label: "输出 Token", value: fmt(s.completionTokens), color: "#34d399" },
                          { label: "均耗时", value: s.calls > 0 ? `${s.avgDurationMs}ms` : "--", color: "#e2e8f0" },
                          { label: "首 Token", value: s.avgTtftMs ? `${s.avgTtftMs}ms` : "--", color: "#e2e8f0" },
                          { label: "开销", value: `$${cost.toFixed(2)}`, color: "#f59e0b" },
                        ].map((item) => (
                          <div key={item.label}>
                            <div style={{ fontSize: "10px", color: "#475569", marginBottom: "2px" }}>{item.label}</div>
                            <div style={{ fontSize: "14px", fontWeight: 600, color: item.color, fontFamily: "'JetBrains Mono', Menlo, monospace" }}>{item.value}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}

      {/* Routing Settings */}
      {apiKey && (
        <Card style={{ marginBottom: "14px" }}>
          <SectionTitle>路由策略</SectionTitle>
          <p style={{ margin: "0 0 12px", fontSize: "12px", color: "#475569" }}>控制本地账号（主号）的调用行为。子节点始终优先。</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {([
              { field: "localEnabled" as const, label: "启用本地账号", desc: "关闭后，本地账号完全停用，所有请求只走子节点" },
              { field: "localFallback" as const, label: "主号兜底", desc: "关闭后，即使所有子节点离线也不会调用本地账号（返回 503）" },
              { field: "fakeStream" as const, label: "假流式", desc: "开启后，当后端不支持或流式失败时，将完整响应模拟为 SSE 流式输出" },
            ]).map(({ field, label, desc }) => (
              <div key={field} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: "8px", padding: "10px 14px",
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "#94a3b8" }}>{label}</div>
                  <div style={{ fontSize: "11px", color: "#475569", marginTop: "2px" }}>{desc}</div>
                </div>
                <button
                  onClick={() => onToggleRouting(field, !routing[field])}
                  style={{
                    width: "40px", height: "22px", borderRadius: "11px", border: "none", cursor: "pointer",
                    background: routing[field] ? "#6366f1" : "rgba(255,255,255,0.1)",
                    position: "relative", transition: "background 0.2s", flexShrink: 0, marginLeft: "12px",
                  }}
                >
                  <div style={{
                    width: "16px", height: "16px", borderRadius: "50%", background: "#fff",
                    position: "absolute", top: "3px",
                    left: routing[field] ? "21px" : "3px",
                    transition: "left 0.2s",
                  }} />
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Add Node */}
      <Card>
        <SectionTitle>添加节点</SectionTitle>
        <p style={{ margin: "0 0 12px", fontSize: "12.5px", color: "#475569" }}>即时生效，无需重启或重新发布。节点间自动负载均衡。</p>

        {!apiKey ? (
          <p style={{ margin: 0, fontSize: "13px", color: "#475569" }}>请先在首页填入 API Key 后操作。</p>
        ) : (
          <>
            <form onSubmit={onAddBackend} style={{ display: "flex", gap: "8px" }}>
              <input
                type="url"
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                placeholder="https://friend-proxy.replit.app"
                style={{
                  flex: 1, background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: "8px", padding: "8px 12px", color: "#e2e8f0",
                  fontFamily: "Menlo, monospace", fontSize: "13px", outline: "none",
                }}
              />
              <button type="submit" disabled={addState === "loading"} style={{
                background: addState === "loading" ? "rgba(99,102,241,0.4)" : "rgba(99,102,241,0.7)",
                border: "1px solid rgba(99,102,241,0.6)", color: "#e0e7ff",
                borderRadius: "8px", padding: "8px 18px", fontSize: "13px",
                fontWeight: 600, cursor: addState === "loading" ? "not-allowed" : "pointer",
                flexShrink: 0,
              }}>{addState === "loading" ? "添加中…" : "添加节点"}</button>
            </form>

            {/* ENV node via Replit Agent */}
            <div style={{ marginTop: "14px", borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: "14px" }}>
              <div style={{ fontSize: "12.5px", color: "#94a3b8", fontWeight: 600, marginBottom: "6px" }}>
                通过环境变量添加（永久节点）
              </div>
              <div style={{ fontSize: "11.5px", color: "#475569", lineHeight: "1.5", marginBottom: "8px" }}>
                ENV 节点写入 Secrets，Publish 后不会丢失。将下方内容发给 Replit Agent 即可自动完成配置。
              </div>
              {/* Copyable prompt block */}
              <div
                style={{
                  background: "rgba(0,0,0,0.35)",
                  border: "1px solid rgba(99,102,241,0.3)",
                  borderRadius: "8px",
                  padding: "10px 12px",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "10px",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    color: "#a5b4fc",
                    fontSize: "12px",
                    fontFamily: "Menlo, Consolas, monospace",
                    lineHeight: "1.6",
                    whiteSpace: "pre-wrap",
                    userSelect: "all",
                    wordBreak: "break-all",
                  }}
                >
                  {ENV_NODE_PROMPT}
                </span>
                <button
                  onClick={copyEnvPrompt}
                  title="复制"
                  style={{
                    flexShrink: 0,
                    background: envPromptCopied ? "rgba(74,222,128,0.12)" : "rgba(99,102,241,0.1)",
                    border: `1px solid ${envPromptCopied ? "rgba(74,222,128,0.4)" : "rgba(99,102,241,0.25)"}`,
                    borderRadius: "6px",
                    padding: "4px 10px",
                    color: envPromptCopied ? "#4ade80" : "#a78bfa",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: "pointer",
                    transition: "all 0.2s",
                    whiteSpace: "nowrap",
                  }}
                >
                  {envPromptCopied ? "✓ 已复制" : "📋 复制"}
                </button>
              </div>
            </div>
            {(() => {
              const raw = addUrl.trim();
              const normed = normalizeBackendUrl(raw);
              return raw && normed !== raw.replace(/\/+$/, "") ? (
                <p style={{ margin: "6px 0 0", fontSize: "11.5px", color: "#94a3b8" }}>
                  将保存为：<code style={{ color: "#a78bfa", fontFamily: "Menlo, monospace" }}>{normed}</code>
                </p>
              ) : null;
            })()}
            {addState === "ok" && <p style={{ margin: "8px 0 0", fontSize: "12px", color: "#4ade80" }}>{addMsg}</p>}
            {addState === "err" && <p style={{ margin: "8px 0 0", fontSize: "12px", color: "#f87171" }}>{addMsg}</p>}

            {allSubNodes.length > 0 && (
              <div style={{ marginTop: "14px" }}>
                {/* 标题行 + 全选 + 批量操作 */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
                  {/* 全选复选框 */}
                  <label style={{ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", userSelect: "none" }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
                      onChange={toggleSelectAll}
                      style={{ accentColor: "#818cf8", width: "14px", height: "14px", cursor: "pointer" }}
                    />
                    <span style={{ fontSize: "11px", color: "#475569" }}>
                      {allSelected ? "取消全选" : "全选"}
                      {someSelected && !allSelected ? `（已选 ${selected.size} / ${allSubNodes.length}）` : `（共 ${allSubNodes.length} 个节点）`}
                    </span>
                  </label>

                  {/* 批量操作按钮（有选中时显示） */}
                  {someSelected && (
                    <>
                      <button
                        onClick={() => { onBatchToggle([...selected], true); setSelected(new Set()); }}
                        style={{ padding: "2px 10px", borderRadius: "5px", fontSize: "11px", border: "1px solid rgba(74,222,128,0.3)", background: "rgba(74,222,128,0.08)", color: "#4ade80", cursor: "pointer" }}
                      >启用选中</button>
                      <button
                        onClick={() => { onBatchToggle([...selected], false); setSelected(new Set()); }}
                        style={{ padding: "2px 10px", borderRadius: "5px", fontSize: "11px", border: "1px solid rgba(251,191,36,0.3)", background: "rgba(251,191,36,0.08)", color: "#fbbf24", cursor: "pointer" }}
                      >禁用选中</button>
                      {/* 移除仅针对动态节点 */}
                      {[...selected].some((l) => dynamicNodes.find(([dl]) => dl === l)) && (
                        <button
                          onClick={() => {
                            const dynamicSelected = [...selected].filter((l) => dynamicNodes.find(([dl]) => dl === l));
                            onBatchRemove(dynamicSelected);
                            setSelected(new Set());
                          }}
                          style={{ padding: "2px 10px", borderRadius: "5px", fontSize: "11px", border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.08)", color: "#f87171", cursor: "pointer" }}
                        >移除动态节点</button>
                      )}
                    </>
                  )}
                </div>

                {/* 节点列表 */}
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  {allSubNodes.map(([label, s]) => {
                    const isEnabled = s.enabled !== false;
                    const isChecked = selected.has(label);
                    const isDynamic = !!s.dynamic;
                    return (
                      <div
                        key={label}
                        onClick={() => toggleSelect(label)}
                        style={{
                          display: "flex", alignItems: "center", gap: "8px",
                          background: isChecked ? "rgba(99,102,241,0.1)" : "rgba(0,0,0,0.2)",
                          border: `1px solid ${isChecked ? "rgba(99,102,241,0.35)" : "rgba(255,255,255,0.05)"}`,
                          borderRadius: "7px", padding: "8px 12px",
                          cursor: "pointer", transition: "all 0.15s",
                          opacity: isEnabled ? 1 : 0.5,
                        }}
                      >
                        {/* 复选框 */}
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelect(label)}
                          onClick={(e) => e.stopPropagation()}
                          style={{ accentColor: "#818cf8", width: "14px", height: "14px", cursor: "pointer", flexShrink: 0 }}
                        />

                        {/* 健康状态点 */}
                        <div style={{ width: "6px", height: "6px", borderRadius: "50%", flexShrink: 0,
                          background: isEnabled ? (s.health === "healthy" ? "#4ade80" : "#f87171") : "#475569" }} />

                        {/* 类型标签 */}
                        {!isDynamic && (
                          <span style={{ fontSize: "10px", color: "#64748b", background: "rgba(100,116,139,0.1)", border: "1px solid rgba(100,116,139,0.2)", borderRadius: "4px", padding: "1px 5px", flexShrink: 0 }}>ENV</span>
                        )}

                        {/* URL / label */}
                        <span style={{ flex: 1, fontSize: "12px", color: isEnabled ? "#94a3b8" : "#475569", fontFamily: "Menlo, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {s.url ?? label}
                        </span>

                        {/* 禁用标签 */}
                        {!isEnabled && (
                          <span style={{ fontSize: "10px", color: "#64748b", background: "rgba(100,116,139,0.15)", border: "1px solid rgba(100,116,139,0.3)", borderRadius: "4px", padding: "1px 6px", flexShrink: 0 }}>已禁用</span>
                        )}

                        <span style={{ fontSize: "11px", color: "#475569", flexShrink: 0 }}>{s.calls} 次</span>

                        {/* 单个启用/禁用 */}
                        <button
                          onClick={(e) => { e.stopPropagation(); onToggleBackend(label, !isEnabled); }}
                          style={{ background: "none", border: `1px solid ${isEnabled ? "rgba(251,191,36,0.3)" : "rgba(74,222,128,0.3)"}`, borderRadius: "4px", color: isEnabled ? "#fbbf24" : "#4ade80", fontSize: "11px", cursor: "pointer", padding: "1px 7px", flexShrink: 0 }}
                        >
                          {isEnabled ? "禁用" : "启用"}
                        </button>

                        {/* 移除仅动态节点可用 */}
                        {isDynamic && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onRemoveBackend(label); }}
                            style={{ background: "none", border: "none", color: "#f87171", fontSize: "13px", cursor: "pointer", padding: "0 2px", flexShrink: 0, lineHeight: 1 }}
                          >×</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <FleetManager />
    </>
  );
}

// ---------------------------------------------------------------------------
// UpdateBar — 全局顶部更新通知条（自动检测，有更新时展示）
// ---------------------------------------------------------------------------

function UpdateBar({ baseUrl, apiKey: _apiKey }: { baseUrl: string; apiKey: string }) {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [latestVer, setLatestVer] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    try {
      const r = await fetch(`${baseUrl}/api/update/version`);
      if (!r.ok) return;
      const d = await r.json();
      setHasUpdate(!!d.hasUpdate);
      setLatestVer(d.latestVersion ?? "");
      setReleaseNotes(d.latestReleaseNotes ?? "");
    } catch {}
  }, [baseUrl]);

  useEffect(() => {
    check();
    const t = setInterval(check, 10 * 60 * 1000);
    return () => clearInterval(t);
  }, [check]);

  const buildPrompt = (ver: string) =>
    `请帮我把 AI 网关更新到最新版本 ${ver}。\n` +
    `从 GitHub 仓库 https://github.com/Akatsuki03/Replit2Api 拉取最新代码，覆盖当前项目文件（无需保留原文件），` +
    `然后运行 pnpm install，最后重启 "artifacts/api-server: API Server" 和 "artifacts/api-portal: web" 两个工作流。`;

  const copyPrompt = async () => {
    const text = buildPrompt(latestVer);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement("textarea");
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const recheck = async () => {
    setChecking(true);
    await check();
    setChecking(false);
  };

  if (dismissed || !hasUpdate) return null;

  return (
    <div style={{
      position: "sticky", top: 0, zIndex: 1000,
      background: "rgba(251,191,36,0.1)",
      borderBottom: "1px solid rgba(251,191,36,0.3)",
      backdropFilter: "blur(12px)",
    }}>
      <div style={{
        maxWidth: "900px", margin: "0 auto", padding: "10px 24px",
        display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap",
      }}>
        <span style={{ fontSize: "16px", flexShrink: 0 }}>🎉</span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: "13px", color: "#fbbf24" }}>
            <strong>发现新版本 v{latestVer}</strong>
            {releaseNotes && <span style={{ color: "#92400e", marginLeft: "10px", fontSize: "12px" }}>{releaseNotes}</span>}
          </span>
        </div>

        {/* 复制提示词 — 粘贴给 Replit Agent 完成更新 */}
        <button
          onClick={copyPrompt}
          style={{
            padding: "5px 14px", borderRadius: "7px", fontSize: "12.5px", fontWeight: 700,
            border: `1px solid ${copied ? "rgba(74,222,128,0.5)" : "rgba(251,191,36,0.5)"}`,
            background: copied ? "rgba(74,222,128,0.15)" : "rgba(251,191,36,0.18)",
            color: copied ? "#4ade80" : "#fbbf24",
            cursor: "pointer", flexShrink: 0, transition: "all 0.2s",
          }}
        >
          {copied ? "✓ 已复制！粘贴给 Agent" : "📋 复制更新提示词"}
        </button>

        <button
          onClick={recheck}
          disabled={checking}
          style={{
            padding: "5px 10px", borderRadius: "7px", fontSize: "12px",
            border: "1px solid rgba(251,191,36,0.25)",
            background: "transparent", color: "#92400e",
            cursor: checking ? "not-allowed" : "pointer", flexShrink: 0,
            opacity: checking ? 0.5 : 1,
          }}
        >
          {checking ? "检测中…" : "重新检测"}
        </button>

        <button
          onClick={() => setDismissed(true)}
          style={{ background: "none", border: "none", color: "#92400e", fontSize: "18px", cursor: "pointer", flexShrink: 0, lineHeight: 1 }}
        >×</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fleet Manager
// 上游版本检测地址改为 GitHub raw，子节点从 GitHub 拉取更新，无需上游 Replit 在线
// ---------------------------------------------------------------------------

const _UPSTREAM_VER_URL = "https://raw.githubusercontent.com/Akatsuki03/Replit2Api/main/version.json";

interface FleetInstance {
  id: string;
  name: string;
  url: string;
  key: string;
  status: "unknown" | "checking" | "ok" | "updating" | "error" | "restarting";
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  lastChecked: number | null;
  updateLog: string | null;
}

const FLEET_STORE_KEY = "fleet_instances_v2";

function loadFleet(): FleetInstance[] {
  try { return JSON.parse(localStorage.getItem(FLEET_STORE_KEY) ?? "[]") as FleetInstance[]; }
  catch { return []; }
}
function saveFleet(data: FleetInstance[]) {
  localStorage.setItem(FLEET_STORE_KEY, JSON.stringify(data));
}
function genId() { return Math.random().toString(36).slice(2, 9); }

// Normalize user-supplied URL to the correct backend endpoint.
// Expected format: https://{project}.replit.app/api
function normalizeBackendUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, "");
  if (!url) return url;
  return /\/api$/i.test(url) ? url : url + "/api";
}

function FleetManager() {
  const [instances, setInstances] = useState<FleetInstance[]>(() => loadFleet());
  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addKey, setAddKey] = useState("");
  const [logTarget, setLogTarget] = useState<string | null>(null);

  const persist = (next: FleetInstance[]) => { setInstances(next); saveFleet(next); };

  const addInst = () => {
    const url = addUrl.trim().replace(/\/+$/, "");
    const key = addKey.trim();
    if (!url || !key) return;
    const inst: FleetInstance = {
      id: genId(), name: addName.trim() || url, url, key,
      status: "unknown", version: null, latestVersion: null,
      updateAvailable: false, lastChecked: null, updateLog: null,
    };
    const next = [...instances, inst];
    persist(next);
    setAddName(""); setAddUrl(""); setAddKey("");
  };

  const removeInst = (id: string) => persist(instances.filter((i) => i.id !== id));

  const patchInst = (id: string, patch: Partial<FleetInstance>) => {
    const next = instances.map((i) => i.id === id ? { ...i, ...patch } : i);
    persist(next); return next;
  };

  const checkOne = async (id: string) => {
    const inst = instances.find((i) => i.id === id);
    if (!inst) return;
    patchInst(id, { status: "checking" });
    try {
      const r = await fetch(`${inst.url}/api/update/version`, {
        headers: { Authorization: `Bearer ${inst.key}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { version?: string; hasUpdate?: boolean; latestVersion?: string };
      patchInst(id, {
        status: "ok",
        version: d.version ?? null,
        latestVersion: d.latestVersion ?? null,
        updateAvailable: d.hasUpdate ?? false,
        lastChecked: Date.now(),
      });
    } catch {
      patchInst(id, { status: "error", lastChecked: Date.now() });
    }
  };

  const checkAll = async () => {
    await Promise.all(instances.map((i) => checkOne(i.id)));
  };

  const updateOne = async (id: string) => {
    const inst = instances.find((i) => i.id === id);
    if (!inst) return;
    patchInst(id, { status: "updating", updateLog: null });
    try {
      const r = await fetch(`${inst.url}/api/update/apply`, {
        method: "POST",
        headers: { Authorization: `Bearer ${inst.key}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(60000),
      });
      const d = await r.json() as { status?: string; message?: string };
      const logMsg = d.message ?? (r.ok ? "更新指令已发送，服务器将自动重启。" : "更新请求失败。");
      patchInst(id, {
        status: r.ok ? "restarting" : "error",
        updateLog: logMsg,
        lastChecked: Date.now(),
      });
      setLogTarget(id);
    } catch (e) {
      patchInst(id, { status: "error", updateLog: `错误: ${(e as Error).message}`, lastChecked: Date.now() });
      setLogTarget(id);
    }
  };

  const updateAll = async () => {
    const toUpdate = instances.filter((i) => i.updateAvailable);
    if (!toUpdate.length) return;
    for (const inst of toUpdate) await updateOne(inst.id);
  };

  const exportJson = () => {
    const data = instances.map(({ name, url, key }) => ({ name, url, key }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "fleet.json";
    a.click();
  };

  const importJson = () => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".json,application/json";
    input.onchange = async (e) => {
      try {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        const arr = JSON.parse(await file.text()) as Array<{ name?: string; url?: string; key?: string }>;
        let added = 0;
        const next = [...instances];
        for (const item of arr) {
          if (!item.url || !item.key) continue;
          if (next.some((i) => i.url === item.url)) continue;
          next.push({
            id: genId(), name: item.name || item.url,
            url: item.url.replace(/\/+$/, ""), key: item.key,
            status: "unknown", version: null, latestVersion: null,
            updateAvailable: false, lastChecked: null, updateLog: null,
          });
          added++;
        }
        persist(next);
        if (added === 0) alert("没有新节点被导入（URL 重复或格式错误）");
      } catch (err) { alert(`导入失败: ${(err as Error).message}`); }
    };
    input.click();
  };

  const statusTag = (inst: FleetInstance) => {
    if (inst.status === "checking") return { label: "检测中", color: "#94a3b8", bg: "rgba(148,163,184,0.12)" };
    if (inst.status === "updating") return { label: "更新中", color: "#fbbf24", bg: "rgba(251,191,36,0.12)" };
    if (inst.status === "restarting") return { label: "重启中", color: "#818cf8", bg: "rgba(129,140,248,0.12)" };
    if (inst.status === "error") return { label: "连接失败", color: "#f87171", bg: "rgba(248,113,113,0.12)" };
    if (inst.status === "ok") {
      if (inst.updateAvailable) return { label: `有新版本 v${inst.latestVersion ?? ""}`, color: "#fbbf24", bg: "rgba(251,191,36,0.12)" };
      return { label: "已是最新", color: "#4ade80", bg: "rgba(74,222,128,0.12)" };
    }
    return { label: "未检测", color: "#475569", bg: "rgba(71,85,105,0.12)" };
  };

  const hasUpdates = instances.some((i) => i.updateAvailable);
  const logInst = instances.find((i) => i.id === logTarget);

  const inp: React.CSSProperties = {
    background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "7px", padding: "7px 11px", color: "#e2e8f0",
    fontFamily: "Menlo, monospace", fontSize: "12.5px", outline: "none",
  };

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <SectionTitle>子节点管理</SectionTitle>
        <div style={{ display: "flex", gap: "6px", marginTop: "-16px" }}>
          <button onClick={importJson} style={{ background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "6px", color: "#64748b", fontSize: "11px", padding: "4px 10px", cursor: "pointer" }}>导入 JSON</button>
          <button onClick={exportJson} style={{ background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "6px", color: "#64748b", fontSize: "11px", padding: "4px 10px", cursor: "pointer" }}>导出 JSON</button>
          <button onClick={checkAll} disabled={instances.length === 0} style={{ background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "6px", color: "#94a3b8", fontSize: "11px", padding: "4px 10px", cursor: "pointer" }}>全部检测</button>
          {hasUpdates && (
            <button onClick={updateAll} style={{ background: "rgba(251,191,36,0.15)", border: "1px solid rgba(251,191,36,0.35)", borderRadius: "6px", color: "#fbbf24", fontSize: "11px", padding: "4px 10px", cursor: "pointer", fontWeight: 600 }}>全部更新</button>
          )}
        </div>
      </div>
      <p style={{ margin: "0 0 14px", fontSize: "12.5px", color: "#475569" }}>管理多个部署实例 · 数据保存在本地浏览器</p>

      {/* Add form */}
      <div style={{ marginBottom: "14px" }}>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <input style={{ ...inp, flex: "0 0 110px" }} placeholder="名称" value={addName} onChange={(e) => setAddName(e.target.value)} />
          <input style={{ ...inp, flex: "2 1 180px" }} placeholder="https://your-proxy.replit.app（根地址）" value={addUrl} onChange={(e) => setAddUrl(e.target.value)} />
          <input type="password" style={{ ...inp, flex: "1 1 130px" }} placeholder="PROXY_API_KEY" value={addKey} onChange={(e) => setAddKey(e.target.value)} />
          <button onClick={addInst} disabled={!addUrl || !addKey} style={{
            background: "rgba(99,102,241,0.7)", border: "1px solid rgba(99,102,241,0.6)",
            color: "#e0e7ff", borderRadius: "7px", padding: "7px 16px",
            fontSize: "13px", fontWeight: 600, cursor: (!addUrl || !addKey) ? "not-allowed" : "pointer",
            opacity: (!addUrl || !addKey) ? 0.5 : 1, flexShrink: 0,
          }}>添加</button>
        </div>
      </div>

      {/* Table */}
      {instances.length === 0 ? (
        <div style={{ textAlign: "center", padding: "24px 0", color: "#334155", fontSize: "13px" }}>暂无节点，请在上方添加</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {instances.map((inst) => {
            const tag = statusTag(inst);
            const busy = inst.status === "checking" || inst.status === "updating";
            const timeStr = inst.lastChecked ? new Date(inst.lastChecked).toLocaleTimeString() : null;
            return (
              <div key={inst.id} style={{ background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "9px", padding: "11px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  {/* Dot */}
                  <div style={{ width: "7px", height: "7px", borderRadius: "50%", background: tag.color, flexShrink: 0 }} />
                  {/* Name */}
                  <span style={{ fontSize: "13px", fontWeight: 600, color: "#cbd5e1", minWidth: "80px" }}>{inst.name}</span>
                  {/* URL (truncated) */}
                  <span style={{ fontSize: "11px", color: "#334155", fontFamily: "Menlo, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, maxWidth: "240px" }}>{inst.url}</span>
                  {/* Version */}
                  {inst.version && (
                    <span style={{ fontSize: "11px", color: "#64748b", fontFamily: "Menlo, monospace", flexShrink: 0 }}>v{inst.version}</span>
                  )}
                  {/* Status badge */}
                  <span style={{ fontSize: "11px", fontWeight: 600, color: tag.color, background: tag.bg, borderRadius: "99px", padding: "2px 9px", flexShrink: 0 }}>{tag.label}</span>
                  {/* Time */}
                  {timeStr && <span style={{ fontSize: "10px", color: "#334155", flexShrink: 0 }}>{timeStr}</span>}
                  {/* Actions */}
                  <div style={{ display: "flex", gap: "5px", flexShrink: 0, marginLeft: "auto" }}>
                    <button onClick={() => checkOne(inst.id)} disabled={busy} style={{ background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "5px", color: "#94a3b8", fontSize: "11px", padding: "3px 9px", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.4 : 1 }}>检测</button>
                    <button onClick={() => updateOne(inst.id)} disabled={busy} style={{ background: inst.updateAvailable ? "rgba(251,191,36,0.12)" : "none", border: `1px solid ${inst.updateAvailable ? "rgba(251,191,36,0.4)" : "rgba(255,255,255,0.1)"}`, borderRadius: "5px", color: inst.updateAvailable ? "#fbbf24" : "#64748b", fontSize: "11px", padding: "3px 9px", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.4 : 1 }}>更新</button>
                    {inst.updateLog && (
                      <button onClick={() => setLogTarget(logTarget === inst.id ? null : inst.id)} style={{ background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "5px", color: "#475569", fontSize: "11px", padding: "3px 9px", cursor: "pointer" }}>日志</button>
                    )}
                    <button onClick={() => removeInst(inst.id)} style={{ background: "none", border: "1px solid rgba(248,113,113,0.3)", borderRadius: "5px", color: "#f87171", fontSize: "11px", padding: "3px 9px", cursor: "pointer" }}>删除</button>
                  </div>
                </div>
                {/* Log */}
                {logTarget === inst.id && logInst?.updateLog && (
                  <div style={{ marginTop: "10px", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "6px", padding: "10px 14px", fontFamily: "Menlo, monospace", fontSize: "12px", color: "#4ade80", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                    {logInst.updateLog}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function PageEndpoints({ displayUrl, expandedGroups, onToggleGroup, totalModels }: {
  displayUrl: string;
  expandedGroups: Record<string, boolean>;
  onToggleGroup: (g: string) => void;
  totalModels: number;
}) {
  return (
    <>
      {/* Endpoint list */}
      <Card style={{ marginBottom: "14px" }}>
        <SectionTitle>API 端点列表</SectionTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {([
            { method: "GET", path: "/v1/models", desc: "列出所有可用模型" },
            { method: "POST", path: "/v1/chat/completions", desc: "OpenAI 格式补全（支持工具调用 + 流式）" },
            { method: "POST", path: "/v1/messages", desc: "Claude Messages 原生格式（所有后端均支持）" },
            { method: "POST", path: "/v1/models/:model:generateContent", desc: "Gemini 原生格式（非流式）" },
            { method: "POST", path: "/v1/models/:model:streamGenerateContent", desc: "Gemini 原生格式（流式 SSE）" },
            { method: "GET", path: "/v1/stats", desc: "查看各后端用量统计（需 API Key）" },
            { method: "GET", path: "/v1/admin/backends", desc: "列出所有后端节点（需 API Key）" },
            { method: "POST", path: "/v1/admin/backends", desc: "动态添加新节点（需 API Key）" },
            { method: "DELETE", path: "/v1/admin/backends/:label", desc: "移除动态节点（需 API Key）" },
          ] as { method: "GET" | "POST" | "DELETE"; path: string; desc: string }[]).map((ep) => (
            <div key={`${ep.method}:${ep.path}`} style={{
              display: "flex", alignItems: "center", gap: "10px",
              background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: "8px", padding: "10px 14px",
            }}>
              <MethodBadge method={ep.method as "GET" | "POST"} />
              <code style={{ color: "#e2e8f0", fontFamily: "Menlo, monospace", fontSize: "12.5px", flex: 1 }}>{ep.path}</code>
              <span style={{ color: "#475569", fontSize: "12px", flexShrink: 0, maxWidth: "260px", textAlign: "right" }}>{ep.desc}</span>
              <CopyButton text={`${displayUrl}${ep.path}`} />
            </div>
          ))}
        </div>
      </Card>

      {/* Auth */}
      <Card style={{ marginBottom: "14px" }}>
        <SectionTitle>认证方式（三选一）</SectionTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {[
            { label: "Bearer Token（推荐，兼容所有 OpenAI 客户端）", code: `Authorization: Bearer YOUR_PROXY_API_KEY` },
            { label: "x-goog-api-key Header（兼容 Gemini 格式客户端）", code: `x-goog-api-key: YOUR_PROXY_API_KEY` },
            { label: "URL 查询参数（适合简单调试）", code: `${displayUrl}/v1/models?key=YOUR_PROXY_API_KEY` },
          ].map((auth) => (
            <div key={auth.label}>
              <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "4px" }}>{auth.label}</div>
              <CodeBlock code={auth.code} />
            </div>
          ))}
        </div>
      </Card>

      {/* Tool Calling */}
      <Card style={{ marginBottom: "14px" }}>
        <SectionTitle>工具 / 函数调用示例</SectionTitle>
        <p style={{ margin: "0 0 12px", color: "#64748b", fontSize: "13px", lineHeight: "1.6" }}>
          使用 OpenAI 标准 <code style={{ color: "#a78bfa", background: "rgba(167,139,250,0.1)", padding: "1px 5px", borderRadius: "4px" }}>tools</code> 格式，代理自动转换到各后端格式。
        </p>
        <CodeBlock
          code={`curl ${displayUrl}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4.1-mini",
    "messages": [{"role": "user", "content": "北京天气怎么样?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
          "type": "object",
          "properties": { "city": {"type": "string"} },
          "required": ["city"]
        }
      }
    }],
    "tool_choice": "auto"
  }'`}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "12px" }}>
          {["OpenAI ✓ pass-through", "Anthropic ✓ tool_use 转换", "Gemini ✓ functionDeclarations 转换", "OpenRouter ✓ pass-through"].map((s) => (
            <span key={s} style={{
              fontSize: "11px", color: "#4ade80", background: "rgba(74,222,128,0.08)",
              border: "1px solid rgba(74,222,128,0.2)", borderRadius: "5px", padding: "3px 8px",
            }}>{s}</span>
          ))}
        </div>
      </Card>

      {/* Quick Test */}
      <Card style={{ marginBottom: "14px" }}>
        <SectionTitle>快速测试</SectionTitle>
        <CodeBlock
          code={`curl ${displayUrl}/v1/models \\
  -H "Authorization: Bearer YOUR_PROXY_API_KEY"`}
          copyText={`curl ${displayUrl}/v1/models \\\n  -H "Authorization: Bearer YOUR_PROXY_API_KEY"`}
        />
        <div style={{ marginTop: "14px" }}>
          <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "8px" }}>流式输出测试：</div>
          <CodeBlock
            code={`curl ${displayUrl}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"Hello!"}],"stream":true}'`}
          />
        </div>
      </Card>

      {/* Models */}
      <Card style={{ marginBottom: "14px" }}>
        <SectionTitle>可用模型（{totalModels} 个）</SectionTitle>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginBottom: "14px" }}>
          {(["thinking", "thinking-visible", "tools", "reasoning"] as const).map((v) => (
            <div key={v} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <Badge variant={v} />
              <span style={{ fontSize: "11px", color: "#475569" }}>
                {v === "thinking" ? "扩展思考（隐藏）" : v === "thinking-visible" ? "扩展思考（可见）" : v === "tools" ? "支持工具调用" : "原生推理"}
              </span>
            </div>
          ))}
        </div>
        <ModelGroup title="OpenAI" models={OPENAI_MODELS} provider="openai" expanded={expandedGroups.openai} onToggle={() => onToggleGroup("openai")} />
        <ModelGroup title="Anthropic Claude" models={ANTHROPIC_MODELS} provider="anthropic" expanded={expandedGroups.anthropic} onToggle={() => onToggleGroup("anthropic")} />
        <ModelGroup title="Google Gemini" models={GEMINI_MODELS} provider="gemini" expanded={expandedGroups.gemini} onToggle={() => onToggleGroup("gemini")} />
        <ModelGroup title="OpenRouter（任意 provider/model 均可路由）" models={OPENROUTER_MODELS} provider="openrouter" expanded={expandedGroups.openrouter} onToggle={() => onToggleGroup("openrouter")} />
        <p style={{ margin: "10px 0 0", fontSize: "12px", color: "#334155", lineHeight: "1.5" }}>
          💡 任何包含 <code style={{ color: "#a78bfa" }}>/</code> 的模型名均自动路由到 OpenRouter，不限于上方列表。
        </p>
      </Card>

      {/* CherryStudio Guide */}
      <Card>
        <SectionTitle>CherryStudio 接入指南</SectionTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {[
            { step: 1, title: "打开设置 → 模型服务商", desc: "在 CherryStudio 中，点击左侧设置，选择「模型服务商」。" },
            { step: 2, title: "新增服务商，类型选「OpenAI Compatible」", desc: "点击「添加服务商」，类型选「OpenAI 兼容」（不要选 OpenAI 原生）。" },
            {
              step: 3, title: "填写 Base URL 和 API Key",
              desc: (
                <span>
                  Base URL 填入生产环境域名，API Key 填入 <code style={{ color: "#a78bfa", background: "rgba(167,139,250,0.1)", padding: "1px 5px", borderRadius: "4px" }}>PROXY_API_KEY</code>。
                  <div style={{ marginTop: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "12px", color: "#475569", flexShrink: 0 }}>当前地址</span>
                    <code style={{ flex: 1, color: "#a78bfa", fontSize: "12px", fontFamily: "Menlo, monospace", overflow: "hidden", textOverflow: "ellipsis" }}>{displayUrl}</code>
                    <CopyButton text={displayUrl} />
                  </div>
                </span>
              ),
            },
            { step: 4, title: "点击「检测」或「添加模型」", desc: `CherryStudio 会自动调用 /v1/models 加载 ${totalModels} 个模型列表，选择需要的模型即可开始使用。` },
          ].map((item) => (
            <div key={item.step} style={{ display: "flex", gap: "14px" }}>
              <div style={{
                width: "28px", height: "28px", borderRadius: "50%",
                background: "rgba(99,102,241,0.2)", border: "1px solid rgba(99,102,241,0.4)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "13px", fontWeight: 700, color: "#818cf8", flexShrink: 0, marginTop: "1px",
              }}>{item.step}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: "#cbd5e1", fontSize: "14px", marginBottom: "4px" }}>{item.title}</div>
                <div style={{ color: "#475569", fontSize: "13px", lineHeight: "1.5" }}>{item.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// PageModels — model enable/disable management
// ---------------------------------------------------------------------------

interface ModelStatus { id: string; provider: string; enabled: boolean }

type GroupSummary = { total: number; enabled: number };

function ModelToggle({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      style={{
        width: "36px", height: "20px", borderRadius: "10px", border: "none",
        background: enabled ? "rgba(99,102,241,0.7)" : "rgba(100,116,139,0.3)",
        position: "relative", cursor: "pointer", flexShrink: 0, transition: "background 0.15s",
        padding: 0,
      }}
    >
      <div style={{
        width: "14px", height: "14px", borderRadius: "50%", background: "#fff",
        position: "absolute", top: "3px",
        left: enabled ? "19px" : "3px",
        transition: "left 0.15s",
        boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
      }} />
    </button>
  );
}

function PageModels({
  baseUrl, apiKey, modelStatus, summary, onRefresh, onToggleProvider, onToggleModel,
}: {
  baseUrl: string;
  apiKey: string;
  modelStatus: ModelStatus[];
  summary: Record<string, GroupSummary>;
  onRefresh: () => void;
  onToggleProvider: (provider: string, enabled: boolean) => void;
  onToggleModel: (id: string, enabled: boolean) => void;
}) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    openai: true, anthropic: true, gemini: true, openrouter: true,
  });
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");

  const allGroups: { key: string; title: string; models: ModelEntry[]; provider: Provider }[] = [
    { key: "openai", title: "OpenAI", models: OPENAI_MODELS, provider: "openai" },
    { key: "anthropic", title: "Anthropic Claude", models: ANTHROPIC_MODELS, provider: "anthropic" },
    { key: "gemini", title: "Google Gemini", models: GEMINI_MODELS, provider: "gemini" },
    { key: "openrouter", title: "OpenRouter", models: OPENROUTER_MODELS, provider: "openrouter" },
  ];

  const statusMap = new Map(modelStatus.map((m) => [m.id, m.enabled]));

  const totalEnabled = modelStatus.filter((m) => m.enabled).length;
  const totalCount = modelStatus.length;

  if (!apiKey) {
    return (
      <Card>
        <div style={{ textAlign: "center", color: "#475569", padding: "40px 0" }}>
          <div style={{ fontSize: "24px", marginBottom: "12px" }}>🔒</div>
          <div>请先在首页填写 API Key 才能管理模型开关</div>
        </div>
      </Card>
    );
  }

  return (
    <>
      {/* 顶部统计行 */}
      <Card style={{ marginBottom: "16px", display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
        <div style={{ flex: 1 }}>
          <SectionTitle>模型开关管理</SectionTitle>
          <div style={{ fontSize: "13px", color: "#475569" }}>
            已启用 <span style={{ color: "#a5b4fc", fontWeight: 700 }}>{totalEnabled}</span> / {totalCount} 个模型
            · 禁用的模型不会出现在 <code style={{ fontFamily: "Menlo, monospace", fontSize: "12px", color: "#818cf8" }}>/v1/models</code> 响应中，调用时返回 403
          </div>
        </div>
        {/* 过滤器 */}
        <div style={{ display: "flex", gap: "4px" }}>
          {(["all", "enabled", "disabled"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: "5px 12px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.08)",
              background: filter === f ? "rgba(99,102,241,0.2)" : "transparent",
              color: filter === f ? "#a5b4fc" : "#475569", fontSize: "12px", cursor: "pointer",
              fontWeight: filter === f ? 600 : 400,
            }}>
              {f === "all" ? "全部" : f === "enabled" ? "已启用" : "已禁用"}
            </button>
          ))}
        </div>
        <button onClick={onRefresh} style={{
          padding: "6px 14px", borderRadius: "7px",
          border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.05)",
          color: "#475569", fontSize: "12px", cursor: "pointer",
        }}>刷新</button>
      </Card>

      {/* 各组 */}
      {allGroups.map(({ key, title, models, provider }) => {
        const c = PROVIDER_COLORS[provider];
        const grpSummary = summary[key] ?? { total: models.length, enabled: models.length };
        const isExpanded = expandedGroups[key];
        const groupEnabled = grpSummary.enabled > 0;
        const allEnabled = grpSummary.enabled === grpSummary.total;

        const filteredModels = models.filter((m) => {
          const en = statusMap.get(m.id) ?? true;
          if (filter === "enabled") return en;
          if (filter === "disabled") return !en;
          return true;
        });

        return (
          <div key={key} style={{ marginBottom: "10px" }}>
            {/* Group header */}
            <div style={{
              display: "flex", alignItems: "center", gap: "10px",
              background: c.bg, border: `1px solid ${c.border}`, borderRadius: "8px",
              padding: "10px 14px",
            }}>
              <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: c.dot, flexShrink: 0 }} />
              <button onClick={() => setExpandedGroups((p) => ({ ...p, [key]: !p[key] }))} style={{
                background: "none", border: "none", padding: 0, cursor: "pointer",
                fontWeight: 600, color: c.text, fontSize: "13px", flex: 1, textAlign: "left",
              }}>
                {title}
              </button>
              {/* 统计 */}
              <span style={{ fontSize: "12px", color: "#475569" }}>
                {grpSummary.enabled}/{grpSummary.total} 已启用
              </span>
              {/* 批量按钮 */}
              <button onClick={() => onToggleProvider(key, true)} style={{
                padding: "3px 10px", borderRadius: "5px", fontSize: "11px",
                border: "1px solid rgba(74,222,128,0.3)", background: "rgba(74,222,128,0.08)",
                color: "#4ade80", cursor: "pointer",
              }}>全部启用</button>
              <button onClick={() => onToggleProvider(key, false)} style={{
                padding: "3px 10px", borderRadius: "5px", fontSize: "11px",
                border: "1px solid rgba(248,113,113,0.3)", background: "rgba(248,113,113,0.08)",
                color: "#f87171", cursor: "pointer",
              }}>全部禁用</button>
              {/* 组级总开关 */}
              <ModelToggle
                enabled={groupEnabled}
                onChange={() => onToggleProvider(key, !allEnabled)}
              />
              <button onClick={() => setExpandedGroups((p) => ({ ...p, [key]: !p[key] }))} style={{
                background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: "11px",
              }}>{isExpanded ? "▲" : "▼"}</button>
            </div>

            {/* 模型列表 */}
            {isExpanded && filteredModels.length > 0 && (
              <div style={{ marginTop: "4px", display: "flex", flexDirection: "column", gap: "2px" }}>
                {filteredModels.map((m) => {
                  const enabled = statusMap.get(m.id) ?? true;
                  return (
                    <div key={m.id} style={{
                      display: "flex", alignItems: "center", gap: "10px",
                      background: enabled ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.35)",
                      border: `1px solid ${enabled ? "rgba(255,255,255,0.05)" : "rgba(248,113,113,0.12)"}`,
                      borderRadius: "7px", padding: "6px 12px",
                      opacity: enabled ? 1 : 0.55, transition: "all 0.15s",
                    }}>
                      <code style={{
                        fontFamily: "Menlo, monospace", fontSize: "11.5px",
                        color: enabled ? c.text : "#475569",
                        flex: 1, wordBreak: "break-all",
                      }}>{m.id}</code>
                      <span style={{ fontSize: "11.5px", color: "#334155", flexShrink: 0 }}>{m.desc}</span>
                      {m.context && (
                        <span style={{ fontSize: "10px", color: "#334155", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "3px", padding: "1px 5px", flexShrink: 0 }}>{m.context}</span>
                      )}
                      {m.badge && <Badge variant={m.badge} />}
                      <ModelToggle enabled={enabled} onChange={() => onToggleModel(m.id, !enabled)} />
                    </div>
                  );
                })}
              </div>
            )}
            {isExpanded && filteredModels.length === 0 && (
              <div style={{ padding: "10px 14px", color: "#334155", fontSize: "12.5px" }}>
                该过滤条件下无匹配模型
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

type Tab = "home" | "stats" | "models" | "logs" | "endpoints";

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [online, setOnline] = useState<boolean | null>(null);
  const [sillyTavernMode, setSillyTavernMode] = useState(false);
  const [stLoading, setStLoading] = useState(true);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("proxy_api_key") ?? "");
  const [showWizard, setShowWizard] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    openai: false, anthropic: false, gemini: false, openrouter: false,
  });
  const [stats, setStats] = useState<Record<string, BackendStat> | null>(null);
  const [modelStats, setModelStats] = useState<Record<string, ModelStat> | null>(null);
  const [statsError, setStatsError] = useState<false | "auth" | "server">(false);
  const [routing, setRouting] = useState<{ localEnabled: boolean; localFallback: boolean; fakeStream: boolean }>({ localEnabled: true, localFallback: true, fakeStream: true });
  const [addUrl, setAddUrl] = useState("");
  const [addState, setAddState] = useState<"idle" | "loading" | "ok" | "err">("idle");
  const [addMsg, setAddMsg] = useState("");
  const [modelStatus, setModelStatus] = useState<ModelStatus[]>([]);
  const [modelSummary, setModelSummary] = useState<Record<string, GroupSummary>>({});

  const baseUrl = window.location.origin;
  const displayUrl: string = (import.meta.env.VITE_BASE_URL as string | undefined) ?? window.location.origin;
  const totalModels = OPENAI_MODELS.length + ANTHROPIC_MODELS.length + GEMINI_MODELS.length + OPENROUTER_MODELS.length;

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/healthz`, { signal: AbortSignal.timeout(5000) });
      setOnline(res.ok);
    } catch { setOnline(false); }
  }, [baseUrl]);

  const fetchSTMode = useCallback(async () => {
    try {
      const key = localStorage.getItem("proxy_api_key") ?? "";
      const res = await fetch(`${baseUrl}/api/settings/sillytavern`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      });
      if (res.ok) { const d = await res.json(); setSillyTavernMode(d.enabled); }
    } catch {}
    setStLoading(false);
  }, [baseUrl]);

  const toggleSTMode = async () => {
    const newVal = !sillyTavernMode;
    setSillyTavernMode(newVal);
    try {
      const res = await fetch(`${baseUrl}/api/settings/sillytavern`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ enabled: newVal }),
      });
      if (!res.ok) setSillyTavernMode(!newVal);
    } catch { setSillyTavernMode(!newVal); }
  };

  const fetchStats = useCallback(async (key: string) => {
    if (!key) { setStats(null); setModelStats(null); setStatsError(false); return; }
    try {
      const r = await fetch(`${baseUrl}/api/v1/stats`, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) {
        setStatsError(r.status === 500 ? "server" : "auth");
        return;
      }
      const d = await r.json();
      const parsed: Record<string, BackendStat> = {};
      for (const [k, v] of Object.entries(d.stats as Record<string, Record<string, unknown>>)) {
        parsed[k] = { ...(v as unknown as BackendStat), streamingCalls: (v.streamingCalls as number) ?? 0 };
      }
      setStats(parsed); setStatsError(false);
      setModelStats(d.modelStats && typeof d.modelStats === "object" ? d.modelStats as Record<string, ModelStat> : null);
      if (d.routing) setRouting(d.routing);
    } catch { setStatsError("auth"); }
  }, [baseUrl]);

  const addBackend = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = normalizeBackendUrl(addUrl);
    if (!url) return;
    setAddState("loading");
    try {
      const r = await fetch(`${baseUrl}/api/v1/admin/backends`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await r.json();
      if (!r.ok) { setAddState("err"); setAddMsg(data.error ?? "Failed"); return; }
      setAddState("ok"); setAddMsg(`已添加 ${data.label}`); setAddUrl("");
      setTimeout(() => setAddState("idle"), 3000);
      fetchStats(apiKey);
    } catch { setAddState("err"); setAddMsg("网络错误"); }
  };

  const removeBackend = async (label: string) => {
    await fetch(`${baseUrl}/api/v1/admin/backends/${label}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    fetchStats(apiKey);
  };

  const toggleBackend = async (label: string, enabled: boolean) => {
    await fetch(`${baseUrl}/api/v1/admin/backends/${label}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    fetchStats(apiKey);
  };

  const batchToggleBackends = async (labels: string[], enabled: boolean) => {
    await fetch(`${baseUrl}/api/v1/admin/backends`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ labels, enabled }),
    });
    fetchStats(apiKey);
  };

  const toggleRouting = async (field: "localEnabled" | "localFallback" | "fakeStream", value: boolean) => {
    setRouting((prev) => ({ ...prev, [field]: value }));
    try {
      await fetch(`${baseUrl}/api/v1/admin/routing`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
    } catch {}
  };

  const fetchModels = useCallback(async (key: string = apiKey) => {
    if (!key) return;
    try {
      const r = await fetch(`${baseUrl}/api/v1/admin/models`, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) return;
      const d = await r.json();
      setModelStatus(d.models ?? []);
      setModelSummary(d.summary ?? {});
    } catch {}
  }, [baseUrl, apiKey]);

  const toggleModelProvider = async (provider: string, enabled: boolean) => {
    // Optimistic update
    setModelStatus((prev) => prev.map((m) => m.provider === provider ? { ...m, enabled } : m));
    setModelSummary((prev) => {
      const grp = prev[provider];
      if (!grp) return prev;
      return { ...prev, [provider]: { total: grp.total, enabled: enabled ? grp.total : 0 } };
    });
    try {
      await fetch(`${baseUrl}/api/v1/admin/models`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ provider, enabled }),
      });
    } catch {}
    fetchModels();
  };

  const toggleModelById = async (id: string, enabled: boolean) => {
    // Optimistic update
    setModelStatus((prev) => prev.map((m) => m.id === id ? { ...m, enabled } : m));
    setModelSummary((prev) => {
      const m = modelStatus.find((ms) => ms.id === id);
      if (!m) return prev;
      const grp = prev[m.provider];
      if (!grp) return prev;
      const delta = enabled ? 1 : -1;
      return { ...prev, [m.provider]: { total: grp.total, enabled: Math.max(0, Math.min(grp.total, grp.enabled + delta)) } };
    });
    try {
      await fetch(`${baseUrl}/api/v1/admin/models`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id], enabled }),
      });
    } catch {}
    fetchModels();
  };

  const batchRemoveBackends = async (labels: string[]) => {
    await Promise.all(labels.map((l) =>
      fetch(`${baseUrl}/api/v1/admin/backends/${l}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      })
    ));
    fetchStats(apiKey);
  };

  useEffect(() => {
    checkHealth();
    fetchSTMode();
    fetchStats(apiKey);
    fetchModels(apiKey);
    const iv1 = setInterval(checkHealth, 30000);
    const iv2 = setInterval(() => fetchStats(apiKey), 15000);
    return () => { clearInterval(iv1); clearInterval(iv2); };
  }, [checkHealth, fetchSTMode, fetchStats, fetchModels, apiKey]);

  // Auto-show wizard only when server is NOT configured yet.
  // Once PROXY_API_KEY is set server-side, wizard never pops up automatically.
  // Uses sessionStorage so a manual dismiss stays dismissed for this tab's lifetime.
  useEffect(() => {
    if (sessionStorage.getItem("wizard_dismissed") === "1") return;
    fetch(`${baseUrl}/api/setup-status`)
      .then((r) => r.ok ? r.json() : null)
      .then((status: { configured: boolean } | null) => {
        if (!status || status.configured) return;
        setShowWizard(true);
      })
      .catch(() => {});
  }, [baseUrl]);

  const TABS: { id: Tab; label: string; icon: string }[] = [
    { id: "home", label: "概览", icon: "&#127968;" },
    { id: "stats", label: "统计", icon: "&#128200;" },
    { id: "models", label: "模型", icon: "&#129302;" },
    { id: "logs", label: "日志", icon: "&#128203;" },
    { id: "endpoints", label: "文档", icon: "&#128214;" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "hsl(222,47%,11%)", color: "#e2e8f0", fontFamily: "'Inter', -apple-system, sans-serif" }}>
      {showWizard && (
        <SetupWizard
          baseUrl={baseUrl}
          onComplete={(key) => {
            sessionStorage.setItem("wizard_dismissed", "1");
            setShowWizard(false);
            if (key) {
              setApiKey(key);
              localStorage.setItem("proxy_api_key", key);
            }
          }}
          onDismiss={() => { sessionStorage.setItem("wizard_dismissed", "1"); setShowWizard(false); }}
        />
      )}

      <UpdateBar baseUrl={baseUrl} apiKey={apiKey} />

      <div style={{ maxWidth: "920px", margin: "0 auto", padding: "28px 24px 80px" }}>

        {/* Header */}
        <div style={{
          marginBottom: "24px",
          background: "linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(139,92,246,0.06) 50%, rgba(59,130,246,0.04) 100%)",
          border: "1px solid rgba(99,102,241,0.12)",
          borderRadius: "16px", padding: "24px 28px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "14px", marginBottom: "10px" }}>
            <div style={{
              width: "44px", height: "44px", borderRadius: "12px",
              background: "linear-gradient(135deg, #6366f1, #8b5cf6, #3b82f6)",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: "22px",
              boxShadow: "0 4px 16px rgba(99,102,241,0.3)",
            }}>&#9889;</div>
            <div>
              <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.02em" }}>Replit2Api</h1>
              <p style={{ color: "#64748b", margin: "2px 0 0", fontSize: "12.5px" }}>
                AI Proxy Gateway · OpenAI / Anthropic / Gemini / OpenRouter
              </p>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
              <UpdateBadge baseUrl={baseUrl} apiKey={apiKey} />
              <button onClick={() => setShowWizard(true)} style={{
                padding: "6px 14px", background: "linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.15))",
                border: "1px solid rgba(99,102,241,0.3)", borderRadius: "100px",
                color: "#a5b4fc", fontSize: "12px", fontWeight: 600, cursor: "pointer",
                display: "flex", alignItems: "center", gap: "5px",
                transition: "all 0.2s",
              }}>&#128640; 配置向导</button>
              <div style={{
                display: "flex", alignItems: "center", gap: "6px",
                background: online === null ? "rgba(100,116,139,0.15)" : online ? "rgba(74,222,128,0.1)" : "rgba(248,113,113,0.1)",
                border: `1px solid ${online === null ? "rgba(100,116,139,0.3)" : online ? "rgba(74,222,128,0.25)" : "rgba(248,113,113,0.25)"}`,
                borderRadius: "100px", padding: "5px 12px 5px 8px",
              }}>
                <div style={{
                  width: "8px", height: "8px", borderRadius: "50%",
                  background: online === null ? "#64748b" : online ? "#4ade80" : "#f87171",
                  boxShadow: online ? "0 0 8px rgba(74,222,128,0.5)" : undefined,
                  animation: online ? "pulse 2s infinite" : undefined,
                }} />
                <span style={{ fontSize: "12px", color: online === null ? "#64748b" : online ? "#4ade80" : "#f87171", fontWeight: 600 }}>
                  {online === null ? "..." : online ? "在线" : "离线"}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{
          display: "flex", gap: "2px", marginBottom: "24px",
          background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: "12px", padding: "4px",
          backdropFilter: "blur(8px)",
        }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                flex: 1, padding: "9px 8px", borderRadius: "8px", border: "none",
                background: tab === t.id
                  ? "linear-gradient(135deg, rgba(99,102,241,0.25), rgba(139,92,246,0.2))"
                  : "transparent",
                color: tab === t.id ? "#c7d2fe" : "#475569",
                fontSize: "12.5px", fontWeight: tab === t.id ? 600 : 400,
                cursor: "pointer", transition: "all 0.2s",
                boxShadow: tab === t.id
                  ? "inset 0 0 0 1px rgba(99,102,241,0.3), 0 2px 8px rgba(99,102,241,0.1)"
                  : "none",
                display: "flex", alignItems: "center", justifyContent: "center", gap: "5px",
              }}
            >
              <span dangerouslySetInnerHTML={{ __html: t.icon }} style={{ fontSize: "13px" }} />
              {t.label}
            </button>
          ))}
        </div>

        {/* Page content */}
        {tab === "home" && (
          <PageHome
            displayUrl={displayUrl}
            apiKey={apiKey}
            setApiKey={setApiKey}
            sillyTavernMode={sillyTavernMode}
            stLoading={stLoading}
            onToggleSTMode={toggleSTMode}
          />
        )}
        {tab === "stats" && (
          <PageStats
            baseUrl={baseUrl}
            apiKey={apiKey}
            stats={stats}
            statsError={statsError}
            onRefresh={() => fetchStats(apiKey)}
            addUrl={addUrl}
            setAddUrl={setAddUrl}
            addState={addState}
            addMsg={addMsg}
            onAddBackend={addBackend}
            onRemoveBackend={removeBackend}
            onToggleBackend={toggleBackend}
            onBatchToggle={batchToggleBackends}
            onBatchRemove={batchRemoveBackends}
            routing={routing}
            onToggleRouting={toggleRouting}
            modelStats={modelStats}
          />
        )}
        {tab === "models" && (
          <PageModels
            baseUrl={baseUrl}
            apiKey={apiKey}
            modelStatus={modelStatus}
            summary={modelSummary}
            onRefresh={() => fetchModels(apiKey)}
            onToggleProvider={toggleModelProvider}
            onToggleModel={toggleModelById}
          />
        )}
        {tab === "logs" && (
          <PageLogs baseUrl={baseUrl} apiKey={apiKey} />
        )}
        {tab === "endpoints" && (
          <PageDocs />
        )}

        <div style={{ marginTop: "32px", textAlign: "center", color: "#1e293b", fontSize: "12px" }}>
          Powered by Replit AI Integrations · OpenAI · Anthropic · Gemini · OpenRouter
        </div>
      </div>
    </div>
  );
}
