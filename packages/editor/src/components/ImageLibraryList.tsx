import { UnstyledButton } from "@mantine/core";
import { ChevronRight } from "lucide-react";
import type { AstroImageLibrary } from "@posto/core/pagescms/config";

export function ImageLibraryList(props: {
  libraries: AstroImageLibrary[];
  onChoose: (library: AstroImageLibrary) => void;
}) {
  return (
    <div className="image-library-list">
      {props.libraries.map((library) => (
        <UnstyledButton
          key={library.collection}
          className="image-library-list-item"
          onClick={() => props.onChoose(library)}
        >
          <span>
            <span className="image-library-list-name">{library.collection}</span>
            <span className="image-library-list-path">{library.base}</span>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </UnstyledButton>
      ))}
    </div>
  );
}
