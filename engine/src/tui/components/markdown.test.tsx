/**
 * Markdown renderer fuzz tests (T1-03).
 *
 * Tests 12 edge cases to ensure the markdown renderer doesn't crash on
 * malformed or unusual input.
 */

import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { brand } from "../theme/brand.js";
import { Markdown } from "./markdown.js";

describe("Markdown: fuzz tests", () => {
  const accentColor = brand.medusaViolet;

  it("handles nested lists (renders flat)", () => {
    const source = `- item 1
  - nested item
    - deeply nested
- item 2`;
    expect(() => {
      const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
      expect(lastFrame()).toContain("item 1");
    }).not.toThrow();
  });

  it("handles code block inside list", () => {
    const source = `- item with code:
\`\`\`js
const x = 1;
\`\`\`
- next item`;
    expect(() => {
      const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
      expect(lastFrame()).toContain("item with code");
    }).not.toThrow();
  });

  it("handles malformed link (missing url)", () => {
    const source = `Check this [broken link]() and [another](`;
    expect(() => {
      const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
      expect(lastFrame()).toContain("broken link");
    }).not.toThrow();
  });

  it("handles malformed link (missing close paren)", () => {
    const source = `See [link](http://example.com and more text`;
    expect(() => {
      const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
      expect(lastFrame()).toContain("link");
    }).not.toThrow();
  });

  it("handles unicode headers", () => {
    const source = `# 日本語ヘッダー
## Émoji: 🦑 Squid
### Кириллица`;
    expect(() => {
      const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
      expect(stripAnsi(lastFrame())).toContain("日本語");
    }).not.toThrow();
  });

  it("handles empty document", () => {
    expect(() => {
      const { lastFrame } = render(<Markdown source="" accentColor={accentColor} />);
      expect(lastFrame()).toBeDefined();
    }).not.toThrow();
  });

  it("handles whitespace-only document", () => {
    const source = "   \n\n   \t  \n";
    expect(() => {
      const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
      expect(lastFrame()).toBeDefined();
    }).not.toThrow();
  });

  it("handles unclosed code fence", () => {
    const source = `\`\`\`javascript
const x = 1;
// no closing fence`;
    expect(() => {
      const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
      expect(lastFrame()).toContain("const x = 1");
    }).not.toThrow();
  });

  it("handles unclosed inline code", () => {
    const source = "Some `inline code without close";
    expect(() => {
      const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
      expect(lastFrame()).toContain("inline code");
    }).not.toThrow();
  });

  it("handles deeply nested quotes", () => {
    const source = `> level 1
> > level 2
> > > level 3`;
    expect(() => {
      const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
      expect(lastFrame()).toContain("level 1");
    }).not.toThrow();
  });

  it("handles mixed formatting in one line", () => {
    const source = "**bold _italic_ ~~strike~~ `code`** normal";
    expect(() => {
      const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
      expect(lastFrame()).toContain("bold");
    }).not.toThrow();
  });

  it("handles very long lines without crashing", () => {
    const longLine = "x".repeat(10000);
    expect(() => {
      const { lastFrame } = render(<Markdown source={longLine} accentColor={accentColor} />);
      expect(lastFrame()).toBeDefined();
    }).not.toThrow();
  });

  it("handles control characters and NULs", () => {
    const source = "hello\u0000world\u001b[31mred\u001b[0m\u0007bell";
    expect(() => {
      const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
      expect(lastFrame()).toBeDefined();
    }).not.toThrow();
  });

  it("handles headers without space after hashes", () => {
    const source = "#no-space\n##also-no-space\n### spaced ok";
    expect(() => {
      const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
      expect(stripAnsi(lastFrame())).toContain("spaced ok");
    }).not.toThrow();
  });
});

describe("Markdown: basic rendering", () => {
  const accentColor = brand.medusaViolet;

  it("renders headings", () => {
    const source = `# Heading 1
## Heading 2
### Heading 3`;
    const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
    const frame = stripAnsi(lastFrame());
    expect(frame).toContain("Heading 1");
    expect(frame).toContain("Heading 2");
    expect(frame).toContain("Heading 3");
  });

  it("renders bullet lists", () => {
    const source = `- item one
- item two
- item three`;
    const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
    const frame = lastFrame();
    expect(frame).toContain("item one");
    expect(frame).toContain("item two");
    expect(frame).toContain("\u2022"); // bullet glyph • per T1-03 brief
  });

  it("renders numbered lists", () => {
    const source = `1. first
2. second
3. third`;
    const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
    const frame = lastFrame();
    expect(frame).toContain("first");
    expect(frame).toContain("second");
    expect(frame).toContain("1.");
  });

  it("renders code blocks", () => {
    const source = `\`\`\`typescript
const x: number = 42;
\`\`\``;
    const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
    const frame = lastFrame();
    expect(frame).toContain("typescript");
    expect(frame).toContain("const x");
  });

  it("renders blockquotes", () => {
    const source = `> This is a quote
> spanning multiple lines`;
    const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
    const frame = lastFrame();
    expect(frame).toContain("This is a quote");
  });

  it("renders horizontal rules", () => {
    const source = `text before

---

text after`;
    const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
    const frame = lastFrame();
    expect(frame).toContain("text before");
    expect(frame).toContain("text after");
    expect(frame).toContain("─"); // horizontal line
  });

  it("renders links", () => {
    const source = `Check [this link](https://example.com)`;
    const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
    const frame = lastFrame();
    expect(frame).toContain("this link");
    expect(frame).toContain("example.com");
  });

  it("renders inline code", () => {
    const source = "Use the `render` function";
    const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
    const frame = lastFrame();
    expect(frame).toContain("render");
  });

  it("renders bold and italic", () => {
    const source = "This is **bold** and *italic* text";
    const { lastFrame } = render(<Markdown source={source} accentColor={accentColor} />);
    const frame = lastFrame();
    expect(frame).toContain("bold");
    expect(frame).toContain("italic");
  });
});
