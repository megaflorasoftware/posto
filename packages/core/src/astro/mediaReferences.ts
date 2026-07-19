import type { Field } from "../pagescms/config";
import { parseProps, scanJsxBlock } from "../mdx/mdx";
import { propJsValue, UNPARSED } from "../mdx/propFields";
import type { MediaUsage } from "./imageLibrary";

export interface MediaReferenceIndex {
  usages: MediaUsage[];
  complete: boolean;
  errors: { sourcePath: string; message: string }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function target(field: Field): string | null {
  return field.type === "reference" && field.options?.imageLibrary === true && typeof field.options.collection === "string"
    ? field.options.collection
    : null;
}

function indexField(
  field: Field,
  value: unknown,
  path: (string | number)[],
  sourcePath: string,
  usages: MediaUsage[],
): void {
  const collection = target(field);
  if (collection) {
    const values = field.list ? (Array.isArray(value) ? value : []) : [value];
    values.forEach((item, index) => {
      if (typeof item === "string" && item !== "") {
        usages.push({
          sourcePath,
          valuePath: field.list ? [...path, index] : path,
          targetCollection: collection,
          entryId: item,
          required: field.required === true,
        });
      }
    });
    return;
  }
  if (field.type !== "object") return;
  const values = field.list ? (Array.isArray(value) ? value : []) : [value];
  values.forEach((item, index) => {
    if (!record(item)) return;
    const base = field.list ? [...path, index] : path;
    for (const child of field.fields ?? []) {
      indexField(child, item[child.name], [...base, child.name], sourcePath, usages);
    }
  });
}

/** Indexes image-library references in already-parsed frontmatter/data. */
export function indexSchemaMediaReferences(input: {
  sourcePath: string;
  fields: Field[];
  values: Record<string, unknown>;
  parseError?: string;
}): MediaReferenceIndex {
  if (input.parseError) {
    return { usages: [], complete: false, errors: [{ sourcePath: input.sourcePath, message: input.parseError }] };
  }
  const usages: MediaUsage[] = [];
  for (const field of input.fields) {
    indexField(field, input.values[field.name], [field.name], input.sourcePath, usages);
  }
  return { usages, complete: true, errors: [] };
}

export interface MdxMediaComponent {
  name: string;
  fields: Field[];
}

/** Indexes literal ID props in MDX component tags. Dynamic expressions make
 * coverage conservative because their runtime value cannot be known. */
export function indexMdxMediaReferences(input: {
  sourcePath: string;
  source: string;
  components: MdxMediaComponent[];
}): MediaReferenceIndex {
  const usages: MediaUsage[] = [];
  const errors: MediaReferenceIndex["errors"] = [];
  let complete = true;
  const tag = /<[A-Z][\w.]*/g;
  for (let match = tag.exec(input.source); match; match = tag.exec(input.source)) {
    const component = input.components.find((candidate) => candidate.name === match![0].slice(1));
    if (!component) continue;
    const block = scanJsxBlock(input.source.slice(match.index));
    if (!block) {
      complete = false;
      errors.push({ sourcePath: input.sourcePath, message: `Could not parse ${component.name} at offset ${match.index}.` });
      continue;
    }
    const props = parseProps(block.propsSource);
    if (!props) {
      complete = false;
      errors.push({ sourcePath: input.sourcePath, message: `Could not parse ${component.name} props at offset ${match.index}.` });
      continue;
    }
    for (const field of component.fields) {
      const collection = target(field);
      if (!collection) continue;
      const prop = props.find((candidate) => candidate.name === field.name);
      if (!prop) continue;
      const value = propJsValue(prop);
      if (value === UNPARSED) {
        complete = false;
        errors.push({ sourcePath: input.sourcePath, message: `Dynamic ${component.name}.${field.name} prevents complete reference coverage.` });
      } else if (typeof value === "string" && value !== "") {
        usages.push({
          sourcePath: input.sourcePath,
          component: { name: component.name, prop: field.name, offset: match.index },
          targetCollection: collection,
          entryId: value,
          required: field.required === true,
        });
      }
    }
  }
  return { usages, complete, errors };
}

export function mergeMediaReferenceIndexes(indexes: MediaReferenceIndex[]): MediaReferenceIndex {
  return {
    usages: indexes.flatMap((index) => index.usages),
    complete: indexes.every((index) => index.complete),
    errors: indexes.flatMap((index) => index.errors),
  };
}
