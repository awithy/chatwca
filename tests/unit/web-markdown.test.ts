import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownContent } from "../../src/web/src/components/MarkdownContent.js";

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownContent, { text }));
}

describe("MarkdownContent", () => {
  it("renders Markdown and GitHub-flavored tables, tasks, and strikethrough", () => {
    const html = render([
      "## Result",
      "",
      "| Name | State |",
      "| --- | --- |",
      "| build | **ready** |",
      "",
      "- [x] tested",
      "- ~~obsolete~~",
    ].join("\n"));

    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<table>");
    expect(html).toContain("<strong>ready</strong>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>obsolete</del>");
  });

  it("does not interpret raw HTML or unsafe link protocols", () => {
    const html = render([
      '<script data-secret="yes">alert(1)</script>',
      '<img src=x onerror="alert(2)">',
      "[unsafe](javascript:alert(3))",
    ].join("\n\n"));

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onerror");
  });

  it("renders incomplete streamed Markdown as safe text", () => {
    const html = render("A partial **strong marker and `code");

    expect(html).toContain("A partial **strong marker and `code");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<code>");
  });
});
