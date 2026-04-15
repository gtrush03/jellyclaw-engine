import { describe, expect, it } from "vitest";

import { assertLoopback } from "./app.js";
import { BindSafetyError } from "./types.js";

describe("assertLoopback", () => {
  it("accepts 127.0.0.1", () => {
    expect(() => assertLoopback("127.0.0.1")).not.toThrow();
  });

  it("accepts ::1", () => {
    expect(() => assertLoopback("::1")).not.toThrow();
  });

  it("refuses 0.0.0.0", () => {
    expect(() => assertLoopback("0.0.0.0")).toThrow(BindSafetyError);
  });

  it("refuses ::", () => {
    expect(() => assertLoopback("::")).toThrow(BindSafetyError);
  });

  it("refuses LAN addresses", () => {
    expect(() => assertLoopback("192.168.1.10")).toThrow(BindSafetyError);
    expect(() => assertLoopback("10.0.0.5")).toThrow(BindSafetyError);
  });

  it("refuses 'localhost' hostname (DNS could resolve non-loopback)", () => {
    expect(() => assertLoopback("localhost")).toThrow(BindSafetyError);
  });

  it("refuses arbitrary hostnames", () => {
    expect(() => assertLoopback("example.com")).toThrow(BindSafetyError);
  });
});
