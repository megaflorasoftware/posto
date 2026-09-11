import { Document } from "yaml";
import { describe, expect, test } from "vitest";
import { parseCollectionSchema } from "../src/astro/collections";
import { plainDateField } from "../src/pagescms/config";
import { setValue } from "../src/pagescms/frontmatter";

const ISO_DATE_PATTERN = "^(?:\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01]))$";

function schema(properties: Record<string, unknown>): string {
  return JSON.stringify({ type: "object", properties, required: Object.keys(properties) });
}

function frontmatter(field: Parameters<typeof plainDateField>[0], value: string): string {
  const doc = new Document({});
  setValue(doc, ["publish_date"], value, { dateField: plainDateField(field) });
  return doc.toString().trim();
}

describe("Astro date fields", () => {
  test("z.date() and z.coerce.date() become plain-scalar date fields", () => {
    // Astro's toJSONSchema override rewrites real dates as a bare date-time.
    const [field] = parseCollectionSchema(
      "posts",
      schema({ publish_date: { type: "string", format: "date-time" } }),
    )!;
    expect(field).toMatchObject({ name: "publish_date", type: "date" });
    expect(plainDateField(field)).toBe(true);
    expect(frontmatter(field, "2026-08-06")).toBe("publish_date: 2026-08-06");
  });

  test("z.string().date() stays a date field whose values keep their quotes", () => {
    const [field] = parseCollectionSchema(
      "posts",
      schema({ publish_date: { type: "string", format: "date", pattern: ISO_DATE_PATTERN } }),
    )!;
    expect(field).toMatchObject({ name: "publish_date", type: "date", options: { quoted: true } });
    expect(plainDateField(field)).toBe(false);
    expect(frontmatter(field, "2026-08-06")).toBe('publish_date: "2026-08-06"');
  });

  test("z.iso.datetime() keeps its quotes despite the date-time format", () => {
    const [field] = parseCollectionSchema(
      "posts",
      schema({ publish_date: { type: "string", format: "date-time", pattern: "^\\d{4}-" } }),
    )!;
    expect(field).toMatchObject({ type: "date", options: { quoted: true } });
    expect(frontmatter(field, "2026-08-06T10:30:00Z")).toBe('publish_date: "2026-08-06T10:30:00Z"');
  });

  test("optional string dates unwrap to the same quoted marker", () => {
    const [field] = parseCollectionSchema(
      "posts",
      JSON.stringify({
        type: "object",
        properties: {
          updated_at: {
            anyOf: [
              { type: "string", format: "date", pattern: ISO_DATE_PATTERN },
              { type: "null" },
            ],
          },
        },
      }),
    )!;
    expect(field).toMatchObject({ type: "date", options: { quoted: true }, required: undefined });
  });
});
