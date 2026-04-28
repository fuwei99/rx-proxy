import { useState, useEffect, useRef, useCallback } from "react";

interface Props {
  baseUrl: string;
  onComplete: (apiKey?: string) => void;
  onDismiss: () => void;
}

interface CopyBlock {
  text: string;
}

interface Message {
  id: number;
  from: "agent" | "user";
  text: string;
  copyBlocks?: CopyBlock[];
  actions?: Action[];
}

interface Action {
  label: string;
  value: string;
  primary?: boolean;
}

interface SetupStatus {
  configured: boolean;
  integrationsReady: boolean;
  storageReady: boolean;
}

function buildSetupPrompt(
  apiKey: string,
  opts: { needIntegrations: boolean; needStorage: boolean } = { needIntegrations: true, needStorage: true }
): string {
  const steps: string[] = [];
  let stepNum = 0;

  steps.push(`步骤 ${++stepNum}：添加 Secret — PROXY_API_KEY
   我已经选好了自己的访问密码，请将以下值原封不动地写入 Secrets，不要修改、不要随机生成：
   PROXY_API_KEY = ${apiKey}`);

  if (opts.needIntegrations) {
    steps.push(`步骤 ${++stepNum}：开通 Replit AI Integrations（四个 provider 全部需要）
   【重要】这是 Replit 平台内置功能，完全不需要我提供任何第三方 API Key（OpenAI、Anthropic、Gemini、OpenRouter 均由平台免费提供）。
   请在 code_execution 工具中依次执行以下四条命令（必须逐条顺序执行，等上一条完成再执行下一条）：

   const r1 = await setupReplitAIIntegrations({ providerSlug: "openai", providerUrlEnvVarName: "AI_INTEGRATIONS_OPENAI_BASE_URL", providerApiKeyEnvVarName: "AI_INTEGRATIONS_OPENAI_API_KEY" });
   console.log("OpenAI:", JSON.stringify(r1));

   const r2 = await setupReplitAIIntegrations({ providerSlug: "anthropic", providerUrlEnvVarName: "AI_INTEGRATIONS_ANTHROPIC_BASE_URL", providerApiKeyEnvVarName: "AI_INTEGRATIONS_ANTHROPIC_API_KEY" });
   console.log("Anthropic:", JSON.stringify(r2));

   const r3 = await setupReplitAIIntegrations({ providerSlug: "gemini", providerUrlEnvVarName: "AI_INTEGRATIONS_GEMINI_BASE_URL", providerApiKeyEnvVarName: "AI_INTEGRATIONS_GEMINI_API_KEY" });
   console.log("Gemini:", JSON.stringify(r3));

   const r4 = await setupReplitAIIntegrations({ providerSlug: "openrouter", providerUrlEnvVarName: "AI_INTEGRATIONS_OPENROUTER_BASE_URL", providerApiKeyEnvVarName: "AI_INTEGRATIONS_OPENROUTER_API_KEY" });
   console.log("OpenRouter:", JSON.stringify(r4));

   四条全部成功后，环境变量会自动注入，无需手动操作。`);
  }

  if (opts.needStorage) {
    steps.push(`步骤 ${++stepNum}：开通云端持久化存储（App Storage）
   在 code_execution 工具中执行以下 JavaScript，开通属于本项目的独立 GCS 存储桶，确保子节点配置 publish 后不丢失：

   const result = await setupObjectStorage();
   console.log(JSON.stringify(result));

   执行成功后 Replit 会自动写入 DEFAULT_OBJECT_STORAGE_BUCKET_ID 等环境变量，无需手动操作。`);
  }

  return `请帮我完成 Replit2Api 的初始配置，严格按以下步骤执行：

【绝对禁止】不得向我索取 OpenAI、Anthropic、Gemini 或 OpenRouter 的 API Key，这四项全部由 Replit 平台通过 AI Integrations 自动提供，用户无需拥有也无需填写任何第三方密钥。

${steps.join("\n\n")}

完成以上步骤后重启以下两个 Workflow，然后告知我，我将点击门户中的"已重启，重新检测"按钮验证配置：
- artifacts/api-server: API Server
- artifacts/api-portal: web`;
}

const STORAGE_ONLY_PROMPT = `请帮我完成 Replit2Api 的云端存储初始化：

在 code_execution 工具中执行以下 JavaScript，为本项目开通独立的 GCS 存储桶（确保子节点配置 publish 后不丢失）：

const result = await setupObjectStorage();
console.log(JSON.stringify(result));

执行成功后重启服务器，然后告知我，我将点击"已重启，重新检测"验证。`;

let msgId = 0;
const makeMsg = (
  from: Message["from"],
  text: string,
  extras: Partial<Omit<Message, "id" | "from" | "text">> = {}
): Message => ({ id: ++msgId, from, text, ...extras });

function CopyableBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      style={{
        background: "rgba(0,0,0,0.35)",
        border: "1px solid rgba(99,102,241,0.3)",
        borderRadius: "8px",
        padding: "10px 12px",
        display: "flex",
        alignItems: "center",
        gap: "10px",
        marginTop: "8px",
      }}
    >
      <span
        style={{
          flex: 1,
          color: "#a5b4fc",
          fontSize: "13px",
          fontFamily: "Menlo, monospace",
          lineHeight: "1.5",
          whiteSpace: "pre-wrap",
          userSelect: "all",
        }}
      >
        {text}
      </span>
      <button
        onClick={copy}
        style={{
          padding: "5px 12px",
          borderRadius: "6px",
          border: `1px solid ${copied ? "rgba(74,222,128,0.4)" : "rgba(99,102,241,0.4)"}`,
          background: copied ? "rgba(74,222,128,0.12)" : "rgba(99,102,241,0.15)",
          color: copied ? "#4ade80" : "#818cf8",
          fontSize: "11.5px",
          fontWeight: 700,
          cursor: "pointer",
          flexShrink: 0,
          transition: "all 0.2s",
        }}
      >
        {copied ? "已复制 ✓" : "复制"}
      </button>
    </div>
  );
}

export default function SetupWizard({ baseUrl, onComplete, onDismiss }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  const [checking, setChecking] = useState(false);
  const [keyInputStep, setKeyInputStep] = useState(false);
  const [keyInputValue, setKeyInputValue] = useState("");
  const [chosenKey, setChosenKey] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const addAgent = useCallback(
    (text: string, extras: Partial<Omit<Message, "id" | "from" | "text">> = {}, delay = 600) => {
      setTyping(true);
      setTimeout(() => {
        setTyping(false);
        setMessages((prev) => [...prev, makeMsg("agent", text, extras)]);
      }, delay);
    },
    []
  );

  const addUser = useCallback((text: string) => {
    setMessages((prev) => [...prev, makeMsg("user", text)]);
  }, []);

  const clearActions = useCallback(() => {
    setMessages((prev) => prev.map((m) => ({ ...m, actions: undefined })));
  }, []);

  useEffect(() => {
    setTimeout(() => {
      setMessages([
        makeMsg(
          "agent",
          "你好！我是配置助手。\n\n这个 AI 网关内置了 OpenAI、Claude、Gemini 等所有模型。首次运行需要完成简单的初始化，全程通过 Replit Agent 完成，无需手动填写任何密钥。\n\n（我会自动检测已就绪的部分，只生成你真正需要的配置步骤）",
          {
            actions: [
              { label: "开始配置", value: "start", primary: true },
              { label: "已经配置好了", value: "already_done" },
            ],
          }
        ),
      ]);
    }, 300);
  }, []);

  useEffect(() => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
  }, [messages, typing]);

  const checkSetupStatus = useCallback(async (): Promise<SetupStatus> => {
    try {
      const res = await fetch(`${baseUrl}/api/setup-status`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { configured: false, integrationsReady: false, storageReady: false };
      return (await res.json()) as SetupStatus;
    } catch {
      return { configured: false, integrationsReady: false, storageReady: false };
    }
  }, [baseUrl]);

  const runCheck = useCallback(async () => {
    clearActions();
    setChecking(true);
    addUser("检测一下");
    addAgent("正在检测服务器配置状态…", {}, 300);

    const status = await checkSetupStatus();
    setChecking(false);
    setMessages((prev) => prev.filter((m) => m.text !== "正在检测服务器配置状态…"));

    const baseOk = status.configured && status.integrationsReady;

    if (baseOk && status.storageReady) {
      addAgent(
        "配置成功！\n\n✓ 访问密码已设置\n✓ AI 集成已就绪\n✓ 云端持久化存储已开通\n\n你的子节点配置在重新 publish 后也不会丢失。",
        {
          actions: [
            { label: "完成，开始使用 🚀", value: "finish", primary: true },
          ],
        },
        300
      );
    } else if (baseOk && !status.storageReady) {
      addAgent(
        "访问密码和 AI 集成都已就绪！\n\n还差最后一步：开通云端持久化存储（App Storage），确保你在发布后添加的子节点配置不会因重新 publish 而丢失。\n\n请将下方指令复制发给 Replit Agent：",
        {
          copyBlocks: [{ text: STORAGE_ONLY_PROMPT }],
          actions: [{ label: "已重启，重新检测", value: "check", primary: true }],
        },
        300
      );
    } else if (chosenKey) {
      const needIntegrations = !status.integrationsReady;
      const needStorage = !status.storageReady;
      addAgent(
        "配置还未完成。请将下方指令复制发给 Replit Agent，它会帮你完成剩余配置：",
        {
          copyBlocks: [{ text: buildSetupPrompt(chosenKey, { needIntegrations, needStorage }) }],
          actions: [{ label: "已重启，重新检测", value: "check", primary: true }],
        },
        300
      );
    } else {
      addAgent(
        "配置还未完成，需要先设定一个访问密码。请在下方输入你想要的密码：",
        {},
        300
      );
      setKeyInputStep(true);
    }
  }, [clearActions, addUser, addAgent, checkSetupStatus, chosenKey]);

  const handleAction = useCallback(
    async (value: string, label: string) => {
      clearActions();

      if (value === "start") {
        addUser(label);
        addAgent(
          "好的！首先，请在下方设定一个访问密码。\n\n这个密码就是你之后在门户首页填写的 API Key，由你自己定义，比如 my-secret-123。设好后我会帮你生成完整的配置指令。",
          {},
        );
        setKeyInputStep(true);
        return;
      }

      if (value === "already_done") {
        addUser(label);
        addAgent("好的，我来检测服务器状态。", {}, 300);
        setTimeout(() => runCheck(), 900);
        return;
      }

      if (value === "check") {
        await runCheck();
        return;
      }

      if (value === "finish") {
        onComplete(chosenKey || undefined);
        return;
      }
    },
    [clearActions, addUser, addAgent, runCheck, onComplete, chosenKey]
  );

  // ── Key input submit ────────────────────────────────────────────────────
  const handleKeySubmit = useCallback(async () => {
    const key = keyInputValue.trim();
    if (!key) return;
    setChosenKey(key);
    setKeyInputStep(false);
    setKeyInputValue("");
    addUser(`我的访问密码设定为：${"*".repeat(Math.max(0, key.length - 3))}${key.slice(-3)}`);

    const status = await checkSetupStatus();
    const needIntegrations = !status.integrationsReady;
    const needStorage = !status.storageReady;

    const skippedParts: string[] = [];
    if (!needIntegrations) skippedParts.push("AI 集成");
    if (!needStorage) skippedParts.push("云端存储");
    const skippedNote = skippedParts.length
      ? `\n\n（已自动检测到${skippedParts.join("和")}就绪，已从指令中省略这些步骤）`
      : "";

    addAgent(
      `好的，密码已记录！请将下方指令完整复制，发送给 Replit Agent。它会帮你一次性完成所有配置（密码已写入指令，Agent 直接设置，无需你再输入）：${skippedNote}`,
      {
        copyBlocks: [{ text: buildSetupPrompt(key, { needIntegrations, needStorage }) }],
        actions: [{ label: "已重启，检测一下", value: "check", primary: true }],
      }
    );
  }, [keyInputValue, addUser, addAgent, checkSetupStatus]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.8)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        backdropFilter: "blur(6px)",
      }}
    >
      <div
        style={{
          background: "hsl(222,47%,12%)",
          border: "1px solid rgba(99,102,241,0.25)",
          borderRadius: "18px",
          width: "100%",
          maxWidth: "520px",
          height: "min(640px, 88vh)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 32px 80px rgba(0,0,0,0.7)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: "34px", height: "34px", borderRadius: "50%",
              background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "17px", flexShrink: 0,
            }}
          >🤖</div>
          <div>
            <div style={{ fontWeight: 700, color: "#f1f5f9", fontSize: "13.5px" }}>配置助手</div>
            <div style={{ fontSize: "11px", color: "#4ade80", display: "flex", alignItems: "center", gap: "4px" }}>
              <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#4ade80" }} />
              在线
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "10px" }}>
            {checking && (
              <span style={{ fontSize: "11px", color: "#6366f1", animation: "pulse 1.5s ease-in-out infinite" }}>
                检测中…
              </span>
            )}
            <button
              onClick={onDismiss}
              style={{ background: "none", border: "none", color: "#334155", fontSize: "20px", cursor: "pointer", lineHeight: 1, padding: "4px" }}
            >×</button>
          </div>
        </div>

        {/* Messages */}
        <div
          style={{
            flex: 1, overflowY: "auto", padding: "16px",
            display: "flex", flexDirection: "column", gap: "10px",
          }}
        >
          {messages.map((m) => (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
              <div style={{
                display: "flex",
                justifyContent: m.from === "agent" ? "flex-start" : "flex-end",
                gap: "8px", alignItems: "flex-end",
              }}>
                {m.from === "agent" && (
                  <div style={{
                    width: "26px", height: "26px", borderRadius: "50%",
                    background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: "13px", flexShrink: 0,
                  }}>🤖</div>
                )}
                <div style={{
                  maxWidth: "86%",
                  padding: "10px 13px",
                  borderRadius: m.from === "agent" ? "4px 13px 13px 13px" : "13px 4px 13px 13px",
                  background: m.from === "agent" ? "rgba(99,102,241,0.14)" : "rgba(74,222,128,0.1)",
                  border: `1px solid ${m.from === "agent" ? "rgba(99,102,241,0.22)" : "rgba(74,222,128,0.18)"}`,
                  color: m.from === "agent" ? "#cbd5e1" : "#a7f3d0",
                  fontSize: "13.5px", lineHeight: "1.65", whiteSpace: "pre-line",
                }}>
                  {m.text}
                  {m.copyBlocks?.map((cb, i) => (
                    <CopyableBlock key={i} text={cb.text} />
                  ))}
                </div>
              </div>

              {m.actions && (
                <div style={{ display: "flex", gap: "7px", flexWrap: "wrap", paddingLeft: "34px" }}>
                  {m.actions.map((a) => (
                    <button
                      key={a.value}
                      onClick={() => handleAction(a.value, a.label)}
                      disabled={checking}
                      style={{
                        padding: "6px 14px", borderRadius: "20px",
                        border: `1px solid ${a.primary ? "rgba(99,102,241,0.55)" : "rgba(255,255,255,0.1)"}`,
                        background: a.primary ? "rgba(99,102,241,0.18)" : "rgba(255,255,255,0.04)",
                        color: a.primary ? "#a5b4fc" : "#64748b",
                        fontSize: "12.5px", fontWeight: 600,
                        cursor: checking ? "not-allowed" : "pointer",
                        opacity: checking ? 0.5 : 1,
                      }}
                    >{a.label}</button>
                  ))}
                </div>
              )}
            </div>
          ))}

          {typing && (
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
              <div style={{
                width: "26px", height: "26px", borderRadius: "50%",
                background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "13px", flexShrink: 0,
              }}>🤖</div>
              <div style={{
                padding: "10px 14px", borderRadius: "4px 13px 13px 13px",
                background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.18)",
                display: "flex", gap: "4px", alignItems: "center",
              }}>
                {[0, 1, 2].map((i) => (
                  <div key={i} style={{
                    width: "6px", height: "6px", borderRadius: "50%", background: "#6366f1",
                    animation: `bounce 1s ease-in-out ${i * 0.15}s infinite`,
                  }} />
                ))}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Footer — key input form or static hint */}
        {keyInputStep ? (
          <div style={{
            padding: "12px 16px",
            borderTop: "1px solid rgba(99,102,241,0.2)",
            background: "rgba(99,102,241,0.06)",
            flexShrink: 0,
          }}>
            <div style={{ fontSize: "11.5px", color: "#64748b", marginBottom: "8px" }}>
              设定你的访问密码（任意字符串均可，例如 <code style={{ color: "#a78bfa" }}>my-secret-123</code>）
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                autoFocus
                type="text"
                value={keyInputValue}
                onChange={(e) => setKeyInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleKeySubmit(); }}
                placeholder="输入你想要的密码…"
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: "8px",
                  border: "1px solid rgba(99,102,241,0.35)",
                  background: "rgba(0,0,0,0.3)",
                  color: "#f1f5f9",
                  fontSize: "13.5px",
                  outline: "none",
                  fontFamily: "Menlo, monospace",
                }}
              />
              <button
                onClick={handleKeySubmit}
                disabled={!keyInputValue.trim()}
                style={{
                  padding: "8px 16px",
                  borderRadius: "8px",
                  border: "1px solid rgba(99,102,241,0.5)",
                  background: keyInputValue.trim() ? "rgba(99,102,241,0.25)" : "rgba(99,102,241,0.06)",
                  color: keyInputValue.trim() ? "#a5b4fc" : "#334155",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: keyInputValue.trim() ? "pointer" : "not-allowed",
                  flexShrink: 0,
                  transition: "all 0.15s",
                }}
              >
                确认 →
              </button>
            </div>
          </div>
        ) : (
          <div style={{
            padding: "10px 18px",
            borderTop: "1px solid rgba(255,255,255,0.04)",
            fontSize: "11px", color: "#1e293b", textAlign: "center", flexShrink: 0,
          }}>
            所有配置通过 Replit Agent 安全完成，密钥不会经过此页面
          </div>
        )}
      </div>

      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-5px); opacity: 1; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
