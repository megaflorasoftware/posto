import { useEffect, useMemo, useRef, useState } from "react";
import { Link, RichTextEditor } from "@mantine/tiptap";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import { Blocks, Image as ImageIcon } from "lucide-react";

import { assetUrl, invoke } from "../ipc";
import type { FileEntry } from "../ipc";
import { mediaInputPath, type MediaEntry } from "../pagescms/config";
import {
  type AstroPropDef,
  componentNameFromFile,
  extractImports,
  importInfo,
  parseAstroProps,
  relativeImportPath,
  resolveImportPath,
} from "../mdx/mdx";
import { ComponentPicker } from "./ComponentPicker";
import { ImagePicker } from "./ImagePicker";
import { MdxSchemaContext, mdxNodes } from "./MdxNodes";

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
  onChange: (markdown: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [componentPickerOpen, setComponentPickerOpen] = useState(false);
  const [schemas, setSchemas] = useState<Record<string, AstroPropDef[]>>({});
  // Markdown emitted by this editor; used to ignore the echo when it comes
  // back through props so only genuinely external changes reset the document.
  const lastEmitted = useRef<string | null>(null);

  // The display resolver is read through a ref so the Image extension (created
  // once) always sees the current root/media.
  const resolveSrc = (src: string): string => {
    if (!props.media || !src.startsWith("/")) return src;
    const absolute = mediaInputPath(props.root, props.media, src);
    return (absolute && assetUrl(absolute)) || src;
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

  // Astro components declare their props in a `Props` interface — load it for
  // each relatively-imported .astro component so its card can offer all keys.
  // Keyed on the import statements themselves, not the whole body, so typing
  // in text doesn't refetch.
  const importsKey = props.mdx ? extractImports(props.value).join("\u0000") : "";
  useEffect(() => {
    if (importsKey === "") return;
    let cancelled = false;
    void (async () => {
      const loaded: Record<string, AstroPropDef[]> = {};
      for (const statement of importsKey.split("\u0000")) {
        const { names, spec } = importInfo(statement);
        if (!spec || !spec.endsWith(".astro") || names.length === 0) continue;
        const file = resolveImportPath(props.path, spec);
        if (!file) continue;
        try {
          const source = await invoke<string>("read_text_file", { path: file });
          const defs = parseAstroProps(source);
          if (defs.length > 0) for (const name of names) loaded[name] = defs;
        } catch {
          // Unresolvable import — the card just shows the props already set.
        }
      }
      if (!cancelled) setSchemas(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [importsKey, props.path]);

  // Inserts the picked component at the cursor and, when it isn't imported
  // yet, adds the import at the top of the document.
  function insertComponent(file: FileEntry) {
    if (!editor) return;
    const name = componentNameFromFile(file.name);
    const alreadyImported = extractImports(editor.getMarkdown()).some((statement) =>
      importInfo(statement).names.includes(name),
    );
    // Component first, import second: inserting content leaves it selected,
    // so the reverse order would make the second insert replace the first.
    const chain = editor
      .chain()
      .focus()
      .insertContent({
        type: "mdxComponent",
        attrs: { name, props: [], propsSource: "", children: null, raw: null },
      });
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

  return (
    // Component-card node views render through portals inside the content
    // element, so this provider reaches them.
    <MdxSchemaContext.Provider value={schemas}>
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
          <RichTextEditor.Code />
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
      <RichTextEditor.Content />
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
        />
      )}
    </RichTextEditor>
    </MdxSchemaContext.Provider>
  );
}
