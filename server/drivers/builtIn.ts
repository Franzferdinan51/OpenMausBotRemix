// Built-in driver registration — upstream builtInDrivers.ts: a static
// array, nothing more. Adding a driver = write drivers/<x>.ts, append.
import type { AnyProviderDriver } from "../contracts.ts";
import { BoxAgentDriver } from "./boxagent.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { GrokDriver } from "./grok.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";
import { HermesDriver } from "./acp/hermes.ts";
import { OpenClawDriver } from "./acp/openclaw.ts";
import { CopilotDriver } from "./acp/copilot.ts";
import { LocalAiDriver, OpenRouterDriver } from "./openai-compatible.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  GrokDriver,
  GrokAgentDriver,
  GeminiAgentDriver,
  ClaudeDriver,
  CodexDriver,
  BoxAgentDriver,
  HermesDriver,
  OpenClawDriver,
  CopilotDriver,
  LocalAiDriver,
  OpenRouterDriver,
];
