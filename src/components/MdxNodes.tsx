import { createContext, useContext, useState, type ReactElement, type ReactNode } from "react";
import {
  Extension,
  Node,
  type JSONContent,
  type MarkdownLexerConfiguration,
  type MarkdownToken,
} from "@tiptap/core";
import { Plugin, Selection, TextSelection } from "@tiptap/pm/state";
import { GapCursor } from "@tiptap/pm/gapcursor";
import type { Node as PmNode, ResolvedPos } from "@tiptap/pm/model";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Popover, Textarea, TextInput } from "@mantine/core";
import { Component as ComponentIcon, SquareArrowDownRight } from "lucide-react";

import {
  type AstroComponentSchema,
  type AstroPropDef,
  type MdxProp,
  type SlotPiece,
  assembleSlotChildren,
  dedent,
  importInfo,
  parseProps,
  scanAnyElement,
  scanJsxBlock,
  serializeJsx,
  slotAttr,
  splitSlots,
} from "../mdx/mdx";

/** Prop/slot schemas of imported Astro components, keyed by local name. */
export const MdxSchemaContext = createContext<Record<string, AstroComponentSchema>>({});

/**
 * The same schemas, readable outside React: the markdown pipeline and the
 * slot-sync plugin run without access to context. BodyEditor keeps both in
 * step when schemas load.
 */
export const componentSchemas: { current: Record<string, AstroComponentSchema> } = {
  current: {},
};

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

/* --- Components: `<Widget prop="x">…</Widget>` rendered as a card whose
       slot content is real editable document content. -------------------- */

function schemaKind(type: string): MdxProp["kind"] {
  return type.replace(/\s/g, "") === "string" ? "string" : "expression";
}

/**
 * Prop fields for a component, shared between the block card's header
 * popover and the inline chip popover. `parsedProps` is null when the tag's
 * props source couldn't be parsed into a form; the raw source is shown
 * instead.
 */
function PropsFields(fieldProps: {
  name: string;
  parsedProps: MdxProp[] | null;
  propsSource: string;
  onProps: (next: MdxProp[]) => void;
}) {
  const schemas = useContext(MdxSchemaContext);
  const { name, parsedProps } = fieldProps;
  const existing = parsedProps ?? [];
  const schema: AstroPropDef[] = schemas[name]?.props ?? [];

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

  function editProp(propName: string, value: string) {
    const next = existing.some((p) => p.name === propName)
      ? existing.map((p) =>
          p.name === propName
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
          {
            name: propName,
            value,
            kind: rows.find((r) => r.prop.name === propName)?.prop.kind ?? "string",
          },
        ];
    fieldProps.onProps(next as MdxProp[]);
  }

  if (parsedProps === null) {
    return (
      <div className="mdx-component-unparsed">
        <code>{fieldProps.propsSource.trim()}</code>
      </div>
    );
  }

  return (
    <div className="mdx-component-body">
      {rows.map(({ prop, def }) =>
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
      )}
    </div>
  );
}

/**
 * Per-slot children fields for inline chips, whose children stay a source
 * string. One textarea per slot: the default slot plus every named slot
 * found in the content or declared by the component's `<slot name>` tags.
 */
function SlotChildrenFields(fieldProps: {
  name: string;
  childrenSource: string | null;
  onChildren: (next: string | null) => void;
}) {
  const schemas = useContext(MdxSchemaContext);
  const schema = schemas[fieldProps.name];
  const buckets = splitSlots(fieldProps.childrenSource);
  const names = buckets.named.map((b) => b.name);
  for (const declared of schema?.slots ?? []) {
    if (!names.includes(declared)) names.push(declared);
  }
  // Hide the default-children field for components whose source declares no
  // unnamed <slot> (unless content is already there); unknown schemas keep it.
  const showDefault =
    buckets.defaultContent.trim() !== "" || schema === undefined || schema.hasDefaultSlot;
  const textOf = (slot: string) =>
    buckets.named
      .find((b) => b.name === slot)
      ?.pieces.map((p: SlotPiece) => p.text)
      .join("") ?? "";

  function update(defaultText: string, edited?: { name: string; text: string }) {
    const named = names.map((n) => ({
      name: n,
      text: edited?.name === n ? edited.text : textOf(n),
    }));
    fieldProps.onChildren(assembleSlotChildren(defaultText, named));
  }

  return (
    <>
      {showDefault && (
        <>
          <div className="field-label">Children</div>
          <Textarea
            size="xs"
            autosize
            minRows={1}
            maxRows={12}
            classNames={{ input: "mdx-children-input" }}
            value={buckets.defaultContent}
            onChange={(e) => update(e.currentTarget.value)}
          />
        </>
      )}
      {names.map((slot) => (
        <div key={slot}>
          <div className="field-label">{`Slot: ${slot}`}</div>
          <Textarea
            size="xs"
            autosize
            minRows={1}
            maxRows={12}
            classNames={{ input: "mdx-children-input" }}
            value={textOf(slot)}
            onChange={(e) => update(buckets.defaultContent, { name: slot, text: e.currentTarget.value })}
          />
        </div>
      ))}
    </>
  );
}

/** A clickable target that opens a component's edit form in a popover. */
function ComponentPopover(popoverProps: {
  name: string;
  target: (toggle: () => void) => ReactElement;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-start"
      shadow="md"
      width={320}
      trapFocus
      withinPortal
    >
      <Popover.Target>{popoverProps.target(() => setOpened((o) => !o))}</Popover.Target>
      <Popover.Dropdown className="mdx-component-dropdown">
        <div className="mdx-component-name">{popoverProps.name}</div>
        {popoverProps.children}
      </Popover.Dropdown>
    </Popover>
  );
}

/* --- Slot sections: editable child content of a component card. ----------- */

function SlotView(props: NodeViewProps) {
  const name = props.node.attrs.slot as string | null;
  return (
    <NodeViewWrapper className="mdx-slot">
      {name !== null && (
        <div className="mdx-slot-label" contentEditable={false}>
          {name}
        </div>
      )}
      <NodeViewContent className="mdx-slot-content" />
    </NodeViewWrapper>
  );
}

export const MdxSlot = Node.create({
  name: "mdxSlot",
  content: "block+",
  isolating: true,
  defining: true,
  selectable: false,
  addAttributes() {
    /** Slot name; null is the default slot. */
    return { slot: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-mdx-slot]",
        getAttrs: (el) => ({ slot: (el as HTMLElement).getAttribute("data-mdx-slot") || null }),
      },
    ];
  },
  renderHTML({ node }) {
    return ["div", { "data-mdx-slot": node.attrs.slot ?? "" }, 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(SlotView);
  },
  addKeyboardShortcuts() {
    return {
      // The gap-cursor plugin's own ArrowDown handler relies on WebKit's
      // visual line probe (`view.endOfTextblock("down")`), which misreports
      // inside nested card layouts — the browser then moves the caret
      // natively and skips the gap positions ArrowUp stops at. When the
      // caret is at the literal end of a slot's last textblock, walk the
      // document structure instead: prefer the next gap cursor position,
      // fall back to the next selectable text position.
      ArrowDown: () => {
        const { state, view } = this.editor;
        const { selection } = state;
        if (!(selection instanceof TextSelection) || !selection.empty) return false;
        const $head = selection.$head;
        if (!$head.parent.isTextblock) return false;
        if ($head.parentOffset < $head.parent.content.size) return false;

        let slotDepth = -1;
        for (let d = $head.depth; d > 0; d--) {
          if ($head.node(d).type.name === "mdxSlot") {
            slotDepth = d;
            break;
          }
        }
        if (slotDepth === -1) return false;
        // Only at the very end of the slot: every level between the slot and
        // the caret's textblock must be a last child.
        for (let d = slotDepth; d < $head.depth; d++) {
          if ($head.index(d) !== $head.node(d).childCount - 1) return false;
        }

        const findGap = (
          GapCursor as unknown as {
            findGapCursorFrom: (
              $pos: ResolvedPos,
              dir: number,
              mustMove?: boolean,
            ) => ResolvedPos | null;
          }
        ).findGapCursorFrom;
        const $gap = findGap(state.doc.resolve($head.after()), 1, false);
        if ($gap) {
          view.dispatch(state.tr.setSelection(new GapCursor($gap)).scrollIntoView());
          return true;
        }
        const next = Selection.findFrom(state.doc.resolve($head.after(slotDepth)), 1, true);
        if (!next) return false;
        view.dispatch(state.tr.setSelection(next).scrollIntoView());
        return true;
      },
    };
  },
  // Serialization is handled by the parent mdxComponent, which decides how
  // each slot wraps; this keeps renderChildren-based fallbacks sane.
  renderMarkdown: (node, helpers) => helpers.renderChildren(node.content ?? [], "\n\n"),
});

/** Slot content shipped on the component token: lexed markdown per piece,
 * or a verbatim source string for elements preserved as raw blocks. */
interface SlotTokenData {
  name: string | null;
  parts: ({ tokens: MarkdownToken[] } | { source: string })[];
}

function ComponentCardView(props: NodeViewProps) {
  const name = String(props.node.attrs.name ?? "");
  return (
    <NodeViewWrapper className="mdx-component mdx-component-card">
      <div className="mdx-card-header" contentEditable={false}>
        <ComponentPopover
          name={name}
          target={(toggle) => (
            <button type="button" className="mdx-pill mdx-component-chip" onClick={toggle}>
              <ComponentIcon size={14} />
              <span>{name}</span>
            </button>
          )}
        >
          <PropsFields
            name={name}
            parsedProps={props.node.attrs.props as MdxProp[] | null}
            propsSource={String(props.node.attrs.propsSource ?? "")}
            onProps={(next) => props.updateAttributes({ props: next, raw: null })}
          />
        </ComponentPopover>
      </div>
      <NodeViewContent className="mdx-card-slots" />
    </NodeViewWrapper>
  );
}

/** True when the rendered slot output has no visible content (the paragraph
 * extension pads blank lines with non-breaking spaces). */
function isBlankRendered(rendered: string): boolean {
  return rendered.replace(/&nbsp;|\u00a0/g, "").trim() === "";
}

export const MdxComponent = Node.create({
  name: "mdxComponent",
  group: "block",
  // Zero sections is valid: components whose .astro source declares no
  // <slot> render as a bare header card.
  content: "mdxSlot*",
  isolating: true,
  defining: true,
  addAttributes() {
    return {
      name: { default: "" },
      /** Parsed props, or null when the tag couldn't be parsed into a form. */
      props: { default: [] },
      propsSource: { default: "" },
      /** Original source, emitted verbatim until the first edit. */
      raw: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-mdx-component]" }];
  },
  renderHTML({ node }) {
    return ["div", { "data-mdx-component": node.attrs.name }, 0];
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
    tokenize: (src: string, _tokens: MarkdownToken[], lexer: MarkdownLexerConfiguration) => {
      const block = scanJsxBlock(src);
      if (!block) return undefined;
      const buckets = splitSlots(block.children);
      const markdownTokens = (text: string) => lexer.blockTokens(dedent(text).trim());
      // Only slots with content parse into sections; declared-but-empty
      // slots are added later by the slot-sync plugin once schemas load.
      const slots: SlotTokenData[] = [
        ...(buckets.defaultContent.trim() === ""
          ? []
          : [{ name: null, parts: [{ tokens: markdownTokens(buckets.defaultContent) }] }]),
        ...buckets.named.map((named) => ({
          name: named.name,
          parts: named.pieces.map((piece: SlotPiece) =>
            piece.kind === "markdown"
              ? { tokens: markdownTokens(piece.text) }
              : { source: piece.text },
          ),
        })),
      ];
      return { type: "mdxComponent", raw: block.raw, block, slots } as MarkdownToken;
    },
  },
  parseMarkdown: (token, helpers) => {
    const data = token as MarkdownToken & {
      block: ReturnType<typeof scanJsxBlock>;
      slots: SlotTokenData[];
    };
    const block = data.block!;
    const content = data.slots.map((slot) => {
      const children: JSONContent[] = [];
      for (const part of slot.parts) {
        if ("source" in part) {
          children.push(helpers.createNode("mdxRawBlock", { source: part.source }));
        } else {
          children.push(...helpers.parseChildren(part.tokens));
        }
      }
      if (children.length === 0) children.push(helpers.createNode("paragraph"));
      return helpers.createNode("mdxSlot", { slot: slot.name }, children);
    });
    return helpers.createNode(
      "mdxComponent",
      {
        name: block.name,
        props: parseProps(block.propsSource),
        propsSource: block.propsSource,
        raw: block.raw,
      },
      content,
    );
  },
  renderMarkdown: (node, helpers) => {
    const attrs = node.attrs ?? {};
    if (typeof attrs.raw === "string") return attrs.raw;
    const parts: string[] = [];
    for (const slot of (node.content ?? []) as JSONContent[]) {
      if (slot.type !== "mdxSlot") continue;
      const rendered = helpers.renderChildren(slot.content ?? [], "\n\n").trim();
      if (isBlankRendered(rendered)) continue;
      const slotName = (slot.attrs?.slot ?? null) as string | null;
      if (slotName === null) {
        parts.push(rendered);
        continue;
      }
      // Content that is already a single element carrying its own slot
      // attribute (a preserved raw block, or a component with a slot prop)
      // serializes as-is; anything else wraps in an Astro Fragment.
      const el = scanAnyElement(rendered);
      if (el && el.raw === rendered && slotAttr(el.propsSource) === slotName) {
        parts.push(rendered);
      } else {
        parts.push(`<Fragment slot="${slotName}">\n${rendered}\n</Fragment>`);
      }
    }
    const children = parts.length === 0 ? null : `\n${parts.join("\n\n")}\n`;
    if (attrs.props === null) {
      // Unparseable props: reassemble around the original tag source.
      const open = `<${attrs.name}${attrs.propsSource}`;
      return children === null ? `${open}/>` : `${open}>${children}</${attrs.name}>`;
    }
    return serializeJsx(attrs.name, attrs.props as MdxProp[], children);
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
  const source = String(props.node.attrs.source ?? "");
  const block = scanJsxBlock(source);

  if (!block) {
    return (
      <NodeViewWrapper as="span" className="mdx-raw-inline">
        <code>{source}</code>
      </NodeViewWrapper>
    );
  }

  const parsed = parseProps(block.propsSource);

  function write(nextProps: MdxProp[] | null, nextChildren: string | null) {
    const b = block!;
    const next =
      nextProps === null
        ? // Unparseable props: reassemble around the original tag source.
          nextChildren === null
          ? `<${b.name}${b.propsSource}/>`
          : `<${b.name}${b.propsSource}>${nextChildren}</${b.name}>`
        : serializeJsx(b.name, nextProps, nextChildren);
    props.updateAttributes({ source: next });
  }

  return (
    <NodeViewWrapper as="span" className="mdx-raw-inline">
      <ComponentPopover
        name={block.name}
        target={(toggle) => (
          <button
            type="button"
            className="mdx-pill mdx-component-chip"
            title={source}
            onClick={toggle}
          >
            <ComponentIcon size={14} />
            <span>{block.name}</span>
          </button>
        )}
      >
        <PropsFields
          name={block.name}
          parsedProps={parsed}
          propsSource={block.propsSource}
          onProps={(next) => write(next, block.children)}
        />
        <SlotChildrenFields
          name={block.name}
          childrenSource={block.children}
          onChildren={(next) => write(parsed, next)}
        />
      </ComponentPopover>
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

/* --- Raw invalidation: editing a card's content drops its verbatim raw. ---- */

/**
 * Component cards keep their original source in `raw` and emit it verbatim
 * until edited. Prop edits clear it explicitly; this plugin clears it (on the
 * component and every component ancestor) when slot content changes.
 */
export const MdxRawInvalidate = Extension.create({
  name: "mdxRawInvalidate",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          const positions: number[] = [];
          transactions.forEach((transaction, tIndex) => {
            if (
              !transaction.docChanged ||
              transaction.getMeta("mdxSlotSync") ||
              transaction.getMeta("mdxRawInvalidate")
            ) {
              return;
            }
            transaction.steps.forEach((step, sIndex) => {
              const stepPositions: number[] = [];
              step.getMap().forEach((_f, _t, newFrom, newTo) => {
                stepPositions.push(newFrom, newTo);
              });
              // Attribute-only steps have no map ranges; fall back to the
              // node position they carry so ancestor cards still refresh.
              const attrPos = (step as unknown as { pos?: number }).pos;
              if (stepPositions.length === 0 && typeof attrPos === "number") {
                stepPositions.push(attrPos + 1);
              }
              // Map through the rest of this transaction, then later ones.
              for (const pos of stepPositions) {
                let mapped = pos;
                for (let i = sIndex + 1; i < transaction.steps.length; i++) {
                  mapped = transaction.steps[i].getMap().map(mapped);
                }
                for (let i = tIndex + 1; i < transactions.length; i++) {
                  mapped = transactions[i].mapping.map(mapped);
                }
                positions.push(mapped);
              }
            });
          });
          if (positions.length === 0) return null;

          const tr = newState.tr;
          const cleared = new Set<number>();
          for (const pos of positions) {
            const $pos = newState.doc.resolve(
              Math.max(0, Math.min(pos, newState.doc.content.size)),
            );
            for (let depth = $pos.depth; depth > 0; depth--) {
              const node = $pos.node(depth);
              if (node.type.name !== "mdxComponent") continue;
              const nodePos = $pos.before(depth);
              if (typeof node.attrs.raw === "string" && !cleared.has(nodePos)) {
                cleared.add(nodePos);
                tr.setNodeAttribute(nodePos, "raw", null);
              }
            }
          }
          if (cleared.size === 0) return null;
          tr.setMeta("mdxRawInvalidate", true);
          return tr;
        },
      }),
    ];
  },
});

/* --- Slot sync: cards grow sections for slots their component declares. --- */

/** True when a slot section holds nothing but empty paragraphs. */
function slotIsEmpty(slot: PmNode): boolean {
  let empty = true;
  slot.forEach((child) => {
    if (child.type.name !== "paragraph" || child.content.size > 0) empty = false;
  });
  return empty;
}

/**
 * Keeps each component card's sections in step with the slots its .astro
 * source declares: inserts empty sections for declared-but-absent slots
 * (default and named) and removes empty sections the schema doesn't declare.
 * Sections with content always stay, and components without a loaded schema
 * are left alone. Runs on document changes and on the `mdxSchemas` poke
 * BodyEditor dispatches when component schemas finish loading.
 */
export const MdxSlotSync = Extension.create({
  name: "mdxSlotSync",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          const relevant = transactions.some(
            (tr) => (tr.docChanged && !tr.getMeta("mdxSlotSync")) || tr.getMeta("mdxSchemas"),
          );
          if (!relevant) return null;

          // Positions collected ascending, applied descending so earlier
          // operations don't shift later ones.
          const ops: (
            | { kind: "insert"; pos: number; slot: string | null }
            | { kind: "delete"; from: number; to: number }
          )[] = [];
          newState.doc.descendants((node, pos) => {
            if (node.type.name !== "mdxComponent") return true;
            const schema = componentSchemas.current[String(node.attrs.name)];
            if (!schema) return true;

            let hasDefault = false;
            const presentNamed = new Set<string>();
            let childPos = pos + 1;
            node.forEach((child) => {
              const slot = child.attrs.slot as string | null;
              if (slot === null) hasDefault = true;
              else presentNamed.add(slot);
              const declared =
                slot === null ? schema.hasDefaultSlot : schema.slots.includes(slot);
              if (!declared && slotIsEmpty(child)) {
                ops.push({ kind: "delete", from: childPos, to: childPos + child.nodeSize });
              }
              childPos += child.nodeSize;
            });
            // The default section leads; named sections append at the end.
            if (schema.hasDefaultSlot && !hasDefault) {
              ops.push({ kind: "insert", pos: pos + 1, slot: null });
            }
            for (const name of schema.slots) {
              if (!presentNamed.has(name)) {
                ops.push({ kind: "insert", pos: pos + node.nodeSize - 1, slot: name });
              }
            }
            return true;
          });
          if (ops.length === 0) return null;

          const tr = newState.tr;
          const slotType = newState.schema.nodes.mdxSlot;
          const paragraph = newState.schema.nodes.paragraph;
          // Apply descending so earlier positions stay valid; on ties, delete
          // before inserting, and undo the push order of same-position inserts
          // so multiple named sections land in declared order.
          const keyed = ops.map((op, order) => ({
            op,
            order,
            pos: op.kind === "delete" ? op.from : op.pos,
          }));
          keyed.sort(
            (a, b) =>
              b.pos - a.pos ||
              (a.op.kind !== b.op.kind ? (a.op.kind === "delete" ? -1 : 1) : b.order - a.order),
          );
          for (const { op } of keyed) {
            if (op.kind === "delete") tr.delete(op.from, op.to);
            else tr.insert(op.pos, slotType.create({ slot: op.slot }, paragraph.create()));
          }
          // Empty sections don't change the serialized markdown, so they are
          // neither undoable steps nor a reason to drop a card's raw source.
          tr.setMeta("mdxSlotSync", true);
          tr.setMeta("addToHistory", false);
          return tr;
        },
      }),
    ];
  },
});

/* --- Import cleanup: deleting a component's last use drops its import. ---- */

/**
 * Component names referenced anywhere in the document: component cards (their
 * props can hold nested JSX too; slot content is real nodes, visited by this
 * walk) and preserved raw JSX.
 */
function usedComponentNames(doc: PmNode): Set<string> {
  const names = new Set<string>();
  const scanJsx = (text: string) => {
    for (const match of text.matchAll(/<([A-Z][\w.]*)[\s/>]/g)) names.add(match[1]);
  };
  doc.descendants((node) => {
    if (node.type.name === "mdxComponent") {
      names.add(String(node.attrs.name));
      scanJsx(String(node.attrs.propsSource ?? ""));
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

export const mdxNodes = [
  MdxImport,
  MdxComponent,
  MdxSlot,
  MdxRawBlock,
  MdxRawInline,
  MdxRawInvalidate,
  MdxSlotSync,
  MdxImportCleanup,
];
