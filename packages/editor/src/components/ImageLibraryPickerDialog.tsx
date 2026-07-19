import { Alert, Button } from "@mantine/core";
import type { ImageLibraryAsset } from "@posto/core/astro/imageLibrary";
import type { AstroImageLibrary } from "@posto/core/pagescms/config";
import { assetUrl, openPath } from "@posto/ipc";
import { Dialog } from "./Dialog";

export function ImageLibraryPickerDialog(props: {
  root: string;
  library: AstroImageLibrary;
  assets: ImageLibraryAsset[];
  directory?: string;
  error?: string | null;
  onClose: () => void;
  onPick: (asset: ImageLibraryAsset) => void;
  onImport: () => void;
}) {
  const directory = props.directory ?? `${props.root}/${props.library.base}`;
  return (
    <Dialog opened onClose={props.onClose} title={`Choose from ${props.library.collection}`} size="xl">
      {props.error && <Alert color="red" mb="sm">{props.error}</Alert>}
      {props.assets.length === 0 ? (
        <div className="picker-empty">No image entries in {props.library.collection}</div>
      ) : (
        <div className="picker-grid">
          {props.assets.map((asset) => {
            const valid = asset.health.includes("valid");
            const src = asset.imagePath ? assetUrl(asset.imagePath) : null;
            const alt = typeof asset.metadata.alt === "string" ? asset.metadata.alt : asset.entryId;
            return (
              <button
                key={`${asset.entryId}:${asset.metadataPath}`}
                className="picker-card"
                disabled={!valid}
                onClick={() => valid && props.onPick(asset)}
              >
                <span className="picker-card-preview">
                  {src ? <img src={src} alt={alt} loading="lazy" /> : <span className="picker-card-noimg">No preview</span>}
                </span>
                <span className="picker-item-name">{asset.entryId}</span>
                <span className="picker-item-path">{valid ? alt : asset.health.join(", ")}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="image-library-picker-actions">
        <Button variant="outline" onClick={() => void openPath(directory)}>
          Open Media Library
        </Button>
        <Button onClick={props.onImport}>Import image</Button>
      </div>
    </Dialog>
  );
}
