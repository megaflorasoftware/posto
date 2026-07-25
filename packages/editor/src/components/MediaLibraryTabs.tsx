import type { MediaLibrary } from "@posto/core/pagescms/config";

export const PUBLIC_MEDIA_TAB = "__posto_public__";
export const SOURCE_MEDIA_TAB = "__posto_src__";

export function MediaLibraryTabs(props: {
  libraries: MediaLibrary[];
  showSource?: boolean;
  selected: string;
  onSelect: (value: string) => void;
}) {
  const tabs = [
    ...props.libraries.map((library) => ({
      value: library.collection,
      label: library.collection,
    })),
    ...(props.showSource ? [{ value: SOURCE_MEDIA_TAB, label: "src" }] : []),
    { value: PUBLIC_MEDIA_TAB, label: "public" },
  ];
  return (
    <div className="media-library-tabs" role="tablist" aria-label="Media library">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          className={`media-library-tab${props.selected === tab.value ? " is-active" : ""}`}
          aria-selected={props.selected === tab.value}
          onClick={() => props.onSelect(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
