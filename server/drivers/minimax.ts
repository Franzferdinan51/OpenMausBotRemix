// MiniMax's official `mmx` CLI. Keeping this local harness separate from
// OpenAI-compatible endpoints means an existing `mmx auth login` / API-key
// setup is reused and no secret is copied into the app configuration.
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import type { DriverCreateInput, ProviderDriver, ProviderInstance, ProviderSnapshot, RuntimeEvent, RuntimeEventListener, SendTurnInput } from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { augmentedPath } from "../env-path.ts";

const MODELS = { default: "MiniMax-M3", options: [
  { id: "MiniMax-M3", label: "MiniMax M3" },
  { id: "MiniMax-M2.7", label: "MiniMax M2.7" },
  { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" },
] };

interface MiniMaxConfig { cli: string; }
const decodeConfig = (raw: unknown): MiniMaxConfig => ({ cli: typeof (raw as { cli?: unknown } | null)?.cli === "string" ? (raw as { cli: string }).cli : "mmx" });

function textFrom(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).join("");
  return textFrom(value?.choices?.[0]?.message?.content ?? value?.data?.choices?.[0]?.message?.content ?? value?.content ?? value?.text ?? value?.output ?? value?.message?.content ?? "");
}

export const MiniMaxDriver: ProviderDriver<MiniMaxConfig> = {
  driverKind: "minimax", metadata: { displayName: "MiniMax", supportsMultipleInstances: true }, models: MODELS,
  decodeConfig, defaultConfig: () => decodeConfig({}),
  async create(input: DriverCreateInput<MiniMaxConfig>): Promise<ProviderInstance> {
    const config = input.config;
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, ReturnType<typeof spawn>>();
    const emit = (event: RuntimeEvent) => listeners.forEach((listener) => listener(event));
    const base = (threadId: string, turnId: string) => ({ eventId: newEventId(), provider: "minimax", threadId, turnId, createdAt: new Date().toISOString() });
    const env = () => ({ ...process.env, ...input.environment, PATH: augmentedPath() });
    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => execFile(config.cli, ["--version"], { timeout: 8_000, env: env() }, (error, out) => resolve(error ? null : out.trim())));
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      const authenticated = await new Promise<boolean>((resolve) => execFile(config.cli, ["auth", "status", "--output", "json"], { timeout: 8_000, env: env() }, (error) => resolve(!error)));
      return authenticated ? { state: "available", version, authenticated: true } : { state: "unavailable", version, authenticated: false, reason: "MiniMax CLI is not authenticated — run `mmx auth login`" };
    };
    const sendTurn = async (turn: SendTurnInput) => {
      if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const args = ["text", "chat", "--output", "json", "--quiet", "--model", turn.model ?? MODELS.default];
      if (turn.system) args.push("--system", turn.system);
      for (const message of turn.transcript ?? []) args.push("--message", `${message.role}: ${message.text}`);
      args.push("--message", turn.text);
      const child = spawn(config.cli, args, { cwd: turn.cwd ?? homedir(), env: env(), stdio: ["ignore", "pipe", "pipe"], detached: true });
      active.set(turn.threadId, child);
      emit({ ...base(turn.threadId, turnId), type: "turn.started" });
      emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? MODELS.default });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: error.message }));
      child.on("close", (code) => {
        active.delete(turn.threadId);
        if (code === 0) {
          let text = stdout.trim(); try { text = textFrom(JSON.parse(stdout)); } catch {}
          if (text) { emit({ ...base(turn.threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: text }); emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text }); }
          emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
        } else {
          emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: stderr.trim() || `MiniMax exited with code ${code}` });
          emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: false, stopReason: "error", cost: null });
        }
      });
      return { turnId };
    };
    return { instanceId: input.instanceId, driverKind: "minimax", displayName: input.displayName, enabled: input.enabled, models: MODELS, snapshot,
      adapter: { provider: "minimax", capabilities: { sessionModelSwitch: "unsupported" }, sendTurn, interruptTurn: async (threadId) => { const child = active.get(threadId); if (child?.pid) try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }, respondToRequest: async () => { throw new Error("MiniMax does not expose interactive requests"); }, hasSession: (threadId) => active.has(threadId), stopAll: async () => { for (const threadId of active.keys()) await (async () => { const child = active.get(threadId); if (child?.pid) try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } })(); }, onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
      dispose: async () => { for (const child of active.values()) child.kill("SIGTERM"); listeners.clear(); }, };
  },
};
