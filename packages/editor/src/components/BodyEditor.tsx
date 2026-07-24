import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, RichTextEditor } from "@mantine/tiptap";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import { Blocks, CodeXml, Paperclip } from "lucide-react";

import { assetUrl } from "@posto/ipc";
import type { FileGroup } from "@posto/ipc";
import {
  expandMediaEntry,
  mediaInputPath,
  type ContentEntry,
  type MediaEntry,
  type PagesConfig,
} from "@posto/core/pagescms/config";
import { importInfo, resolveImportPath, splitLeadingImports } from "@posto/core/mdx/mdx";
import type { ComponentRef, ComponentSchemaSource } from "@posto/core/project/adapter";
import type { EntryIdSource } from "@posto/core/project/entryIds";
import { ComponentPicker } from "./ComponentPicker";
import { htmlNodes } from "./HtmlNodes";
import { RichTextImagePickerDialog } from "./RichTextImagePickerDialog";
import {
  MdxFieldEnvContext,
  MdxSchemaContext,
  componentSchemas,
  mdxNodes,
  type ComponentBlockSchema,
} from "./MdxNodes";
import { useProjectIO } from "../projectIO";
import { markdownMediaEditorContent } from "../markdownMedia";

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
  return new Set([...markdown.matchAll(/<([A-Z][\w.]*)[\s/>]/g)].map((m) => m[1].split(".")[0]));
}

function toManagedImports(statements: string[], body: string): ManagedImport[] {
  const used = bodyComponentNames(body);
  return statements.map((statement) => {
    const { names } = importInfo(statement);
    return { statement, names, pinned: !names.some((name) => used.has(name)) };
  });
}

export function bodyEditorMode(mdx: boolean, componentBlocks: ComponentSchemaSource | null) {
  return { mdx, componentBlocksEnabled: componentBlocks !== null };
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
  /** Expanded collection-scoped `.posto`/Pages media directory. It must map
   * to a discovered Astro image library or one of its included subfolders. */
  configuredMedia: MediaEntry | null;
  /** Collection entry of the edited file; scopes media resolution for image
   * props inside component cards. */
  entry?: ContentEntry | null;
  /** Top-level frontmatter for per-entry media-folder templates. */
  templateValues: Record<string, unknown>;
  /** Full config + sidebar groups, for field controls inside component cards. */
  config: PagesConfig;
  groups: FileGroup[];
  componentBlocks: ComponentSchemaSource | null;
  entryIds: EntryIdSource | null;
  componentSchemaVersion?: number;
  toolbarLeading?: ReactNode;
  toolbarTrailing?: ReactNode;
  onChange: (markdown: string) => void;
}) {
  const { mdx, componentBlocksEnabled } = bodyEditorMode(props.mdx, props.componentBlocks);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [componentPickerOpen, setComponentPickerOpen] = useState(false);
  const [schemas, setSchemas] = useState<Record<string, ComponentBlockSchema>>({});
  const projectIO = useProjectIO();
  const configuredMedia = props.configuredMedia
    ? expandMediaEntry(props.configuredMedia, props.templateValues)
    : null;
  // Markdown emitted by this editor; used to ignore the echo when it comes
  // back through props so only genuinely external changes reset the document.
  const lastEmitted = useRef<string | null>(null);

  // MDX only: leading imports live here, not in the document. The initial
  // split runs once — the component remounts per file (keyed upstream).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(
    () => (mdx ? splitLeadingImports(props.value) : { imports: [], body: props.value }),
    [],
  );
  const importsRef = useRef<ManagedImport[]>(toManagedImports(initial.imports, initial.body));

  /** Emitted markdown: managed imports (filtered to what the body still
   * uses) above the document's markdown. */
  function composeMarkdown(body: string): string {
    if (!mdx) return body;
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
  // once) always sees the current root/media libraries.
  const resolveSrc = (src: string): string => {
    if (!src.startsWith("/")) return src;
    let filesystemSrc = src;
    try {
      filesystemSrc = decodeURIComponent(src);
    } catch {
      // Keep malformed percent escapes displayable through the existing path.
    }
    const libraryMedia = (props.config.mediaLibraries ?? []).map((library) => {
      const input = library.base.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
      return { name: `library:${library.collection}`, input, output: `/${input}` };
    });
    const candidates = [configuredMedia, ...libraryMedia].filter(
      (media): media is MediaEntry => media !== null,
    );
    const absolute = candidates
      .map((media) => mediaInputPath(props.root, media, filesystemSrc))
      .find((path): path is string => path !== null);
    // Site-root paths outside the media source usually live in the site's
    // `public` folder, which is served from `/` — try there before giving up.
    return (
      (absolute && assetUrl(absolute)) || assetUrl(props.root + "/public" + filesystemSrc) || src
    );
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
      ...(mdx ? mdxNodes : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    content: initial.body,
    contentType: "markdown",
    editorProps: {
      attributes: {
        "aria-label": "Body",
        "data-empty": initial.body.trim() === "" ? "true" : "false",
        "data-placeholder": "Start writing...",
      },
    },
    onCreate: ({ editor }) => {
      editor.view.dom.dataset.empty = editor.isEmpty ? "true" : "false";
    },
    onUpdate: ({ editor }) => {
      editor.view.dom.dataset.empty = editor.isEmpty ? "true" : "false";
      const markdown = composeMarkdown(editor.getMarkdown());
      lastEmitted.current = markdown;
      props.onChange(markdown);
    },
  });

  // External content changes (raw-tab edits while this file stays open):
  // replace the document without emitting an update.
  useEffect(() => {
    if (!editor || props.value === lastEmitted.current) return;
    const next = mdx ? splitLeadingImports(props.value) : { imports: [], body: props.value };
    importsRef.current = toManagedImports(next.imports, next.body);
    if (next.body === editor.getMarkdown()) return;
    editor.commands.setContent(next.body, { contentType: "markdown", emitUpdate: false });
    editor.view.dom.dataset.empty = editor.isEmpty ? "true" : "false";
  }, [editor, props.value]);

  // The active adapter owns component discovery and prop parsing. The editor
  // only consumes neutral fields and slot metadata for components imported by
  // this document.
  const importsKey = mdx ? splitLeadingImports(props.value).imports.join("\u0000") : "";
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded: Record<string, ComponentBlockSchema> = {};
      const source = props.componentBlocks;
      if (!source) {
        if (!cancelled) {
          setSchemas({});
          componentSchemas.current = {};
          editor?.view.dispatch(editor.state.tr.setMeta("mdxSchemas", true));
        }
        return;
      }
      for (const statement of importsKey === "" ? [] : importsKey.split("\u0000")) {
        const { names, spec } = importInfo(statement);
        if (!spec || names.length === 0) continue;
        const file = resolveImportPath(props.path, spec);
        if (!file) continue;
        try {
          const result = await source.componentFields(
            { name: names[0], path: file },
            projectIO,
            props.config,
          );
          if (!result) continue;
          for (const name of names) {
            loaded[name] = {
              fields: result.fields,
              slots: result.slots ?? [],
              hasDefaultSlot: result.hasDefaultSlot ?? false,
            };
          }
        } catch {}
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
  }, [
    importsKey,
    projectIO,
    props.path,
    props.componentBlocks,
    props.componentSchemaVersion,
    props.config,
  ]);

  // Inserts the picked component at the cursor and, when it isn't imported
  // yet, adds the import at the top of the document. A cursor inside written
  // text gets an inline component; an empty paragraph (or block position)
  // gets a block one, so the paragraph is never split by the insert.
  function insertComponent(file: ComponentRef) {
    if (!editor) return;
    const name = file.name;
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
      importsRef.current.push({
        statement: props.componentBlocks?.importFor(file, props.path) ?? "",
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
          entryIds: props.entryIds,
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
            {props.toolbarLeading && (
              <div className="body-rich-toolbar-edge">{props.toolbarLeading}</div>
            )}
            <div className="body-rich-toolbar-controls">
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
                  title="Insert media"
                  aria-label="Insert media"
                  onClick={() => setPickerOpen(true)}
                >
                  <Paperclip size={16} />
                </RichTextEditor.Control>
                <RichTextEditor.Control
                  title="Insert HTML"
                  aria-label="Insert HTML"
                  onClick={insertHtml}
                >
                  <CodeXml size={16} />
                </RichTextEditor.Control>
                {mdx && componentBlocksEnabled && (
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
            </div>
            {props.toolbarTrailing && (
              <div className="body-rich-toolbar-edge" aria-hidden={!props.toolbarTrailing}>
                {props.toolbarTrailing}
              </div>
            )}
          </RichTextEditor.Toolbar>
          <div className="body-rich-scroll">
            <RichTextEditor.Content />
          </div>
          {pickerOpen && (
            <RichTextImagePickerDialog
              root={props.root}
              config={props.config}
              configuredMedia={props.configuredMedia}
              templateValues={props.templateValues}
              groups={props.groups}
              onClose={() => setPickerOpen(false)}
              onPick={(media) => {
                setPickerOpen(false);
                editor?.chain().focus().insertContent(markdownMediaEditorContent(media)).run();
              }}
            />
          )}
          {componentPickerOpen && componentBlocksEnabled && props.componentBlocks && (
            <ComponentPicker
              root={props.root}
              source={props.componentBlocks}
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
