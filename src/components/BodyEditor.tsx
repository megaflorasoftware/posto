import { useEffect, useMemo, useRef, useState } from "react";
import { Link, RichTextEditor } from "@mantine/tiptap";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import { Image as ImageIcon } from "lucide-react";

import { assetUrl } from "../ipc";
import { mediaInputPath, type MediaEntry } from "../pagescms/config";
import { ImagePicker } from "./ImagePicker";

/**
 * Rich-text editor for the markdown body. Tiptap owns the document; markdown
 * goes in on mount (and on external changes) and comes back out through
 * `getMarkdown()` on every edit. Image nodes store the site-relative output
 * path (what the markdown references) while the webview displays them through
 * the media source's input directory.
 */
export function BodyEditor(props: {
  value: string;
  root: string;
  /** First media source from .pages.yml, if any — enables image insertion. */
  media: MediaEntry | null;
  onChange: (markdown: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
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
    ],
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

  return (
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
    </RichTextEditor>
  );
}
