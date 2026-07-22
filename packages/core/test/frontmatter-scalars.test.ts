import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { scalarFrontmatter } from "../src/pagescms/frontmatterScalars";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/frontmatter-scalars.md", import.meta.url)),
  "utf8",
);

const expected = {
  title: "A: colon",
  slug: "hello:world",
  leading_zero: "01",
  integer: "12",
  decimal: "1.5",
  hexadecimal: "31",
  hexadecimal_uppercase: "0X1F",
  octal: "15",
  octal_uppercase: "0O17",
  enabled: "true",
  disabled: "false",
  legacy_boolean: "yes",
  plain_with_comment: "visible",
};

describe("scalarFrontmatter", () => {
  test("normalizes the shared scalar parity fixture", () => {
    expect(scalarFrontmatter(fixture)).toEqual(expected);
  });

  test("returns null for absent or invalid frontmatter", () => {
    expect(scalarFrontmatter("# body only")).toBeNull();
    expect(scalarFrontmatter("---\nbroken: [\n---\n")).toBeNull();
  });
});
