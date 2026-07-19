import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Group, Select, Text, TextInput } from "@mantine/core";
import { Dropzone, IMAGE_MIME_TYPE } from "@mantine/dropzone";
import { Image as ImageIcon, Upload } from "lucide-react";
import type { AstroImageLibrary, PagesConfig } from "@posto/core/pagescms/config";
import type { ValuePath } from "@posto/core/pagescms/frontmatter";
import { validateForm } from "@posto/core/pagescms/validate";
import {
  onFileDrop,
  type FileGroup,
  type ImageLibraryImportResult,
} from "@posto/ipc";
import { useImageLibraryAssets } from "../hooks/useImageLibraryAssets";
import { useImageLibraryImport } from "../hooks/useImageLibraryImport";
import { editValueAtPath, imageLibraryMetadataFields, valueAtPath } from "../imageLibraryMetadata";
import { Dialog } from "./Dialog";
import { CachedImage } from "./CachedImage";
import { FieldEditor, type FieldContext } from "./FieldEditor";
import { ImageLibraryBrowser } from "./ImageLibraryBrowser";

type ImportStep = "source" | "location" | "details";

function normalizeFolder(folder: string | undefined): string {
  return (folder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function ImageLibraryImportDialog(props: {
  root: string;
  library: AstroImageLibrary;
  config: PagesConfig;
  groups: FileGroup[];
  sourcePath?: string;
  initialFolder?: string;
  onClose: () => void;
  onImported: (result: ImageLibraryImportResult) => void;
}) {
  const rootFolder = normalizeFolder(props.initialFolder);
  const libraryRoot = `${props.root}/${props.library.base}`;
  const browserRoot = rootFolder ? `${libraryRoot}/${rootFolder}` : libraryRoot;
  const [step, setStep] = useState<ImportStep>(props.sourcePath ? "location" : "source");
  const [currentDirectory, setCurrentDirectory] = useState("");
  const metadataFields = useMemo(
    () => imageLibraryMetadataFields(props.library),
    [props.library],
  );
  const libraryState = useImageLibraryAssets(props.root, props.library);
  const importer = useImageLibraryImport({
    root: props.root,
    library: props.library,
    initialSourcePath: props.sourcePath,
    onImported: props.onImported,
  });
  const errors = validateForm(metadataFields, importer.draft.metadata);
  const sourceExtension = importer.draft.sourceImagePath?.split(".").pop()?.toLowerCase() ?? "";

  const selectSource = (path: string) => {
    importer.setSource(path);
    setStep("location");
  };

  useEffect(() => {
    if (step !== "source") return;
    return onFileDrop((paths) => {
      const path = paths[0];
      if (path) selectSource(path);
    });
  }, [step]);

  const chooseSource = async () => {
    const path = await importer.chooseSource();
    if (path) setStep("location");
  };

  const chooseLocation = () => {
    const folder = [rootFolder, currentDirectory].filter(Boolean).join("/");
    importer.setDraft((draft) => ({ ...draft, folder }));
    setStep("details");
  };

  const update = (path: ValuePath, value: unknown) => {
    importer.setDraft((draft) => ({
      ...draft,
      metadata: editValueAtPath(draft.metadata, path, value),
    }));
  };
  const fieldCtx: FieldContext = {
    config: props.config,
    root: props.root,
    entry: null,
    groups: props.groups,
    errors: () => errors,
    templateValues: () => importer.draft.metadata,
    value: (path) => valueAtPath(importer.draft.metadata, path),
    edit: update,
    listAppend: (path, value) => {
      const list = valueAtPath(importer.draft.metadata, path);
      update(path, [...(Array.isArray(list) ? list : []), value]);
    },
    listRemove: (path, index) => {
      const list = valueAtPath(importer.draft.metadata, path);
      if (Array.isArray(list)) update(path, list.filter((_item, itemIndex) => itemIndex !== index));
    },
    listMove: (path, from, to) => {
      const list = valueAtPath(importer.draft.metadata, path);
      if (!Array.isArray(list)) return;
      const moved = [...list];
      const [item] = moved.splice(from, 1);
      moved.splice(to, 0, item);
      update(path, moved);
    },
  };

  const title = step === "source"
    ? "Choose image to import"
    : step === "location"
      ? `Choose a location in ${props.library.collection}`
      : `Import into ${props.library.collection}`;

  return (
    <Dialog opened onClose={props.onClose} title={title} size="xl">
      {importer.error && <Alert color="red" mb="sm">{importer.error}</Alert>}

      {step === "source" && (
        <Dropzone
          className="image-library-import-dropzone"
          accept={IMAGE_MIME_TYPE}
          multiple={false}
          activateOnClick={false}
          onDrop={(files) => {
            const path = (files[0] as File & { path?: string } | undefined)?.path;
            if (path) selectSource(path);
            else importer.setError("Could not read the dropped file path. Use Choose image instead.");
          }}
          onReject={() => importer.setError("Choose a supported image file.")}
        >
          <Group justify="center" gap="xl" mih={180}>
            <Upload size={42} />
            <div>
              <Text size="lg" fw={600}>Drop an image here</Text>
              <Text size="sm" c="dimmed" mb="md">or choose one from your device</Text>
              <Button onClick={(event) => { event.stopPropagation(); void chooseSource(); }}>
                Choose image
              </Button>
            </div>
          </Group>
        </Dropzone>
      )}

      {step === "location" && (
        <>
          {libraryState.error && (
            <Alert color="red" mb="sm">Could not read image library: {libraryState.error}</Alert>
          )}
          <ImageLibraryBrowser
            rootDirectory={browserRoot}
            currentDirectory={currentDirectory}
            directories={libraryState.directories}
            assets={libraryState.assets}
            onDirectoryChange={setCurrentDirectory}
          />
          <Button fullWidth mt="md" onClick={chooseLocation}>Choose location</Button>
        </>
      )}

      {step === "details" && (
        <div className="image-library-import-details">
          <div className="image-library-import-preview">
            <CachedImage
              path={importer.draft.sourceImagePath}
              alt=""
              fallback={<ImageIcon size={28} />}
            />
          </div>
          <div className="image-library-import-form">
            <TextInput
              size="xs"
              label="Filename (Astro ID)"
              description={importer.draft.folder ? `Importing into ${importer.draft.folder}` : "Importing at the library root"}
              value={importer.draft.filename}
              rightSection={<Text size="xs" c="dimmed">.{sourceExtension}</Text>}
              rightSectionWidth={`${Math.max(3, sourceExtension.length + 1)}ch`}
              onChange={(event) => importer.setDraft((draft) => ({ ...draft, filename: event.currentTarget.value }))}
            />
            {props.library.metadataExtensions.length > 1 && (
              <Select
                size="xs"
                label="Metadata format"
                data={props.library.metadataExtensions.map((extension) => ({
                  value: extension,
                  label: `.${extension}`,
                }))}
                value={importer.draft.metadataExtension ?? null}
                onChange={(value) => importer.setDraft((draft) => ({
                  ...draft,
                  metadataExtension: value as typeof draft.metadataExtension,
                }))}
              />
            )}
            <div className="form-fields image-library-metadata-fields">
              {metadataFields.map((field) => (
                <FieldEditor key={field.name} field={field} path={[field.name]} ctx={fieldCtx} />
              ))}
            </div>
            <Button
              fullWidth
              mt="md"
              loading={importer.pending}
              disabled={!importer.draft.sourceImagePath || !importer.draft.filename || errors.size > 0}
              onClick={() => void importer.execute().then((result) => { if (result) props.onClose(); })}
            >
              Import image
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
