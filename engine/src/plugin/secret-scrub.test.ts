import { describe, expect, it } from "vitest";
import { scrubSecrets, scrubToolResult, scrubWithStats } from "./secret-scrub.js";

describe("scrubSecrets — individual rules (all 13)", () => {
  it("rule 1: anthropic sk-ant-* keys", () => {
    const input = "key=sk-ant-abcd1234efgh5678ijkl9012mnop3456";
    expect(scrubSecrets(input)).toContain("[REDACTED:anthropic]");
    expect(scrubSecrets(input)).not.toContain("abcd1234efgh");
  });

  it("rule 2: openrouter sk-or-v1-* keys", () => {
    const input = "auth: sk-or-v1-abcdef0123456789ghijklmnop";
    expect(scrubSecrets(input)).toContain("[REDACTED:openrouter]");
  });

  it("rule 3: openai sk-proj-* keys", () => {
    const input = "export OPENAI=sk-proj-abcdef0123456789ghijklmnopQRSTUV";
    const out = scrubSecrets(input);
    // env_line will eat the whole line; but on its own a bare key should hit openai.
    const bare = "token is sk-proj-abcdef0123456789ghijklmnopQRSTUV here";
    expect(scrubSecrets(bare)).toContain("[REDACTED:openai]");
    expect(out).toContain("[REDACTED:"); // redacted one way or another
  });

  it("rule 4: stripe_live sk_live_/rk_live_", () => {
    const input = "charge with sk_live_abcdefghij0123456789XYZ";
    expect(scrubSecrets(input)).toContain("[REDACTED:stripe_live]");
  });

  it("rule 5: stripe_test sk_test_/rk_test_", () => {
    const input = "testing rk_test_abcdefghij0123456789XYZ";
    expect(scrubSecrets(input)).toContain("[REDACTED:stripe_test]");
  });

  it("rule 6: aws_access AKIA* ids", () => {
    const input = "AWS_ID is AKIAIOSFODNN7EXAMPLE";
    expect(scrubSecrets(input)).toContain("[REDACTED:aws_access]");
  });

  it("rule 7: google_api AIza* keys", () => {
    const input = "google: AIzaSyA-1234567890abcdefghijklmnopqrstuvw";
    expect(scrubSecrets(input)).toContain("[REDACTED:google_api]");
  });

  it("rule 8: github_pat ghp_/gho_/ghs_/ghu_/ghr_", () => {
    const input = "gh: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
    expect(scrubSecrets(input)).toContain("[REDACTED:github_pat]");
  });

  it("rule 9: github_finepat github_pat_* fine-grained", () => {
    const input =
      "fp: github_pat_11ABCDEFGHIJKLMNOPQRSTU_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
    expect(scrubSecrets(input)).toContain("[REDACTED:github_finepat]");
  });

  it("rule 10: slack xox[abpr]- tokens", () => {
    const input = "slack = xoxb-1234567890-abcdef";
    expect(scrubSecrets(input)).toContain("[REDACTED:slack]");
  });

  it("rule 11: jwt three-segment base64url", () => {
    const input = "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123";
    expect(scrubSecrets(input)).toContain("[REDACTED:jwt]");
  });

  it("rule 12: bearer authorization header", () => {
    const input = "Authorization: Bearer abcdef0123456789XYZ==";
    expect(scrubSecrets(input)).toContain("[REDACTED:bearer]");
  });

  it("rule 12b: basic authorization header", () => {
    const input = "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l==";
    expect(scrubSecrets(input)).toContain("[REDACTED:basic]");
  });

  it("rule 13a: env_line .env-style for sensitive names", () => {
    const input = "\nDATABASE_PASSWORD=hunter2hunter2";
    expect(scrubSecrets(input)).toContain("[REDACTED:env_line]");
  });

  it("rule 13b: url_creds connection strings", () => {
    const input = "db: postgres://user:supersecretpw@db.internal:5432/app";
    expect(scrubSecrets(input)).toContain("[REDACTED:url_creds]");
  });

  it("rule 13c: qs_secret query-string secrets", () => {
    const input = "GET /?token=abcdefghijklmnop&x=1";
    expect(scrubSecrets(input)).toContain("[REDACTED:qs_secret]");
  });
});

describe("scrubSecrets — specific canonical cases", () => {
  it("redacts the exact anthropic key from the brief", () => {
    const input = "sk-ant-abcd1234efgh5678ijkl9012mnop3456";
    expect(scrubSecrets(input)).toBe("[REDACTED:anthropic]");
  });

  it("redacts the exact JWT from the brief", () => {
    const input = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123";
    expect(scrubSecrets(input)).toBe("[REDACTED:jwt]");
  });

  it("env_line preserves preceding newline", () => {
    const input = "before\nANTHROPIC_API_KEY=sk-ant-zzz\nafter";
    const out = scrubSecrets(input);
    expect(out).toContain("\n[REDACTED:env_line]");
    expect(out.startsWith("before\n")).toBe(true);
    expect(out).toContain("\nafter");
    expect(out).not.toContain("sk-ant-zzz");
  });

  it("narrative prose containing api_key= mid-sentence does not trigger env_line", () => {
    const input = "As documented, the api_key=foo parameter is required.";
    const { stats } = scrubWithStats(input);
    expect(stats.byRule.env_line).toBeUndefined();
  });

  it("empty string returns empty string without crashing", () => {
    expect(scrubSecrets("")).toBe("");
    const { output, stats } = scrubWithStats("");
    expect(output).toBe("");
    expect(stats.total).toBe(0);
  });
});

describe("scrubSecrets — stats counter", () => {
  it("increments total and byRule counters per match", () => {
    const input =
      "a=sk-ant-abcd1234efgh5678ijkl9012mnop3456 b=sk-ant-wxyz1234efgh5678ijkl9012mnop9999";
    const stats = { total: 0, byRule: {} as Record<string, number> };
    scrubSecrets(input, stats);
    expect(stats.total).toBe(2);
    expect(stats.byRule.anthropic).toBe(2);
  });

  it("scrubWithStats returns matching output and stats", () => {
    const input = "tok: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123";
    const { output, stats } = scrubWithStats(input);
    expect(output).toContain("[REDACTED:jwt]");
    expect(stats.total).toBe(1);
    expect(stats.byRule.jwt).toBe(1);
  });
});

describe("scrubSecrets — extraLiterals", () => {
  it("redacts a literal that no regex would catch", () => {
    const input = "server pw is my-server-password-abc right there";
    const out = scrubSecrets(input, undefined, {
      extraLiterals: ["my-server-password-abc"],
    });
    expect(out).toContain("[REDACTED:literal]");
    expect(out).not.toContain("my-server-password-abc");
  });

  it("escapes regex metacharacters in literal", () => {
    const input = "value is [a.b+c?]*secret here";
    const out = scrubSecrets(input, undefined, {
      extraLiterals: ["[a.b+c?]*secret"],
    });
    expect(out).toContain("[REDACTED:literal]");
    expect(out).not.toContain("[a.b+c?]*secret");
  });

  it("stats count literal redactions under the 'literal' bucket", () => {
    const { stats } = scrubWithStats("x y x", { extraLiterals: ["x"] });
    expect(stats.byRule.literal).toBe(2);
    expect(stats.total).toBe(2);
  });
});

describe("scrubToolResult — recursive structured walk", () => {
  it("scrubs strings nested inside objects and arrays", () => {
    const input = {
      output: "key=sk-ant-abcd1234efgh5678ijkl9012mnop3456",
      nested: {
        field: [
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123",
          "clean text",
          { deeper: "AKIAIOSFODNN7EXAMPLE" },
        ],
      },
      count: 42,
      ok: true,
      missing: null,
    };
    const out = scrubToolResult(input);
    expect(out.output).toContain("[REDACTED:anthropic]");
    const first = out.nested.field[0];
    const third = out.nested.field[2] as { deeper: string };
    expect(first).toContain("[REDACTED:jwt]");
    expect(out.nested.field[1]).toBe("clean text");
    expect(third.deeper).toContain("[REDACTED:aws_access]");
    expect(out.count).toBe(42);
    expect(out.ok).toBe(true);
    expect(out.missing).toBeNull();
  });

  it("returns primitives untouched", () => {
    expect(scrubToolResult(42)).toBe(42);
    expect(scrubToolResult(true)).toBe(true);
    expect(scrubToolResult(null)).toBeNull();
  });

  it("applies extraLiterals to nested strings", () => {
    const input = { a: "my-server-password-abc", b: [{ c: "my-server-password-abc" }] };
    const out = scrubToolResult(input, { extraLiterals: ["my-server-password-abc"] });
    expect(out.a).toBe("[REDACTED:literal]");
    expect(out.b[0]?.c).toBe("[REDACTED:literal]");
  });
});
