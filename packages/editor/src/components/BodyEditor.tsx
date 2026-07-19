import { useEffect, useMemo, useRef, useState } from "react";
import { Link, RichTextEditor } from "@mantine/tiptap";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import { Blocks, CodeXml, Image as ImageIcon } from "lucide-react";

import { assetUrl, invoke } from "@posto/ipc";
import type { FileEntry, FileGroup } from "@posto/ipc";
import {
  mediaInputPath,
  type ContentEntry,
  type MediaEntry,
  type PagesConfig,
} from "@posto/core/pagescms/config";
import {
  type AstroComponentSchema,
  componentNameFromFile,
  importInfo,
  parseAstroProps,
  parseAstroPropsType,
  parseAstroSlots,
  relativeImportPath,
  resolveImportPath,
  splitLeadingImports,
} from "@posto/core/mdx/mdx";
import { ComponentPicker } from "./ComponentPicker";
import { htmlNodes } from "./HtmlNodes";
import { ImagePicker } from "./ImagePicker";
import { MdxFieldEnvContext, MdxSchemaContext, componentSchemas, mdxNodes } from "./MdxNodes";

/** An import statement managed outside the document, with its bindings. */
interface ManagedImport {
  statement: string;
  names: string[];
  /** Imports already unused when the content loaded are kept until first
   * used; from then on they live and die with their component's usage. */
  pinned: boolean;
}

/** Capitalized JSX tag names appearing anywhere in the markdown body — the
 * signal for which component imports the body still needs. */
function bodyComponentNames(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(/<([A-Z][\w.]*)[\s/>]/g)].map((m) => m[1].split(".")[0]),
  );
}

function toManagedImports(statements: string[], body: string): ManagedImport[] {
  const used = bodyComponentNames(body);
  return statements.map((statement) => {
    const { names } = importInfo(statement);
    return { statement, names, pinned: !names.some((name) => used.has(name)) };
  });
}

/**
 * Rich-text editor for the markdown body. Tiptap owns the document; markdown
 * goes in on mount (and on external changes) and comes back out through
 * `getMarkdown()` on every edit. Image nodes store the site-relative output
 * path (what the markdown references) while the webview displays them through
 * the media source's input directory.
 *
 * In MDX mode the leading import block never enters the document: imports are
 * split off into a managed list, hidden from the editor, and recomposed into
 * the emitted markdown — added when a picked component needs one, dropped
 * when the body no longer references their component.
 */
export function BodyEditor(props: {
  value: string;
  /** Absolute path of the file being edited; resolves relative MDX imports. */
  path: string;
  /** MDX mode adds component cards, raw-JSX preservation, and hidden
   * auto-managed imports. */
  mdx: boolean;
  root: string;
  /** Media source for the toolbar's image insertion and inline display: the
   * collection's (`.posto` mediaDir), else the first global one. */
  media: MediaEntry | null;
  /** Collection entry of the edited file; scopes media resolution for image
   * props inside component cards. */
  entry?: ContentEntry | null;
  /** Top-level frontmatter for per-entry media-folder templates. */
  templateValues: Record<string, unknown>;
  /** Full config + sidebar groups, for field controls inside component cards. */
  config: PagesConfig;
  groups: FileGroup[];
  onChange: (markdown: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [componentPickerOpen, setComponentPickerOpen] = useState(false);
  const [schemas, setSchemas] = useState<Record<string, AstroComponentSchema>>({});
  // Markdown emitted by this editor; used to ignore the echo when it comes
  // back through props so only genuinely external changes reset the document.
  const lastEmitted = useRef<string | null>(null);

  // MDX only: leading imports live here, not in the document. The initial
  // split runs once — the component remounts per file (keyed upstream).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(
    () => (props.mdx ? splitLeadingImports(props.value) : { imports: [], body: props.value }),
    [],
  );
  const importsRef = useRef<ManagedImport[]>(toManagedImports(initial.imports, initial.body));

  /** Emitted markdown: managed imports (filtered to what the body still
   * uses) above the document's markdown. */
  function composeMarkdown(body: string): string {
    if (!props.mdx) return body;
    const used = bodyComponentNames(body);
    const kept = importsRef.current.filter((imp) => {
      // Bindingless (side-effect) imports are never auto-removed.
      if (imp.names.length === 0) return true;
      if (imp.names.some((name) => used.has(name))) {
        imp.pinned = false;
        return true;
      }
      return imp.pinned;
    });
    importsRef.current = kept;
    if (kept.length === 0) return body;
    return kept.map((imp) => imp.statement).join("\n") + "\n\n" + body;
  }

  // The display resolver is read through a ref so the Image extension (created
  // once) always sees the current root/media.
  const resolveSrc = (src: string): string => {
    if (!src.startsWith("/")) return src;
    const absolute = props.media ? mediaInputPath(props.root, props.media, src) : null;
    // Site-root paths outside the media source usually live in the site's
    // `public` folder, which is served from `/` — try there before giving up.
    return (absolute && assetUrl(absolute)) || assetUrl(props.root + "/public" + src) || src;
  };
  const resolveRef = useRef(resolveSrc);
  resolveRef.current = resolveSrc;

  const extensions = useMemo(
    () => [
      // Link comes from @mantine/tiptap (adds the Ctrl+K popover); underline
      // has no markdown equivalent.
      StarterKit.configure({ link: false, underline: false }),
      Link,
      Markdown,
      // Inline like markdown images; src attr keeps the stored output path,
      // only the rendered <img> is rewritten to a loadable URL.
      Image.configure({ inline: true }).extend({
        renderHTML({ HTMLAttributes }) {
          return ["img", { ...HTMLAttributes, src: resolveRef.current(HTMLAttributes.src) }];
        },
      }),
      // HTML preservation applies to .md and .mdx alike: authored tags like
      // <kbd> round-trip as chips instead of being stripped.
      ...htmlNodes,
      ...(props.mdx ? mdxNodes : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    content: initial.body,
    contentType: "markdown",
    onUpdate: ({ editor }) => {
      const markdown = composeMarkdown(editor.getMarkdown());
      lastEmitted.current = markdown;
      props.onChange(markdown);
    },
  });

  // External content changes (raw-tab edits while this file stays open):
  // replace the document without emitting an update.
  useEffect(() => {
    if (!editor || props.value === lastEmitted.current) return;
    const next = props.mdx
      ? splitLeadingImports(props.value)
      : { imports: [], body: props.value };
    importsRef.current = toManagedImports(next.imports, next.body);
    if (next.body === editor.getMarkdown()) return;
    editor.commands.setContent(next.body, { contentType: "markdown", emitUpdate: false });
  }, [editor, props.value]);

  // Astro components declare their props in a `Props` interface and their
  // slots as `<slot>` tags — load both for each relatively-imported .astro
  // component so its card can offer all prop keys and slot sections. Keyed on
  // the import statements themselves, not the whole body, so typing in text
  // doesn't refetch.
  const importsKey = props.mdx
    ? splitLeadingImports(props.value).imports.join("\u0000")
    : "";
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded: Record<string, AstroComponentSchema> = {};
      for (const statement of importsKey === "" ? [] : importsKey.split("\u0000")) {
        const { names, spec } = importInfo(statement);
        if (!spec || !spec.endsWith(".astro") || names.length === 0) continue;
        const file = resolveImportPath(props.path, spec);
        if (!file) continue;
        try {
          const source = await invoke<string>("read_text_file", { path: file });
          const defs = parseAstroProps(source);
          const propsType = parseAstroPropsType(source) ?? undefined;
          const slots = parseAstroSlots(source);
          // Register even prop-less, slot-less components: a loaded schema
          // with no slots is what tells the card to render no sections.
          for (const name of names) {
            loaded[name] = {
              props: defs,
              propsType,
              slots: slots.named,
              hasDefaultSlot: slots.hasDefault,
            };
          }
        } catch {
          // Unresolvable import — the card just shows the props already set.
        }
      }
      if (cancelled) return;
      setSchemas(loaded);
      // The markdown pipeline and the slot-sync plugin read schemas outside
      // React; the poke transaction makes slot sync run with the new data.
      componentSchemas.current = loaded;
      editor?.view.dispatch(editor.state.tr.setMeta("mdxSchemas", true));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importsKey, props.path]);

  // Inserts the picked component at the cursor and, when it isn't imported
  // yet, adds the import at the top of the document. A cursor inside written
  // text gets an inline component; an empty paragraph (or block position)
  // gets a block one, so the paragraph is never split by the insert.
  function insertComponent(file: FileEntry) {
    if (!editor) return;
    const name = componentNameFromFile(file.name);
    const alreadyImported = importsRef.current.some((imp) => imp.names.includes(name));
    const { $from } = editor.state.selection;
    const inline = $from.parent.isTextblock && $from.parent.content.size > 0;
    // Block cards carry one section per declared slot. With no loaded schema
    // yet, start with a default section; the slot-sync plugin reconciles
    // sections once the component's schema arrives.
    const emptySlot = (slot: string | null) => ({
      type: "mdxSlot",
      attrs: { slot },
      content: [{ type: "paragraph" }],
    });
    const schema = schemas[name];
    const slotContent = schema
      ? [...(schema.hasDefaultSlot ? [emptySlot(null)] : []), ...schema.slots.map(emptySlot)]
      : [emptySlot(null)];
    if (!alreadyImported) {
      const spec = relativeImportPath(props.path, file.path);
      importsRef.current.push({
        statement: `import ${name} from '${spec}';`,
        names: [name],
        pinned: false,
      });
    }
    editor
      .chain()
      .focus()
      .insertContent(
        inline
          ? { type: "mdxRawInline", attrs: { source: `<${name} />` } }
          : {
              type: "mdxComponent",
              attrs: { name, props: [], propsSource: "", raw: null },
              content: slotContent,
            },
      )
      .run();
  }

  // Inserts an empty custom-HTML chip at the cursor: inline when the cursor
  // sits inside written text, block otherwise (mirrors insertComponent).
  function insertHtml() {
    if (!editor) return;
    const { $from } = editor.state.selection;
    const inline = $from.parent.isTextblock && $from.parent.content.size > 0;
    editor
      .chain()
      .focus()
      .insertContent(
        inline
          ? { type: "htmlInline", attrs: { source: "<span></span>" } }
          : { type: "htmlBlock", attrs: { source: "<div>\n</div>" } },
      )
      .run();
  }

  return (
    // Component-card node views render through portals inside the content
    // element, so these providers reach them.
    <MdxSchemaContext.Provider value={schemas}>
    <MdxFieldEnvContext.Provider
      value={{
        config: props.config,
        root: props.root,
        groups: props.groups,
        entry: props.entry ?? null,
        templateValues: props.templateValues,
      }}
    >
    <RichTextEditor
      editor={editor}
      className="body-rich-editor"
      // The scroll chain needs a class on every wrapper between the root and
      // the ProseMirror element; Mantine's generated names aren't stable.
      classNames={{ Typography: "body-rich-typography", content: "body-rich-content" }}
    >
      <RichTextEditor.Toolbar>
        <RichTextEditor.ControlsGroup>
          <RichTextEditor.H1 />
          <RichTextEditor.H2 />
          <RichTextEditor.H3 />
          <RichTextEditor.H4 />
        </RichTextEditor.ControlsGroup>
        <RichTextEditor.ControlsGroup>
          <RichTextEditor.Bold />
          <RichTextEditor.Italic />
          <RichTextEditor.Strikethrough />
        </RichTextEditor.ControlsGroup>
        <RichTextEditor.ControlsGroup>
          <RichTextEditor.BulletList />
          <RichTextEditor.OrderedList />
          <RichTextEditor.Blockquote />
          <RichTextEditor.CodeBlock />
          <RichTextEditor.Hr />
        </RichTextEditor.ControlsGroup>
        <RichTextEditor.ControlsGroup>
          <RichTextEditor.Link />
          <RichTextEditor.Unlink />
          <RichTextEditor.Control
            title="Insert image"
            aria-label="Insert image"
            disabled={!props.media}
            onClick={() => setPickerOpen(true)}
          >
            <ImageIcon size={16} />
          </RichTextEditor.Control>
          <RichTextEditor.Control
            title="Insert HTML"
            aria-label="Insert HTML"
            onClick={insertHtml}
          >
            <CodeXml size={16} />
          </RichTextEditor.Control>
          {props.mdx && (
            <RichTextEditor.Control
              title="Insert component"
              aria-label="Insert component"
              onClick={() => setComponentPickerOpen(true)}
            >
              <Blocks size={16} />
            </RichTextEditor.Control>
          )}
        </RichTextEditor.ControlsGroup>
        <RichTextEditor.ControlsGroup>
          <RichTextEditor.Undo />
          <RichTextEditor.Redo />
        </RichTextEditor.ControlsGroup>
      </RichTextEditor.Toolbar>
      <div className="body-rich-scroll">
        <RichTextEditor.Content />
      </div>
      {pickerOpen && props.media && (
        <ImagePicker
          root={props.root}
          media={props.media}
          onClose={() => setPickerOpen(false)}
          onPick={(outputPath) => {
            setPickerOpen(false);
            editor?.chain().focus().setImage({ src: outputPath }).run();
          }}
        />
      )}
      {componentPickerOpen && (
        <ComponentPicker
          root={props.root}
          onClose={() => setComponentPickerOpen(false)}
          onPick={(file) => {
            setComponentPickerOpen(false);
            insertComponent(file);
          }}
          onPickHtml={() => {
            setComponentPickerOpen(false);
            insertHtml();
          }}
        />
      )}
    </RichTextEditor>
    </MdxFieldEnvContext.Provider>
    </MdxSchemaContext.Provider>
  );
}
