// A provider-neutral OpenAI Chat Completions adapter. It intentionally covers
// Ollama, LM Studio and other local `/v1` servers as well as hosted compatible
// endpoints such as OpenRouter. Credentials are injected per instance only.
import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";

export interface CompatibleConfig {
  /** OpenAI-compatible API base, normally ending in `/v1`. */
  url: string;
  /** Empty means the endpoint intentionally needs no bearer key. */
  apiKeyEnv?: string;
  /** Fallback catalog when `/models` cannot be read. */
  models?: string[];
}

const FALLBACK_MODELS = ["local-model"];

function decodeCompatibleConfig(raw: unknown, defaultUrl: string, defaultKeyEnv: string): CompatibleConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  const url = typeof value.url === "string" ? value.url.trim().replace(/\/+$/, "") : defaultUrl;
  if (!/^https?:\/\//.test(url)) throw new Error("provider URL must start with http:// or https://");
  return {
    url,
    apiKeyEnv: typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : defaultKeyEnv,
    models: Array.isArray(value.models)
      ? value.models.filter((model): model is string => typeof model === "string" && model.trim().length > 0)
      : FALLBACK_MODELS,
  };
}

function readSseLine(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  return payload && payload !== "[DONE]" ? payload : null;
}

export function createCompatibleDriver(
  kind: string,
  displayName: string,
  defaultUrl: string,
  defaultKeyEnv = "OPENAI_API_KEY",
): ProviderDriver<CompatibleConfig> {
  const decodeConfig = (raw: unknown) => decodeCompatibleConfig(raw, defaultUrl, defaultKeyEnv);

  return {
    driverKind: kind,
    metadata: { displayName, supportsMultipleInstances: true },
    models: { default: FALLBACK_MODELS[0], options: FALLBACK_MODELS.map((id) => ({ id, label: id })) },
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<CompatibleConfig>): Promise<ProviderInstance> {
      const { config } = input;
      const keyEnv = config.apiKeyEnv ?? defaultKeyEnv;
      const apiKey = keyEnv ? input.environment[keyEnv] ?? process.env[keyEnv] ?? "" : "";
      const configuredModels = config.models?.length ? config.models : FALLBACK_MODELS;
      const catalog = {
        default: configuredModels[0],
        options: configuredModels.map((id) => ({ id, label: id })),
      };
      const listeners = new Set<RuntimeEventListener>();
      const active = new Map<string, AbortController>();

      const headers = () => ({
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      });
      const emit = (event: RuntimeEvent) => listeners.forEach((listener) => listener(event));
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: kind,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      const refreshModels = async () => {
        const response = await fetch(`${config.url}/models`, {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(2_500),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
        const discovered = (body.data ?? [])
          .map((entry) => entry.id)
          .filter((model): model is string => typeof model === "string" && model.length > 0);
        if (discovered.length) {
          catalog.default = discovered[0];
          catalog.options = discovered.map((id) => ({ id, label: id }));
        }
      };

      const sendTurn = async (turn: SendTurnInput) => {
        if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
        if (!apiKey && keyEnv && !/^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/.test(config.url)) {
          throw new Error(`no API key — set ${keyEnv}`);
        }
        const turnId = newId();
        const abort = new AbortController();
        active.set(turn.threadId, abort);
        const messages = [
          ...(turn.system ? [{ role: "system", content: turn.system }] : []),
          ...(turn.transcript ?? []).map((message) => ({ role: message.role, content: message.text })),
          { role: "user", content: turn.text },
        ];
        emit({ ...base(turn.threadId, turnId), type: "turn.started" });
        emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? catalog.default });

        void (async () => {
          try {
            const response = await fetch(`${config.url}/chat/completions`, {
              method: "POST",
              headers: headers(),
              body: JSON.stringify({ model: turn.model ?? catalog.default, messages, stream: true }),
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
            });
            if (!response.ok) throw new Error(`${displayName} HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
            if (!response.body) throw new Error("provider returned no response body");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let text = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let newline: number;
              while ((newline = buffer.indexOf("\n")) >= 0) {
                const payload = readSseLine(buffer.slice(0, newline).trim());
                buffer = buffer.slice(newline + 1);
                if (!payload) continue;
                try {
                  const delta = (JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0]?.delta?.content;
                  if (typeof delta === "string" && delta) {
                    text += delta;
                    emit({ ...base(turn.threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
                  }
                } catch {
                  // Ignore malformed keep-alives; valid chunks still complete the turn.
                }
              }
            }
            if (text) emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
            emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
          } catch (error) {
            const aborted = abort.signal.aborted;
            if (!aborted) emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: (error as Error).message });
            emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: false, stopReason: aborted ? "interrupted" : "error", cost: null });
          } finally {
            active.delete(turn.threadId);
          }
        })();

        return { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        try {
          if (!apiKey && keyEnv && !/^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/.test(config.url)) {
            return { state: "unavailable", reason: `no API key — set ${keyEnv}` };
          }
          await refreshModels();
          return { state: "available", authenticated: Boolean(apiKey) || !keyEnv, version: null };
        } catch (error) {
          return { state: "unavailable", reason: `${displayName} is not reachable: ${(error as Error).message}` };
        }
      };

      return {
        instanceId: input.instanceId,
        driverKind: kind,
        displayName: input.displayName,
        enabled: input.enabled,
        models: catalog,
        snapshot,
        adapter: {
          provider: kind,
          capabilities: { sessionModelSwitch: "in-session" },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.abort(),
          respondToRequest: async () => { throw new Error(`${displayName} has no pending asks`); },
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => active.forEach((controller) => controller.abort()),
          onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        },
        dispose: async () => { active.forEach((controller) => controller.abort()); listeners.clear(); },
      };
    },
  };
}

export const LocalAiDriver = createCompatibleDriver("localAi", "Local AI", "http://127.0.0.1:11434/v1", "");
export const OpenRouterDriver = createCompatibleDriver("openRouter", "OpenRouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY");
