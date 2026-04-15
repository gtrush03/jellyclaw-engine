/**
 * WebFetch tool — parity with Claude Code's `WebFetch`.
 *
 * Fetches a public URL, enforces SSRF protections, caps body size + time, and
 * returns either the raw text or (for HTML) a Markdown conversion via Turndown.
 *
 * Security guarantees:
 *   - Only `http:` and `https:` are allowed. File / data / javascript / gopher
 *     / ftp etc. are rejected up-front.
 *   - Hostname DNS is resolved *before* the request and every resolved address
 *     is matched against a blocklist of private / loopback / link-local /
 *     multicast / ULA / reserved ranges (via `ipaddr.js`). Literal IPs are
 *     checked directly (no DNS round-trip needed).
 *   - Redirects are followed manually (up to 5 hops) and every hop re-runs the
 *     same protocol + SSRF preflight. The only permission key that can bypass
 *     the check is `webfetch.localhost`, and it only bypasses the *loopback*
 *     category — RFC1918 / link-local / ULA are never skippable.
 *   - Outbound headers are whitelisted: User-Agent + Accept only. Authorization
 *     / Cookie / Proxy-Authorization are never forwarded.
 *   - Body is streamed with a byte counter and aborted if cumulative bytes
 *     exceed 10 MB. `content-length` is not trusted.
 *
 * Content-type dispatch:
 *   - `text/html`                  → converted to Markdown via Turndown
 *   - `text/plain` / `text/markdown` / `application/json` / `application/xml`
 *                                  → returned as-is (UTF-8 decoded)
 *   - anything else                → rejected with `ToolError("UnsupportedContentType")`
 */

import { lookup } from "node:dns/promises";
import type { Readable } from "node:stream";
import ipaddr from "ipaddr.js";
import TurndownService from "turndown";
import { request } from "undici";
import { z } from "zod";
import webfetchSchema from "../../../test/fixtures/tools/claude-code-schemas/webfetch.json" with {
  type: "json",
};
import {
  type JsonSchema,
  SsrfBlockedError,
  type Tool,
  type ToolContext,
  ToolError,
  WebFetchProtocolError,
  WebFetchSizeError,
} from "./types.js";

const MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "jellyclaw/0.x (+https://github.com/gtrush03/jellyclaw-engine)";
const LOCALHOST_PERMISSION_KEY = "webfetch.localhost";

export const webfetchInputSchema = z.object({
  url: z.string().url(),
  prompt: z.string().min(1),
});

export type WebfetchInput = z.input<typeof webfetchInputSchema>;

export interface WebfetchOutput {
  content: string;
  final_url: string;
  content_type: string;
  bytes: number;
}

type RangeLabel = string;

/**
 * Blocked range labels. "unicast" (public) is the only label we permit
 * outright. "loopback" is permitted only when `webfetch.localhost` is allowed.
 * "reserved" is blocked defensively — many reserved ranges have unpredictable
 * semantics and we'd rather refuse than send traffic there.
 */
const ALWAYS_BLOCKED_V4: ReadonlySet<RangeLabel> = new Set([
  "private",
  "linkLocal",
  "multicast",
  "unspecified",
  "broadcast",
  "carrierGradeNat",
  "reserved",
  "as112",
]);

const ALWAYS_BLOCKED_V6: ReadonlySet<RangeLabel> = new Set([
  "linkLocal",
  "uniqueLocal",
  "multicast",
  "unspecified",
  "reserved",
  "rfc6145",
  "rfc6052",
  "6to4",
  "teredo",
  "as112v6",
  "orchid2",
]);

/**
 * Classify an address. Returns `null` if the address is publicly routable.
 * Returns a string label if it is in a blocked range — callers decide whether
 * the `webfetch.localhost` override can bypass it (only "loopback" is
 * skippable).
 */
function classifyAddress(addr: string): RangeLabel | null {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(addr);
  } catch {
    // If we can't even parse it, refuse — safer than forwarding an unknown.
    return "unparseable";
  }

  // Unwrap IPv4-mapped IPv6 (::ffff:10.0.0.1) and re-check the embedded v4.
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      parsed = v6.toIPv4Address();
    }
  }

  const range = parsed.range();
  if (parsed.kind() === "ipv4") {
    if (range === "unicast") return null;
    if (range === "loopback") return "loopback";
    if (ALWAYS_BLOCKED_V4.has(range)) return range;
    // Unknown label — refuse defensively.
    return range;
  }
  if (range === "unicast") return null;
  if (range === "loopback") return "loopback";
  if (ALWAYS_BLOCKED_V6.has(range)) return range;
  return range;
}

interface PreflightResult {
  readonly addresses: readonly string[];
}

async function ssrfPreflight(url: URL, ctx: ToolContext): Promise<PreflightResult> {
  const host = url.hostname;
  // Strip IPv6 brackets if URL.hostname still contains them (some Node versions
  // leave them in).
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  let addresses: string[];
  if (ipaddr.isValid(bareHost)) {
    // Literal IP — no DNS lookup needed.
    addresses = [bareHost];
  } else {
    try {
      const resolved = await lookup(bareHost, { all: true, verbatim: true });
      addresses = resolved.map((r) => r.address);
    } catch (err) {
      throw new ToolError("DnsLookupFailed", `DNS lookup failed for ${bareHost}`, {
        host: bareHost,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const allowLoopback = ctx.permissions.isAllowed(LOCALHOST_PERMISSION_KEY);

  for (const addr of addresses) {
    const label = classifyAddress(addr);
    if (label === null) continue;
    if (label === "loopback" && allowLoopback) continue;
    throw new SsrfBlockedError(url.toString(), addr, label);
  }

  return { addresses };
}

function parseContentType(raw: string | undefined): string {
  if (!raw) return "application/octet-stream";
  const semi = raw.indexOf(";");
  const base = semi === -1 ? raw : raw.slice(0, semi);
  return base.trim().toLowerCase();
}

function isHtml(ct: string): boolean {
  return ct === "text/html" || ct.startsWith("text/html");
}

const PASSTHROUGH_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/json",
  "application/ld+json",
  "application/xml",
  "text/xml",
]);

function isPassthrough(ct: string): boolean {
  if (PASSTHROUGH_TYPES.has(ct)) return true;
  // Accept `+json` suffixes (e.g. application/vnd.foo+json) as JSON passthrough.
  if (ct.endsWith("+json") || ct.endsWith("+xml")) return true;
  return false;
}

async function readCappedBody(body: Readable, url: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    total += buf.byteLength;
    if (total > MAX_BYTES) {
      // Abort the upstream read; the returned Buffer is discarded anyway.
      body.destroy();
      throw new WebFetchSizeError(url, MAX_BYTES);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  return td.turndown(html);
}

function resolveRedirect(currentUrl: URL, location: string): URL {
  // `new URL(location, base)` handles both absolute and relative Location headers.
  return new URL(location, currentUrl);
}

function assertHttpProtocol(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchProtocolError(url.toString(), url.protocol);
  }
}

export const webfetchTool: Tool<WebfetchInput, WebfetchOutput> = {
  name: "WebFetch",
  description:
    "Fetch a public URL and return its content. HTML is converted to Markdown. SSRF-protected (refuses private/loopback/link-local addresses) and capped at 10MB / 30s.",
  inputSchema: webfetchSchema as JsonSchema,
  zodSchema: webfetchInputSchema as unknown as z.ZodType<WebfetchInput>,
  overridesOpenCode: true,
  async handler(input, ctx) {
    const parsed = webfetchInputSchema.parse(input);
    ctx.logger.debug({ prompt: parsed.prompt }, "webfetch.prompt");

    let currentUrl = new URL(parsed.url);
    assertHttpProtocol(currentUrl);
    await ssrfPreflight(currentUrl, ctx);

    let hops = 0;
    // Loop — break on non-3xx, throw on too many redirects.
    for (;;) {
      const res = await request(currentUrl, {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html, text/plain, text/markdown, application/json, */*;q=0.1",
        },
        signal: ctx.abort,
        headersTimeout: DEFAULT_TIMEOUT_MS,
        bodyTimeout: DEFAULT_TIMEOUT_MS,
        // Note: `request()` does NOT auto-follow redirects (unlike `fetch`).
        // We handle redirects manually below so every hop re-runs SSRF preflight.
      });

      const status = res.statusCode;
      if (status >= 300 && status < 400) {
        const locationHeader = res.headers.location;
        const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
        // Drain + discard the body so the socket can be reused.
        await res.body.dump();
        if (!location) {
          throw new ToolError(
            "WebFetchRedirectMissingLocation",
            `Redirect ${status} without Location header from ${currentUrl.toString()}`,
            { url: currentUrl.toString(), status },
          );
        }
        hops += 1;
        if (hops > MAX_REDIRECTS) {
          throw new ToolError(
            "WebFetchTooManyRedirects",
            `Exceeded ${MAX_REDIRECTS} redirect hops starting from ${parsed.url}`,
            { url: parsed.url, max_redirects: MAX_REDIRECTS },
          );
        }
        const nextUrl = resolveRedirect(currentUrl, location);
        assertHttpProtocol(nextUrl);
        await ssrfPreflight(nextUrl, ctx);
        currentUrl = nextUrl;
        continue;
      }

      if (status >= 400) {
        await res.body.dump();
        throw new ToolError(
          "WebFetchHttpError",
          `WebFetch received HTTP ${status} from ${currentUrl.toString()}`,
          { url: currentUrl.toString(), status },
        );
      }

      const ct = parseContentType(
        Array.isArray(res.headers["content-type"])
          ? res.headers["content-type"][0]
          : res.headers["content-type"],
      );

      const bodyBuf = await readCappedBody(res.body, currentUrl.toString());
      const bytes = bodyBuf.byteLength;

      if (isHtml(ct)) {
        const html = bodyBuf.toString("utf8");
        const md = htmlToMarkdown(html);
        return {
          content: md,
          final_url: currentUrl.toString(),
          content_type: ct,
          bytes,
        };
      }

      if (isPassthrough(ct)) {
        return {
          content: bodyBuf.toString("utf8"),
          final_url: currentUrl.toString(),
          content_type: ct,
          bytes,
        };
      }

      throw new ToolError("UnsupportedContentType", `unsupported content-type: ${ct}`, {
        content_type: ct,
      });
    }
  },
};
