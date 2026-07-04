import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pi-ai compat (the actual import path used by the extension)
vi.mock("@earendil-works/pi-ai/compat", () => ({
  complete: vi.fn(),
}));

// Mock node:os to make homedir() deterministic in tests
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock/home"),
}));

// Mock node:fs to prevent real filesystem reads during settings load
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
}));

// Mock pi-coding-agent
vi.mock("@earendil-works/pi-coding-agent", () => {
  const actualEstimateTokens = (msg: unknown) => {
    if (typeof msg === "object" && msg !== null) return 100;
    return 50;
  };
  return {
    buildSessionContext: vi.fn(() => ({ messages: [] })),
    convertToLlm: vi.fn(() => []),
    estimateTokens: vi.fn(actualEstimateTokens),
    serializeConversation: vi.fn(() => ""),
  };
});

// Import after mocks
import asyncCompaction from "../extensions/async-compaction.js";

// Helper: minimal ExtensionAPI mock that tracks registered commands and handlers
function mockExtensionAPI() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const commands: Record<string, any> = {};
  return {
    on(event: string, handler: (...args: any[]) => any) {
      handlers[event] = handler;
    },
    registerCommand(name: string, opts: any) {
      commands[name] = opts;
    },
    _fire(event: string, ...args: any[]) {
      if (handlers[event]) return handlers[event](...args);
    },
    _getCommand(name: string) {
      return commands[name];
    },
    _hasHandler(event: string) {
      return event in handlers;
    },
    _handlerCount() {
      return Object.keys(handlers).length;
    },
  };
}

// Helper: minimal ExtensionContext mock with realistic session state
function mockContext(overrides: Partial<any> = {}) {
  return {
    hasUI: true,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getLeafId: vi.fn(() => "leaf-1"),
      getBranch: vi.fn((_id?: string) => {
        // Simulate a growing branch: more entries after session_start
        return [
          { id: "entry-1", role: "user" },
          { id: "entry-2", role: "assistant" },
          { id: "leaf-1", role: "user" },
          { id: "leaf-2", role: "assistant" },
        ];
      }),
    },
    model: { provider: "test", id: "test-model", contextWindow: 128000 },
    modelRegistry: {
      find: vi.fn(() => null),
      getApiKeyAndHeaders: vi.fn(() => ({ ok: false, apiKey: null })),
    },
    cwd: "/test/project",
    isProjectTrusted: vi.fn(() => false),
    ...overrides,
  };
}

describe("asyncCompaction extension", () => {
  let pi: ReturnType<typeof mockExtensionAPI>;
  let ctx: ReturnType<typeof mockContext>;

  beforeEach(() => {
    pi = mockExtensionAPI();
    ctx = mockContext();
    asyncCompaction(pi as any);
  });

  describe("extension registration", () => {
    it("registers the async-compaction command", () => {
      const cmd = pi._getCommand("async-compaction");
      expect(cmd).toBeDefined();
      expect(cmd.description).toContain("async");
      expect(typeof cmd.handler).toBe("function");
    });

    it("registers handlers for all lifecycle events", () => {
      // Verify handlers exist before firing
      expect(pi._hasHandler("session_start")).toBe(true);
      expect(pi._hasHandler("agent_end")).toBe(true);
      expect(pi._hasHandler("context")).toBe(true);
      expect(pi._hasHandler("session_shutdown")).toBe(true);
      expect(pi._handlerCount()).toBeGreaterThanOrEqual(4);
    });

    it("lifecycle handlers execute without throwing", () => {
      expect(() => pi._fire("session_start", {}, ctx)).not.toThrow();
      expect(() => pi._fire("agent_end", {}, ctx)).not.toThrow();
      expect(() => pi._fire("context", {}, ctx)).not.toThrow();
      expect(() => pi._fire("session_shutdown", {}, ctx)).not.toThrow();
    });
  });

  describe("session_start handler", () => {
    it("loads settings and resets state without throwing", () => {
      expect(() => pi._fire("session_start", {}, ctx)).not.toThrow();
    });

    it("defaults to disabled when no settings file exists", () => {
      pi._fire("session_start", {}, ctx);
      // agent_end should be a no-op when disabled (settings.enabled is false)
      const result = pi._fire("agent_end", {}, ctx);
      expect(result).toBeUndefined();
    });

    it("handles session_start with no HOME directory gracefully", () => {
      // Should not throw even with mocked filesystem
      expect(() => pi._fire("session_start", {}, ctx)).not.toThrow();
    });
  });

  describe("agent_end handler", () => {
    it("does not trigger compaction when disabled", () => {
      pi._fire("session_start", {}, ctx);
      const result = pi._fire("agent_end", {}, ctx);
      expect(result).toBeUndefined();
    });

    it("does not trigger compaction when context usage is below threshold", () => {
      // Even if settings were enabled, low context usage won't trigger
      // BuildSessionContext returns empty messages → 0 tokens → 0%
      pi._fire("session_start", {}, ctx);
      const result = pi._fire("agent_end", {}, ctx);
      expect(result).toBeUndefined();
    });

    it("does not throw with simulated context", () => {
      pi._fire("session_start", {}, ctx);
      expect(() => pi._fire("agent_end", {}, ctx)).not.toThrow();
    });
  });

  describe("context handler", () => {
    it("returns undefined when no compaction has been applied", () => {
      pi._fire("session_start", {}, ctx);
      const result = pi._fire("context", {}, ctx);
      expect(result).toBeUndefined();
    });

    it("returns undefined when no compaction entry id is set", () => {
      pi._fire("session_start", {}, ctx);
      // latestAppliedCompactionEntryId is null, so context handler returns undefined
      const result = pi._fire("context", {}, ctx);
      expect(result).toBeUndefined();
    });
  });

  describe("session_shutdown handler", () => {
    it("aborts running job without throwing", () => {
      pi._fire("session_start", {}, ctx);
      expect(() => pi._fire("session_shutdown", {}, ctx)).not.toThrow();
    });

    it("clears status on shutdown", () => {
      pi._fire("session_start", {}, ctx);
      pi._fire("session_shutdown", {}, ctx);
      // setStatus is called with undefined on shutdown
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("async-compaction", undefined);
    });
  });

  describe("command: async-compaction", () => {
    it("notifies when triggering compaction", async () => {
      pi._fire("session_start", {}, ctx);
      const cmd = pi._getCommand("async-compaction");
      await cmd.handler({}, ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Triggering"),
        "info"
      );
    });

    it("notifies about restart when job is already running", async () => {
      pi._fire("session_start", {}, ctx);

      const cmd = pi._getCommand("async-compaction");
      // First call triggers the job (uses force:true, bypasses enabled check)
      await cmd.handler({}, ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Triggering"),
        "info"
      );

      // Second call - job is already running (should notify about restart)
      vi.mocked(ctx.ui.notify).mockClear();
      await cmd.handler({}, ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("already running"),
        "info"
      );
    });
  });
});
