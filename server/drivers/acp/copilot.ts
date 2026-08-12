// GitHub Copilot CLI's documented ACP server runs over stdio with
// `copilot --acp --stdio`. The CLI owns authentication/BYOK configuration.
import { createAcpDriver, type AcpSupport } from "./core.ts";

const support: AcpSupport = {
  driverKind: "copilot",
  displayName: "GitHub Copilot",
  models: { default: "default", options: [{ id: "default", label: "Copilot default" }] },
  defaultCli: "copilot",
  nativeSource: "copilot.acp",
  loginNote: "GitHub Copilot CLI is not installed or authenticated",
  spawnArgs: () => ["--acp", "--stdio"],
  pickAuthMethod: (methods) => methods[0]?.id ?? null,
  authFailure: "continue",
  isAuthenticated: () => true,
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const CopilotDriver = createAcpDriver(support);
