import { createContext, useContext } from "react";
import { Extension, Node, type MarkdownToken } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Card, Textarea, TextInput } from "@mantine/core";
import { SquareArrowDownRight } from "lucide-react";

import {
  type AstroPropDef,
  type MdxProp,
  importInfo,
  parseProps,
  scanJsxBlock,
  serializeJsx,
} from "../mdx/mdx";

/** Props interfaces of imported Astro components, keyed by local name. */
export const MdxSchemaContext = createContext<Record<string, AstroPropDef[]>>({});

/* --- Imports: `import X from '…'` rendered as a pill. --------------------- */

function ImportPillView(props: NodeViewProps) {
  const statement = String(props.node.attrs.statement ?? "");
  const { names } = importInfo(statement);
  return (
    <NodeViewWrapper className="mdx-import">
      <span className="mdx-pill" title={statement}>
        <SquareArrowDownRight size={14} />
        <span>{names.length > 0 ? names.join(", ") : statement}</span>
      </span>
    </NodeViewWrapper>
  );
}

export const MdxImport = Node.create({
  name: "mdxImport",
  group: "block",
  atom: true,
  addAttributes() {
    return { statement: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-mdx-import]" }];
  },
  renderHTML({ node }) {
    return ["div", { "data-mdx-import": node.attrs.statement }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImportPillView);
  },
  markdownTokenizer: {
    name: "mdxImport",
    level: "block",
    start: (src: string) => {
      const match = /(^|\n)import\s/.exec(src);
      return match ? match.index + match[1].length : -1;
    },
    tokenize: (src: string) => {
      const first = /^import\s[^\n]*/.exec(src);
      if (!first) return undefined;
      let raw = first[0];
      // Multi-line named imports: extend until braces balance.
      let rest = src.slice(raw.length);
      while (
        (raw.match(/\{/g)?.length ?? 0) > (raw.match(/\}/g)?.length ?? 0) &&
        rest.startsWith("\n")
      ) {
        const line = /^\n[^\n]*/.exec(rest);
        if (!line) break;
        raw += line[0];
        rest = rest.slice(line[0].length);
      }
      return { type: "mdxImport", raw };
    },
  },
  parseMarkdown: (token, helpers) =>
    helpers.createNode("mdxImport", { statement: (token.raw ?? "").trimEnd() }),
  renderMarkdown: (node) => String(node.attrs?.statement ?? ""),
});

/* --- Components: `<Widget prop="x">…</Widget>` rendered as a card. -------- */

function schemaKind(type: string): MdxProp["kind"] {
  return type.replace(/\s/g, "") === "string" ? "string" : "expression";
}

function ComponentCardView(props: NodeViewProps) {
  const schemas = useContext(MdxSchemaContext);
  const name = String(props.node.attrs.name ?? "");
  const existing = (props.node.attrs.props ?? []) as MdxProp[];
  const children = props.node.attrs.children as string | null;
  const schema = schemas[name] ?? [];

  // Existing props in source order, then schema-declared props not yet set.
  const rows: { prop: MdxProp; def: AstroPropDef | null }[] = existing.map((prop) => ({
    prop,
    def: schema.find((d) => d.name === prop.name) ?? null,
  }));
  for (const def of schema) {
    if (!existing.some((p) => p.name === def.name)) {
      rows.push({ prop: { name: def.name, value: "", kind: schemaKind(def.type) }, def });
    }
  }

  function editProp(name: string, value: string) {
    const next = existing.some((p) => p.name === name)
      ? existing.map((p) =>
          p.name === name
            ? {
                ...p,
                value,
                // A shorthand boolean edited to anything else becomes an
                // expression so the new value survives serialization.
                kind: p.kind === "boolean" && value !== "true" ? "expression" : p.kind,
              }
            : p,
        )
      : [
          ...existing,
          { name, value, kind: rows.find((r) => r.prop.name === name)?.prop.kind ?? "string" },
        ];
    props.updateAttributes({ props: next, raw: null });
  }

  // The stored children keep their original wrapping newlines; the textarea
  // shows the trimmed body and edits are re-wrapped on save.
  const childrenText = (children ?? "").replace(/^\r?\n/, "").replace(/\r?\n[ \t]*$/, "");

  function editChildren(text: string) {
    props.updateAttributes({ children: text === "" ? null : `\n${text}\n`, raw: null });
  }

  return (
    <NodeViewWrapper className="mdx-component">
      <Card withBorder padding="sm" radius="md" className="mdx-component-card">
        <div className="mdx-component-name">{name}</div>
        {props.node.attrs.props === null ? (
          <div className="mdx-component-unparsed">
            <code>{String(props.node.attrs.propsSource ?? "").trim()}</code>
          </div>
        ) : (
          rows.map(({ prop, def }) =>
            prop.kind === "spread" ? (
              <TextInput
                key={`spread-${prop.value}`}
                size="xs"
                label="(spread)"
                value={`{${prop.value}}`}
                disabled
              />
            ) : (
              <TextInput
                key={prop.name}
                size="xs"
                label={prop.name}
                placeholder={def?.type}
                leftSection={
                  prop.kind === "string" ? undefined : <span className="mdx-expr-hint">{"{}"}</span>
                }
                value={prop.value === "true" && prop.kind === "boolean" ? "true" : prop.value}
                onChange={(e) => editProp(prop.name, e.currentTarget.value)}
              />
            ),
          )
        )}
        <div className="field-label">Children</div>
        <Textarea
          size="xs"
          autosize
          minRows={2}
          maxRows={12}
          classNames={{ input: "mdx-children-input" }}
          value={childrenText}
          onChange={(e) => editChildren(e.currentTarget.value)}
        />
      </Card>
    </NodeViewWrapper>
  );
}

export const MdxComponent = Node.create({
  name: "mdxComponent",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      name: { default: "" },
      /** Parsed props, or null when the tag couldn't be parsed into a form. */
      props: { default: [] },
      propsSource: { default: "" },
      children: { default: null },
      /** Original source, emitted verbatim until the first edit. */
      raw: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-mdx-component]" }];
  },
  renderHTML({ node }) {
    return ["div", { "data-mdx-component": node.attrs.name }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComponentCardView);
  },
  markdownTokenizer: {
    name: "mdxComponent",
    level: "block",
    start: (src: string) => {
      const match = /(^|\n)<[A-Z]/.exec(src);
      return match ? match.index + match[1].length : -1;
    },
    tokenize: (src: string) => {
      const block = scanJsxBlock(src);
      if (!block) return undefined;
      return { type: "mdxComponent", raw: block.raw, block } as MarkdownToken;
    },
  },
  parseMarkdown: (token, helpers) => {
    const block = (token as MarkdownToken & { block: ReturnType<typeof scanJsxBlock> }).block!;
    return helpers.createNode("mdxComponent", {
      name: block.name,
      props: parseProps(block.propsSource),
      propsSource: block.propsSource,
      children: block.children,
      raw: block.raw,
    });
  },
  renderMarkdown: (node) => {
    const attrs = node.attrs ?? {};
    if (typeof attrs.raw === "string") return attrs.raw;
    if (attrs.props === null) {
      // Unparseable props: reassemble around the original tag source.
      const open = `<${attrs.name}${attrs.propsSource}`;
      return attrs.children === null
        ? `${open}/>`
        : `${open}>${attrs.children}</${attrs.name}>`;
    }
    return serializeJsx(attrs.name, attrs.props as MdxProp[], attrs.children);
  },
});

/* --- Raw preservation: exports, block expressions, inline JSX. ------------ */

function RawBlockView(props: NodeViewProps) {
  return (
    <NodeViewWrapper className="mdx-raw-block">
      <pre>{String(props.node.attrs.source ?? "")}</pre>
    </NodeViewWrapper>
  );
}

export const MdxRawBlock = Node.create({
  name: "mdxRawBlock",
  group: "block",
  atom: true,
  addAttributes() {
    return { source: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-mdx-raw]" }];
  },
  renderHTML() {
    return ["div", { "data-mdx-raw": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(RawBlockView);
  },
  markdownTokenizer: {
    name: "mdxRawBlock",
    level: "block",
    start: (src: string) => {
      const match = /(^|\n)(export\s|\{)/.exec(src);
      return match ? match.index + match[1].length : -1;
    },
    tokenize: (src: string) => {
      if (src.startsWith("{")) {
        // Block-level expression: consume the balanced brace group.
        let depth = 0;
        for (let i = 0; i < src.length; i++) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") {
            depth--;
            if (depth === 0) return { type: "mdxRawBlock", raw: src.slice(0, i + 1) };
          }
        }
        return undefined;
      }
      const first = /^export\s[^\n]*/.exec(src);
      if (!first) return undefined;
      let raw = first[0];
      let rest = src.slice(raw.length);
      // Extend across lines until braces/parens balance.
      const unbalanced = (s: string) =>
        (s.match(/[{(]/g)?.length ?? 0) > (s.match(/[})]/g)?.length ?? 0);
      while (unbalanced(raw) && rest.startsWith("\n")) {
        const line = /^\n[^\n]*/.exec(rest);
        if (!line) break;
        raw += line[0];
        rest = rest.slice(line[0].length);
      }
      return { type: "mdxRawBlock", raw };
    },
  },
  parseMarkdown: (token, helpers) =>
    helpers.createNode("mdxRawBlock", { source: (token.raw ?? "").trimEnd() }),
  renderMarkdown: (node) => String(node.attrs?.source ?? ""),
});

function RawInlineView(props: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" className="mdx-raw-inline">
      <code>{String(props.node.attrs.source ?? "")}</code>
    </NodeViewWrapper>
  );
}

export const MdxRawInline = Node.create({
  name: "mdxRawInline",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { source: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "span[data-mdx-raw-inline]" }];
  },
  renderHTML() {
    return ["span", { "data-mdx-raw-inline": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(RawInlineView);
  },
  markdownTokenizer: {
    name: "mdxRawInline",
    level: "inline",
    start: (src: string) => src.search(/<[A-Z]/),
    tokenize: (src: string) => {
      const block = scanJsxBlock(src);
      if (!block) return undefined;
      return { type: "mdxRawInline", raw: block.raw };
    },
  },
  parseMarkdown: (token, helpers) => helpers.createNode("mdxRawInline", { source: token.raw }),
  renderMarkdown: (node) => String(node.attrs?.source ?? ""),
});

/* --- Import cleanup: deleting a component's last use drops its import. ---- */

/**
 * Component names referenced anywhere in the document: component cards (their
 * props and children can hold nested JSX too) and preserved raw JSX.
 */
function usedComponentNames(doc: PmNode): Set<string> {
  const names = new Set<string>();
  const scanJsx = (text: string) => {
    for (const match of text.matchAll(/<([A-Z][\w.]*)[\s/>]/g)) names.add(match[1]);
  };
  doc.descendants((node) => {
    if (node.type.name === "mdxComponent") {
      names.add(String(node.attrs.name));
      scanJsx(String(node.attrs.propsSource ?? "") + " " + String(node.attrs.children ?? ""));
    } else if (node.type.name === "mdxRawBlock" || node.type.name === "mdxRawInline") {
      scanJsx(String(node.attrs.source));
    }
    return true;
  });
  return names;
}

export const MdxImportCleanup = Extension.create({
  name: "mdxImportCleanup",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const before = usedComponentNames(oldState.doc);
          const after = usedComponentNames(newState.doc);
          const dropped = [...before].filter((name) => !after.has(name));
          if (dropped.length === 0) return null;

          // Remove imports whose bindings all became unused by this change.
          // Imports that were already unused before it are left alone.
          const ranges: { from: number; to: number }[] = [];
          newState.doc.descendants((node, pos) => {
            if (node.type.name !== "mdxImport") return true;
            const { names } = importInfo(String(node.attrs.statement));
            if (
              names.length > 0 &&
              names.every((name) => !after.has(name)) &&
              names.some((name) => dropped.includes(name))
            ) {
              ranges.push({ from: pos, to: pos + node.nodeSize });
            }
            return false;
          });
          if (ranges.length === 0) return null;
          const tr = newState.tr;
          for (const range of ranges.reverse()) tr.delete(range.from, range.to);
          return tr;
        },
      }),
    ];
  },
});

export const mdxNodes = [MdxImport, MdxComponent, MdxRawBlock, MdxRawInline, MdxImportCleanup];
