export function PickerCardSelection(props: {
  selected: boolean;
  interactive?: boolean;
  label: string;
  onToggle?: () => void;
}) {
  const className = `picker-card-selection${props.selected ? " is-selected" : ""}${
    props.interactive ? " is-inline" : ""
  }`;

  if (!props.interactive) return <span className={className} aria-hidden="true" />;

  return (
    <button
      type="button"
      className={className}
      title={`${props.selected ? "Deselect" : "Select"} ${props.label}`}
      aria-label={`${props.selected ? "Deselect" : "Select"} ${props.label}`}
      aria-pressed={props.selected}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle?.();
      }}
    />
  );
}
