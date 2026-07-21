import { useEffect, useMemo, useState } from "react";
import {
  Button,
  NativeSelect,
  Select,
  TagsInput,
  TextInput,
  type SelectProps,
  type TagsInputProps,
} from "@mantine/core";
import { Check, ChevronDown, X } from "lucide-react";
import { Dialog, useDialogVariant } from "./Dialog";

type Option = { value: string; label: string; disabled?: boolean };

function optionsFromData(data: SelectProps["data"] | TagsInputProps["data"]): Option[] {
  const options: Option[] = [];
  for (const item of data ?? []) {
    if (typeof item === "string") {
      options.push({ value: item, label: item });
      continue;
    }
    const candidate = item as unknown as {
      group?: unknown;
      items?: SelectProps["data"];
      value?: unknown;
      label?: unknown;
      disabled?: boolean;
    };
    if (candidate.group !== undefined && Array.isArray(candidate.items)) {
      options.push(...optionsFromData(candidate.items));
    } else if (typeof candidate.value === "string") {
      options.push({
        value: candidate.value,
        label: typeof candidate.label === "string" ? candidate.label : candidate.value,
        disabled: candidate.disabled,
      });
    }
  }
  return options;
}

function MobileOptionDrawer(props: {
  opened: boolean;
  title: string;
  options: Option[];
  selected: string[];
  multiple?: boolean;
  clearable?: boolean;
  allowCustom?: boolean;
  nothingFoundMessage?: string;
  onClose: () => void;
  onChoose: (value: string) => void;
  onClear?: () => void;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (props.opened) setQuery("");
  }, [props.opened]);
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = props.options.filter(
    (option) => !normalized || option.label.toLocaleLowerCase().includes(normalized),
  );
  const custom =
    props.allowCustom &&
    query.trim() !== "" &&
    !props.options.some((option) => option.value.toLocaleLowerCase() === normalized)
      ? query.trim()
      : null;

  return (
    <Dialog opened={props.opened} onClose={props.onClose} title={props.title} size="sm">
      <div className="mobile-combobox-drawer">
        <div
          className="mobile-combobox-options"
          role="listbox"
          aria-multiselectable={props.multiple}
        >
          {props.clearable && !props.multiple && props.selected.length > 0 && (
            <button type="button" className="mobile-combobox-option" onClick={props.onClear}>
              <span>None</span>
              <X size={18} />
            </button>
          )}
          {filtered.map((option) => {
            const selected = props.selected.includes(option.value);
            return (
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className="mobile-combobox-option"
                key={option.value}
                disabled={option.disabled}
                onClick={() => props.onChoose(option.value)}
              >
                <span>{option.label}</span>
                {selected && <Check size={18} />}
              </button>
            );
          })}
          {custom && (
            <button
              type="button"
              className="mobile-combobox-option"
              onClick={() => props.onChoose(custom)}
            >
              <span>Add “{custom}”</span>
            </button>
          )}
          {filtered.length === 0 && !custom && (
            <div className="mobile-combobox-empty">
              {props.nothingFoundMessage ?? "No options found"}
            </div>
          )}
        </div>
        <div className="mobile-combobox-search">
          <TextInput
            autoFocus
            aria-label={`Search ${props.title}`}
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          {props.multiple && <Button onClick={props.onClose}>Done</Button>}
        </div>
      </div>
    </Dialog>
  );
}

/** Desktop uses Mantine's select. Mobile uses either a native select for
 * ordinary choices or a bottom-drawer combobox when search is requested. */
export function AdaptiveSelect(props: SelectProps) {
  const variant = useDialogVariant();
  const [opened, setOpened] = useState(false);
  const options = useMemo(() => optionsFromData(props.data), [props.data]);
  const drawerTitle =
    typeof props.label === "string"
      ? props.label
      : typeof props["aria-label"] === "string"
        ? props["aria-label"]
        : "Choose option";
  if (variant !== "drawer") return <Select {...props} />;

  if (!props.searchable) {
    const nativeData = [
      ...(props.clearable || props.placeholder
        ? [
            {
              value: "",
              label: props.placeholder ?? "None",
              disabled: !props.clearable,
            },
          ]
        : []),
      ...options,
    ];
    return (
      <NativeSelect
        size={props.size}
        mt={props.mt}
        label={props.label}
        description={props.description}
        error={props.error}
        disabled={props.disabled}
        data={nativeData}
        value={props.value ?? ""}
        onChange={(event) => {
          const value = event.currentTarget.value || null;
          const option = options.find((candidate) => candidate.value === value) ?? {
            value: "",
            label: "None",
          };
          props.onChange?.(value, option);
        }}
      />
    );
  }

  const selected = options.find((option) => option.value === props.value);
  return (
    <>
      <TextInput
        className="mobile-combobox-trigger"
        size={props.size}
        mt={props.mt}
        label={props.label}
        description={props.description}
        error={props.error}
        disabled={props.disabled}
        readOnly
        aria-label={props["aria-label"]}
        placeholder={props.placeholder}
        value={selected?.label ?? ""}
        rightSection={<ChevronDown size={16} />}
        onClick={() => !props.disabled && setOpened(true)}
      />
      <MobileOptionDrawer
        opened={opened}
        title={drawerTitle}
        options={options}
        selected={props.value ? [props.value] : []}
        clearable={props.clearable}
        nothingFoundMessage={
          typeof props.nothingFoundMessage === "string" ? props.nothingFoundMessage : undefined
        }
        onClose={() => setOpened(false)}
        onClear={() => {
          props.onChange?.(null, { value: "", label: "None" });
          setOpened(false);
        }}
        onChoose={(value) => {
          const option = options.find((candidate) => candidate.value === value)!;
          props.onChange?.(value, option);
          setOpened(false);
        }}
      />
    </>
  );
}

/** TagsInput is a multi-value combobox: on mobile it uses the same searchable
 * drawer, preserving custom values and toggling suggestions in place. */
export function AdaptiveTagsInput(props: TagsInputProps) {
  const variant = useDialogVariant();
  const [opened, setOpened] = useState(false);
  const options = useMemo(() => optionsFromData(props.data), [props.data]);
  const drawerTitle =
    typeof props.label === "string"
      ? props.label
      : typeof props["aria-label"] === "string"
        ? props["aria-label"]
        : "Choose options";
  if (variant !== "drawer") return <TagsInput {...props} />;

  const values = props.value ?? [];
  const labels = values.map(
    (value) => options.find((option) => option.value === value)?.label ?? value,
  );
  return (
    <>
      <TextInput
        className="mobile-combobox-trigger"
        size={props.size}
        mt={props.mt}
        label={props.label}
        description={props.description}
        error={props.error}
        disabled={props.disabled}
        readOnly
        aria-label={props["aria-label"]}
        placeholder={props.placeholder}
        value={labels.join(", ")}
        rightSection={<ChevronDown size={16} />}
        onClick={() => !props.disabled && setOpened(true)}
      />
      <MobileOptionDrawer
        opened={opened}
        title={drawerTitle}
        options={options}
        selected={values}
        multiple
        allowCustom
        onClose={() => setOpened(false)}
        onChoose={(value) =>
          props.onChange?.(
            values.includes(value)
              ? values.filter((current) => current !== value)
              : [...values, value],
          )
        }
      />
    </>
  );
}
