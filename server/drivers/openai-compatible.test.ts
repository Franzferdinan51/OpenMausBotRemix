import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createCompatibleDriver } from "./openai-compatible.ts";
import { recordEvents } from "../testing/events.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

function localServer() {
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "qwen-local" }, { id: "llama-local" }] }));
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n');
      return res.end("data: [DONE]\n\n");
    }
    res.writeHead(404).end();
  });
  return new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    close = () => new Promise((done) => server.close(() => done()));
    resolve(`http://127.0.0.1:${port}/v1`);
  }));
}

describe("OpenAI-compatible driver", () => {
  it("discovers local models and streams a chat without a key", async () => {
    const url = await localServer();
    const driver = createCompatibleDriver("testCompatible", "Test local AI", url, "");
    const instance = await driver.create({
      instanceId: "local", displayName: "Local", environment: {}, enabled: true,
      config: { url, apiKeyEnv: "", models: ["fallback"] },
    });
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
    expect(instance.models.options.map((model) => model.id)).toEqual(["qwen-local", "llama-local"]);
    const recorded = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "thread", text: "hi", model: "qwen-local" });
    await recorded.until((event) => event.type === "turn.completed");
    expect(recorded.events.find((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toMatchObject({ text: "hello world" });
    recorded.stop();
    await instance.dispose();
  });

  it("does not probe a remote provider until its key is configured", async () => {
    const driver = createCompatibleDriver("testRemote", "Test remote", "https://example.test/v1", "TEST_PROVIDER_KEY");
    const instance = await driver.create({
      instanceId: "remote", displayName: "Remote", environment: {}, enabled: true,
      config: driver.defaultConfig(),
    });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: "no API key — set TEST_PROVIDER_KEY" });
    await instance.dispose();
  });

  it("rejects malformed endpoint configuration", () => {
    const driver = createCompatibleDriver("test", "Test", "http://127.0.0.1:11434/v1", "");
    expect(() => driver.decodeConfig({ url: "file:///tmp/model" })).toThrow(/http/);
  });
});
