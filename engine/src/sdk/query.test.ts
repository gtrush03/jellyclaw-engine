/**
 * Tests for SDK query() function (T3-12).
 */

import { describe, expect, it } from "vitest";
import type { SDKMessage } from "./types.js";

// ---------------------------------------------------------------------------
// Test: query-import-succeeds
// ---------------------------------------------------------------------------

describe("query-import-succeeds", () => {
  it("top-level package exports `query` — import { query } from engine resolves", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.query).toBe("function");
  });

  it("query can be imported directly from sdk/index.js", async () => {
    const { query } = await import("./index.js");
    expect(typeof query).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Test: yields-sdkmessage
// ---------------------------------------------------------------------------

describe("yields-sdkmessage", () => {
  it("for-await over query({prompt}) yields objects with valid type discriminator", async () => {
    const { query } = await import("./query.js");

    const messages: SDKMessage[] = [];
    for await (const msg of query({ prompt: "hello" })) {
      messages.push(msg);
    }

    expect(messages.length).toBeGreaterThan(0);

    // Every message must have a valid type discriminator
    const validTypes = new Set(["system", "assistant", "user", "result"]);
    for (const msg of messages) {
      expect(validTypes.has(msg.type)).toBe(true);
    }

    // Should have system.init as first message
    expect(messages[0]?.type).toBe("system");
    if (messages[0]?.type === "system") {
      expect(messages[0].subtype).toBe("init");
    }

    // Should have result as last message
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg?.type).toBe("result");
  });

  it("yields assistant message with proper shape", async () => {
    const { query } = await import("./query.js");

    const messages: SDKMessage[] = [];
    for await (const msg of query({ prompt: "hello" })) {
      messages.push(msg);
    }

    const assistantMsgs = messages.filter((m) => m.type === "assistant");
    expect(assistantMsgs.length).toBeGreaterThan(0);

    const assistant = assistantMsgs[0];
    expect(assistant?.type).toBe("assistant");
    if (assistant?.type === "assistant") {
      expect(assistant.message).toBeDefined();
      expect(assistant.message.role).toBe("assistant");
      expect(assistant.message.content).toBeDefined();
      expect(Array.isArray(assistant.message.content)).toBe(true);
      expect(assistant.uuid).toBeDefined();
      expect(typeof assistant.uuid).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Test: byte-compatible-with-sdk-fixtures
// ---------------------------------------------------------------------------

describe("byte-compatible-with-sdk-fixtures", () => {
  it("messages emitted by query() match expected shape (modulo uuid/session_id)", async () => {
    const { query } = await import("./query.js");

    const messages: SDKMessage[] = [];
    for await (const msg of query({ prompt: "test" })) {
      messages.push(msg);
    }

    // Verify system.init has all required fields
    const systemInit = messages.find((m) => m.type === "system");
    expect(systemInit).toBeDefined();
    if (systemInit?.type === "system") {
      expect(systemInit.subtype).toBe("init");
      expect(systemInit.session_id).toBeDefined();
      expect(systemInit.model).toBeDefined();
      expect(systemInit.cwd).toBeDefined();
      expect(systemInit.tools).toBeDefined();
      expect(systemInit.permissionMode).toBeDefined();
      expect(systemInit.apiKeySource).toBeDefined();
      expect(systemInit.claude_code_version).toBeDefined();
      expect(systemInit.uuid).toBeDefined();
      expect(systemInit.mcp_servers).toBeDefined();
      expect(systemInit.slash_commands).toBeDefined();
      expect(systemInit.agents).toBeDefined();
      expect(systemInit.skills).toBeDefined();
      expect(systemInit.plugins).toBeDefined();
      expect(systemInit.output_style).toBeDefined();
      expect(systemInit.cache_creation).toBeDefined();
      expect(systemInit.cache_creation.ephemeral_5m_input_tokens).toBeDefined();
      expect(systemInit.cache_creation.ephemeral_1h_input_tokens).toBeDefined();
    }

    // Verify result has all required fields
    const result = messages.find((m) => m.type === "result");
    expect(result).toBeDefined();
    if (result?.type === "result") {
      expect(result.subtype).toBe("success");
      expect(result.is_error).toBe(false);
      expect(result.result).toBeDefined();
      expect(result.uuid).toBeDefined();
    }

    // Verify assistant message structure
    const assistant = messages.find((m) => m.type === "assistant");
    if (assistant?.type === "assistant") {
      expect(assistant.message.id).toBeDefined();
      expect(assistant.message.type).toBe("message");
      expect(assistant.message.role).toBe("assistant");
      expect(assistant.message.model).toBeDefined();
      expect(assistant.message.content).toBeDefined();
      expect(assistant.message.stop_reason).toBeDefined();
      expect(assistant.message.stop_sequence).toBeDefined();
      expect(assistant.parent_tool_use_id).toBeDefined();
      expect(assistant.session_id).toBeDefined();
      expect(assistant.uuid).toBeDefined();
    }
  });

  it("all uuids are unique v4 format", async () => {
    const { query } = await import("./query.js");

    const messages: SDKMessage[] = [];
    for await (const msg of query({ prompt: "test" })) {
      messages.push(msg);
    }

    const uuids = messages.map((m) => m.uuid);
    const uniqueUuids = new Set(uuids);
    expect(uniqueUuids.size).toBe(uuids.length);

    // UUID v4 format check
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const uuid of uuids) {
      expect(uuid.match(uuidRegex)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Test: abort-via-signal
// ---------------------------------------------------------------------------

describe("abort-via-signal", () => {
  it("AbortController.abort() during iteration causes the generator to return cleanly", async () => {
    const { query } = await import("./query.js");

    const abortController = new AbortController();
    const messages: SDKMessage[] = [];

    // Start iteration
    const gen = query({
      prompt: "hello",
      options: { abortController },
    });

    // Get first message
    const first = await gen.next();
    expect(first.done).toBe(false);
    if (!first.done) {
      messages.push(first.value);
    }

    // Abort immediately
    abortController.abort();

    // Continue iteration - should return cleanly without throwing
    let threw = false;
    try {
      let result = await gen.next();
      while (!result.done) {
        messages.push(result.value);
        result = await gen.next();
      }
    } catch {
      threw = true;
    }

    // Should not throw
    expect(threw).toBe(false);

    // Should have at least the system.init message
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.type).toBe("system");
  });

  it("interrupt() method aborts the generator cleanly", async () => {
    const { query } = await import("./query.js");

    const messages: SDKMessage[] = [];
    const gen = query({ prompt: "hello" });

    // Get first message
    const first = await gen.next();
    expect(first.done).toBe(false);
    if (!first.done) {
      messages.push(first.value);
    }

    // Call interrupt
    await gen.interrupt();

    // Generator should be done now
    const next = await gen.next();
    expect(next.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Additional tests
// ---------------------------------------------------------------------------

describe("query-options", () => {
  it("accepts custom cwd option", async () => {
    const { query } = await import("./query.js");

    const messages: SDKMessage[] = [];
    for await (const msg of query({ prompt: "test", options: { cwd: "/custom/path" } })) {
      messages.push(msg);
    }

    const systemInit = messages.find((m) => m.type === "system");
    if (systemInit?.type === "system") {
      expect(systemInit.cwd).toBe("/custom/path");
    }
  });

  it("accepts custom model option", async () => {
    const { query } = await import("./query.js");

    const messages: SDKMessage[] = [];
    for await (const msg of query({ prompt: "test", options: { model: "claude-opus-4" } })) {
      messages.push(msg);
    }

    const systemInit = messages.find((m) => m.type === "system");
    if (systemInit?.type === "system") {
      expect(systemInit.model).toBe("claude-opus-4");
    }
  });

  it("accepts custom permissionMode option", async () => {
    const { query } = await import("./query.js");

    const messages: SDKMessage[] = [];
    for await (const msg of query({ prompt: "test", options: { permissionMode: "plan" } })) {
      messages.push(msg);
    }

    const systemInit = messages.find((m) => m.type === "system");
    if (systemInit?.type === "system") {
      expect(systemInit.permissionMode).toBe("plan");
    }
  });
});

describe("query-async-iterable-prompt", () => {
  it("accepts AsyncIterable<UserInputMessage> as prompt", async () => {
    const { query } = await import("./query.js");

    // Create async iterable with user messages
    // biome-ignore lint/suspicious/useAwait: async generator for AsyncIterable
    async function* userMessages() {
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: "first message" },
      };
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: "second message" },
      };
    }

    const messages: SDKMessage[] = [];
    for await (const msg of query({ prompt: userMessages() })) {
      messages.push(msg);
    }

    // Should complete successfully
    expect(messages.length).toBeGreaterThan(0);
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg?.type).toBe("result");
  });
});
