import { test } from "vitest";
import {
  appendDataEntry,
  dataDocumentEntries,
  dataEntryValues,
  parseDataDocument,
  removeDataEntry,
  serializeDataDocument,
  setDataValue,
} from "../src/astro/dataDocument";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

test("edits, appends, and removes JSON array entries", () => {
  const json = parseDataDocument('[{"id":"one","title":"One"}]\n', "json");
  const jsonEntry = dataDocumentEntries(json)[0];
  assert(jsonEntry.id === "one" && jsonEntry.path[0] === 0, "JSON root array entry");
  setDataValue(json, [...jsonEntry.path, "title"], "Updated");
  setDataValue(json, [...jsonEntry.path, "profile", "name"], "Nested");
  assert(
    dataEntryValues(json, jsonEntry)?.profile &&
      typeof dataEntryValues(json, jsonEntry)?.profile === "object",
    "missing object paths materialize",
  );
  const added = appendDataEntry(json, { id: "two", title: "Two" });
  assert(added?.id === "two", "JSON entry appended");
  assert(JSON.parse(serializeDataDocument(json)).length === 2, "JSON document serialized");
  removeDataEntry(json, jsonEntry);
  assert(
    dataDocumentEntries(json)
      .map((entry) => entry.id)
      .join(",") === "two",
    "JSON entry removed",
  );
});

test("preserves comments across YAML edits", () => {
  const yaml = parseDataDocument(
    `# authors
- id: one
  title: One # keep me
`,
    "yaml",
  );
  const yamlEntry = dataDocumentEntries(yaml)[0];
  setDataValue(yaml, [...yamlEntry.path, "title"], "Updated");
  appendDataEntry(yaml, { id: "two", title: "Two" });
  const yamlSource = serializeDataDocument(yaml);
  assert(yamlSource.includes("# authors"), "YAML document comments survive edits");
  assert(
    dataDocumentEntries(parseDataDocument(yamlSource, "yaml")).length === 2,
    "YAML array round trip",
  );
});

test("round trips TOML keyed records", () => {
  const tomlRecord = parseDataDocument(
    `[one]
title = "One"

[two]
title = "Two"
`,
    "toml",
  );
  assert(
    dataDocumentEntries(tomlRecord)
      .map((entry) => entry.id)
      .join(",") === "one,two",
    "TOML keyed entries",
  );
  const tomlOne = dataDocumentEntries(tomlRecord)[0];
  setDataValue(tomlRecord, [...tomlOne.path, "title"], "Updated");
  assert(
    dataEntryValues(parseDataDocument(serializeDataDocument(tomlRecord), "toml"), tomlOne)
      ?.title === "Updated",
    "TOML record round trip",
  );
});

test("round trips TOML arrays of tables", () => {
  const tomlArray = parseDataDocument(
    `[[authors]]
id = "one"
title = "One"

[[authors]]
id = "two"
title = "Two"
`,
    "toml",
  );
  assert(
    dataDocumentEntries(tomlArray)
      .map((entry) => entry.id)
      .join(",") === "one,two",
    "TOML array-of-tables entries",
  );
  appendDataEntry(tomlArray, { id: "three", title: "Three" });
  assert(
    dataDocumentEntries(parseDataDocument(serializeDataDocument(tomlArray), "toml")).length === 3,
    "TOML array-of-tables append round trip",
  );
});
