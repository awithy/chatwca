import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/web/src/app.css", import.meta.url),
  "utf8",
);

function paletteColor(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`).exec(css);
  if (match?.[1] === undefined) throw new Error(`Missing opaque palette color --${name}`);
  return match[1];
}

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/../g);
  if (channels === null) throw new Error(`Invalid color ${hex}`);
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrast(foreground: string, background: string): number {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function expectContrast(
  foreground: string,
  background: string,
  minimum: number,
): void {
  expect(
    contrast(paletteColor(foreground), paletteColor(background)),
    `${foreground} on ${background}`,
  ).toBeGreaterThanOrEqual(minimum);
}

describe("dark-only web design system", () => {
  it("keeps primary text and interactive controls at WCAG AA contrast", () => {
    expectContrast("text", "bg", 4.5);
    expectContrast("muted", "panel", 4.5);
    expectContrast("subtle", "panel", 4.5);
    expectContrast("accent-text", "accent", 4.5);
    expectContrast("link", "bg", 4.5);
    expectContrast("border-control", "panel-raised", 3);
    expectContrast("danger-border", "panel", 3);
    expectContrast("focus-ring", "bg", 3);
  });

  it("provides readable code and diff colors", () => {
    for (const token of ["code-text", "code-muted", "code-keyword", "code-string", "code-number"]) {
      expectContrast(token, "code-bg", 4.5);
    }
    expectContrast("diff-add-text", "diff-add-bg", 4.5);
    expectContrast("diff-remove-text", "diff-remove-bg", 4.5);
    expect(css).toContain("pre {");
    expect(css).toContain("overflow: auto;");
    expect(css).toMatch(
      /\.tool-output\s*\{[^}]*max-height:[^;}]+;[^}]*overflow: auto;/s,
    );
  });

  it("uses one palette, visible focus, and reduced motion without theme detection", () => {
    const stylesAfterRoot = css.slice(css.indexOf("}\n") + 2);
    expect(stylesAfterRoot).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(css).toContain(":focus-visible");
    expect(css).toContain("outline: 3px solid var(--focus-ring)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).not.toContain("prefers-color-scheme");
  });
});
