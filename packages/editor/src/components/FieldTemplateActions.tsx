import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  NumberInput,
  Radio,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { NotebookText, NotepadTextDashed, Settings2 } from "lucide-react";
import type {
  ContentEntry,
  FieldTemplateSchema,
  TemplateEditBehavior,
} from "@posto/core/pagescms/config";
import { POSTO_COLLECTIONS_DIR, updatePostoFieldTemplateSource } from "@posto/core/posto/config";
import { invoke } from "@posto/ipc";
import { Dialog } from "./Dialog";

const BEHAVIORS: {
  value: TemplateEditBehavior;
  label: string;
  description: string;
}[] = [
  {
    value: "controlled",
    label: "Controlled",
    description: "Read-only and controlled only by its dependencies.",
  },
  {
    value: "manual",
    label: "Manual",
    description: "Updated only when you use the refresh button.",
  },
];

function TemplateDialog(props: {
  root: string;
  collection: ContentEntry;
  fieldName: string;
  label: string;
  schema?: FieldTemplateSchema;
  onClose: () => void;
  onSaved: (schema: FieldTemplateSchema | null) => void;
}) {
  const [template, setTemplate] = useState(props.schema?.template ?? "");
  const [editBehavior, setEditBehavior] = useState<TemplateEditBehavior>(
    props.schema?.editBehavior ?? (props.fieldName === "filename" ? "controlled" : "manual"),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `${props.root}/${POSTO_COLLECTIONS_DIR}/${props.collection.name}.json`;

  async function write(schema: FieldTemplateSchema | null) {
    setSaving(true);
    setError(null);
    try {
      let source: string | null = null;
      try {
        source = await invoke<string>("read_text_file", { path });
      } catch {
        // The collection gets its first Posto settings file on save.
      }
      await invoke("write_text_file", {
        path,
        content: updatePostoFieldTemplateSource(source, props.fieldName, schema),
      });
      props.onSaved(schema);
      props.onClose();
    } catch (cause) {
      setError(String(cause));
      setSaving(false);
    }
  }

  const trimmed = template.trim();
  const missingFilenameExtension =
    props.fieldName === "filename" && trimmed !== "" && !/\.[a-z0-9]+$/i.test(trimmed);
  return (
    <Dialog opened onClose={props.onClose} title={`${props.label} template`}>
      <Stack gap="sm">
        {error && <Alert color="red">{error}</Alert>}
        <Textarea
          label="Template"
          description="Use {fields.x} for a raw field value or {fields.x|slug} for a slug."
          autosize
          minRows={3}
          value={template}
          error={
            missingFilenameExtension
              ? "Filename templates must end with an extension, such as .mdx."
              : undefined
          }
          onChange={(event) => setTemplate(event.currentTarget.value)}
        />
        <Radio.Group
          label="Edit behavior"
          value={editBehavior}
          onChange={(value) => setEditBehavior(value as TemplateEditBehavior)}
        >
          <Stack gap="xs" mt="xs">
            {BEHAVIORS.map((behavior) => (
              <Radio.Card
                className="template-behavior-card"
                key={behavior.value}
                value={behavior.value}
              >
                <Group wrap="nowrap" align="flex-start">
                  <Radio.Indicator />
                  <div>
                    <Text size="sm" fw={600}>
                      {behavior.label}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {behavior.description}
                    </Text>
                  </div>
                </Group>
              </Radio.Card>
            ))}
          </Stack>
        </Radio.Group>
        <Group justify={props.schema?.template ? "space-between" : "flex-end"}>
          {props.schema?.template && (
            <Button
              color="red"
              variant="subtle"
              disabled={saving}
              onClick={() =>
                void write(
                  props.fieldName === "filename" || props.schema?.rows !== undefined
                    ? {
                        editBehavior,
                        ...(props.schema?.rows !== undefined ? { rows: props.schema.rows } : {}),
                      }
                    : null,
                )
              }
            >
              Remove template
            </Button>
          )}
          <Button
            disabled={saving || trimmed === "" || missingFilenameExtension}
            onClick={() =>
              void write({
                template: trimmed,
                editBehavior,
                ...(props.schema?.rows !== undefined ? { rows: props.schema.rows } : {}),
              })
            }
          >
            Save template
          </Button>
        </Group>
      </Stack>
    </Dialog>
  );
}

function RowsDialog(props: {
  root: string;
  collection: ContentEntry;
  fieldName: string;
  label: string;
  schema?: FieldTemplateSchema;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState(props.schema?.rows ?? 1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `${props.root}/${POSTO_COLLECTIONS_DIR}/${props.collection.name}.json`;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      let source: string | null = null;
      try {
        source = await invoke<string>("read_text_file", { path });
      } catch {
        // The collection gets its first Posto settings file on save.
      }
      await invoke("write_text_file", {
        path,
        content: updatePostoFieldTemplateSource(source, props.fieldName, {
          ...(props.schema?.template ? { template: props.schema.template } : {}),
          editBehavior: props.schema?.editBehavior ?? "manual",
          rows,
        }),
      });
      props.onSaved();
      props.onClose();
    } catch (cause) {
      setError(String(cause));
      setSaving(false);
    }
  }

  return (
    <Dialog opened onClose={props.onClose} title={`${props.label} input`}>
      <Stack gap="sm">
        {error && <Alert color="red">{error}</Alert>}
        <NumberInput
          label="Rows"
          description="Number of visible rows in this string field"
          min={1}
          max={50}
          allowDecimal={false}
          value={rows}
          onChange={(value) =>
            setRows(typeof value === "number" ? Math.max(1, Math.floor(value)) : 1)
          }
        />
        <Button disabled={saving} onClick={() => void save()}>
          Save
        </Button>
      </Stack>
    </Dialog>
  );
}

export function FieldRowsAction(props: {
  root: string;
  collection: ContentEntry;
  fieldName: string;
  label: string;
  onPostoSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const schema = props.collection.fieldSchemas?.[props.fieldName];
  const customized = (schema?.rows ?? 1) > 1;
  return (
    <>
      <ActionIcon
        variant="subtle"
        color={customized ? "blue" : "gray"}
        size="sm"
        title={`Configure ${props.label} rows`}
        aria-label={`Configure ${props.label} rows`}
        onClick={() => setOpen(true)}
      >
        <Settings2 size={16} />
      </ActionIcon>
      {open && (
        <RowsDialog
          root={props.root}
          collection={props.collection}
          fieldName={props.fieldName}
          label={props.label}
          schema={schema}
          onClose={() => setOpen(false)}
          onSaved={props.onPostoSaved}
        />
      )}
    </>
  );
}

/** Item-level controls for a collection-level template schema. */
export function FieldTemplateActions(props: {
  root: string;
  collection: ContentEntry;
  fieldName: string;
  label: string;
  onPostoSaved: () => void;
  onGenerate?: (template: string) => void;
  schema?: FieldTemplateSchema;
}) {
  const [open, setOpen] = useState(false);
  const schema = props.schema ?? props.collection.fieldSchemas?.[props.fieldName];
  const hasTemplate = Boolean(schema?.template);
  const Icon = hasTemplate ? NotebookText : NotepadTextDashed;
  return (
    <>
      <span className="field-template-actions">
        <ActionIcon
          variant="subtle"
          color={hasTemplate ? "blue" : "gray"}
          size="sm"
          title={`${hasTemplate ? "Edit" : "Add"} ${props.label} template`}
          aria-label={`${hasTemplate ? "Edit" : "Add"} ${props.label} template`}
          onClick={() => setOpen(true)}
        >
          <Icon size={16} />
        </ActionIcon>
      </span>
      {open && (
        <TemplateDialog
          root={props.root}
          collection={props.collection}
          fieldName={props.fieldName}
          label={props.label}
          schema={schema}
          onClose={() => setOpen(false)}
          onSaved={(next) => {
            props.onPostoSaved();
            if (next?.template && next.editBehavior === "controlled") {
              props.onGenerate?.(next.template);
            }
          }}
        />
      )}
    </>
  );
}
