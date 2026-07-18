import { useEffect, useMemo, useRef, useState } from "react";
import { Link, RichTextEditor } from "@mantine/tiptap";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import { Blocks, CodeXml, Image as ImageIcon } from "lucide-react";

import { assetUrl, invoke } from "@posto/ipc";
import type { FileEntry, FileGroup } from "@posto/ipc";
import { mediaInputPath, type MediaEntry, type PagesConfig } from "@posto/core/pagescms/config";
import {
  type AstroComponentSchema,
  componentNameFromFile,
  extractImports,
  importInfo,
  parseAstroProps,
  parseAstroSlots,
  relativeImportPath,
  resolveImportPath,
} from "@posto/core/mdx/mdx";
import { ComponentPicker } from "./ComponentPicker";
import { htmlNodes } from "./HtmlNodes";
import { ImagePicker } from "./ImagePicker";
import { MdxFieldEnvContext, MdxSchemaContext, componentSchemas, mdxNodes } from "./MdxNodes";

/**
 * Rich-text editor for the markdown body. Tiptap owns the document; markdown
 * goes in on mount (and on external changes) and comes back out through
 * `getMarkdown()` on every edit. Image nodes store the site-relative output
 * path (what the markdown references) while the webview displays them through
 * the media source's input directory.
 */
export function BodyEditor(props: {
  value: string;
  /** Absolute path of the file being edited; resolves relative MDX imports. */
  path: string;
  /** MDX mode adds import pills, component cards, and raw-JSX preservation. */
  mdx: boolean;
  root: string;
  /** First media source from .pages.yml, if any — enables image insertion. */
  media: MediaEntry | null;
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
    content: props.value,
    contentType: "markdown",
    onUpdate: ({ editor }) => {
      const markdown = editor.getMarkdown();
      lastEmitted.current = markdown;
      props.onChange(markdown);
    },
  });

  // External content changes (raw-tab edits while this file stays open):
  // replace the document without emitting an update.
  useEffect(() => {
    if (!editor || props.value === lastEmitted.current) return;
    if (props.value === editor.getMarkdown()) return;
    editor.commands.setContent(props.value, { contentType: "markdown", emitUpdate: false });
  }, [editor, props.value]);

  // Astro components declare their props in a `Props` interface and their
  // slots as `<slot>` tags — load both for each relatively-imported .astro
  // component so its card can offer all prop keys and slot sections. Keyed on
  // the import statements themselves, not the whole body, so typing in text
  // doesn't refetch.
  const importsKey = props.mdx ? extractImports(props.value).join("\u0000") : "";
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
          const slots = parseAstroSlots(source);
          // Register even prop-less, slot-less components: a loaded schema
          // with no slots is what tells the card to render no sections.
          for (const name of names) {
            loaded[name] = { props: defs, slots: slots.named, hasDefaultSlot: slots.hasDefault };
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
    const alreadyImported = extractImports(editor.getMarkdown()).some((statement) =>
      importInfo(statement).names.includes(name),
    );
    const { $from } = editor.state.selection;
    const inline = $from.parent.isTextblock && $from.parent.content.size > 0;
    // Component first, import second: inserting content leaves it selected,
    // so the reverse order would make the second insert replace the first.
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
    const chain = editor
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
      );
    if (!alreadyImported) {
      const spec = relativeImportPath(props.path, file.path);
      chain.insertContentAt(
        0,
        {
          type: "mdxImport",
          attrs: { statement: `import ${name} from '${spec}';` },
        },
        // Keep the selection where it is: a selected atom node would be
        // replaced wholesale by the next insertion or keystroke.
        { updateSelection: false },
      );
    }
    chain.run();
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
      value={{ config: props.config, root: props.root, groups: props.groups }}
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
