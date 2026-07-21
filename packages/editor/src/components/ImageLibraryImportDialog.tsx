import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Group, Loader, Text, TextInput } from "@mantine/core";
import { Dropzone, IMAGE_MIME_TYPE } from "@mantine/dropzone";
import { ChevronLeft, ChevronRight, Image as ImageIcon, Upload } from "lucide-react";
import type { AstroImageLibrary, PagesConfig } from "@posto/core/pagescms/config";
import type { ValuePath } from "@posto/core/pagescms/frontmatter";
import { validateForm } from "@posto/core/pagescms/validate";
import {
  onFileDrop,
  prepareImageSources,
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
import { AdaptiveSelect } from "./AdaptiveSelect";

type ImportStep = "source" | "location" | "details";

function normalizeFolder(folder: string | undefined): string {
  return (folder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Imports one or more images into a library. A drag or a "Choose images"
 * pick can supply several source paths at once; the user then picks a single
 * destination for the whole batch and pages through the uploads with the
 * preview arrows, setting each one's filename and metadata before importing. */
export function ImageLibraryImportDialog(props: {
  root: string;
  library: AstroImageLibrary;
  config: PagesConfig;
  groups: FileGroup[];
  sourcePath?: string;
  sourcePaths?: string[];
  initialFolder?: string;
  /** Open the device picker immediately instead of showing the source step,
   * whose dropzone would just repeat the button that launched this dialog. */
  autoChooseSource?: boolean;
  onClose: () => void;
  onImported: (result: ImageLibraryImportResult) => void;
}) {
  const initialSources = props.sourcePaths?.length
    ? props.sourcePaths
    : props.sourcePath
      ? [props.sourcePath]
      : [];
  const rootFolder = normalizeFolder(props.initialFolder);
  const libraryRoot = `${props.root}/${props.library.base}`;
  const browserRoot = rootFolder ? `${libraryRoot}/${rootFolder}` : libraryRoot;
  const [step, setStep] = useState<ImportStep>(initialSources.length ? "location" : "source");
  const [currentDirectory, setCurrentDirectory] = useState("");
  const metadataFields = useMemo(() => imageLibraryMetadataFields(props.library), [props.library]);
  const libraryState = useImageLibraryAssets(props.root, props.library);
  const importer = useImageLibraryImport({
    root: props.root,
    library: props.library,
    initialSources,
    onImported: props.onImported,
  });

  const { drafts, index } = importer;
  const draft = drafts[index];
  const errors = validateForm(metadataFields, draft?.metadata ?? {});
  const sourceExtension = draft?.sourceImagePath.split(".").pop()?.toLowerCase() ?? "";
  const draftValid = (candidate: (typeof drafts)[number]) =>
    !!candidate.filename && validateForm(metadataFields, candidate.metadata).size === 0;
  const allValid = drafts.length > 0 && drafts.every(draftValid);

  const selectSources = async (paths: string[]) => {
    if (paths.length === 0) return;
    let prepared: string[];
    try {
      prepared = await prepareImageSources(paths);
    } catch (caught) {
      importer.setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    importer.setSources(prepared);
    setStep("location");
  };

  useEffect(() => {
    if (step !== "source") return;
    return onFileDrop((paths) => void selectSources(paths));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Auto-launch the picker on open (mobile), closing the dialog on cancel so the
  // user never sees a redundant "choose images" step behind the native sheet.
  useEffect(() => {
    if (!props.autoChooseSource || initialSources.length > 0) return;
    let active = true;
    void (async () => {
      const paths = await importer.chooseSources();
      if (!active) return;
      if (paths.length === 0) props.onClose();
      else await selectSources(paths);
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseSource = async () => {
    await selectSources(await importer.chooseSources());
  };

  const chooseLocation = () => {
    const folder = [rootFolder, currentDirectory].filter(Boolean).join("/");
    importer.setFolder(folder);
    setStep("details");
  };

  const update = (path: ValuePath, value: unknown) => {
    importer.updateDraft(index, (current) => ({
      ...current,
      metadata: editValueAtPath(current.metadata, path, value),
    }));
  };
  const fieldCtx: FieldContext = {
    config: props.config,
    root: props.root,
    entry: null,
    groups: props.groups,
    errors: () => errors,
    templateValues: () => draft?.metadata ?? {},
    value: (path) => valueAtPath(draft?.metadata ?? {}, path),
    edit: update,
    listAppend: (path, value) => {
      const list = valueAtPath(draft?.metadata ?? {}, path);
      update(path, [...(Array.isArray(list) ? list : []), value]);
    },
    listRemove: (path, itemIndex) => {
      const list = valueAtPath(draft?.metadata ?? {}, path);
      if (Array.isArray(list))
        update(
          path,
          list.filter((_item, i) => i !== itemIndex),
        );
    },
    listMove: (path, from, to) => {
      const list = valueAtPath(draft?.metadata ?? {}, path);
      if (!Array.isArray(list)) return;
      const moved = [...list];
      const [item] = moved.splice(from, 1);
      moved.splice(to, 0, item);
      update(path, moved);
    },
  };

  const importAll = async () => {
    if (await importer.execute()) props.onClose();
  };

  const countSuffix = drafts.length > 1 ? ` (${drafts.length} images)` : "";
  const title =
    step === "source"
      ? "Choose images to import"
      : step === "location"
        ? `Choose a location in ${props.library.collection}${countSuffix}`
        : `Import into ${props.library.collection}${countSuffix}`;

  return (
    <Dialog opened onClose={props.onClose} title={title} size="xl">
      {importer.error && (
        <Alert color="red" mb="sm">
          {importer.error}
        </Alert>
      )}

      {step === "source" && props.autoChooseSource && (
        <Group justify="center" mih={140}>
          <Loader />
        </Group>
      )}

      {step === "source" && !props.autoChooseSource && (
        <Dropzone
          className="image-library-import-dropzone"
          accept={IMAGE_MIME_TYPE}
          multiple
          activateOnClick={false}
          onDrop={(files) => {
            const paths = files
              .map((file) => (file as File & { path?: string }).path)
              .filter((path): path is string => !!path);
            if (paths.length > 0) void selectSources(paths);
            else
              importer.setError(
                "Could not read the dropped file paths. Use Choose images instead.",
              );
          }}
          onReject={() => importer.setError("Choose supported image files.")}
        >
          <Group justify="center" gap="xl" mih={180}>
            <Upload size={42} />
            <div>
              <Text className="image-library-import-desktop-copy" size="lg" fw={600}>
                Drop images here
              </Text>
              <Text className="image-library-import-mobile-copy" size="lg" fw={600}>
                Choose images from your device
              </Text>
              <Text className="image-library-import-desktop-copy" size="sm" c="dimmed" mb="md">
                or choose them from your device
              </Text>
              <Button
                onClick={(event) => {
                  event.stopPropagation();
                  void chooseSource();
                }}
              >
                Choose images
              </Button>
            </div>
          </Group>
        </Dropzone>
      )}

      {step === "location" && (
        <>
          {libraryState.error && (
            <Alert color="red" mb="sm">
              Could not read image library: {libraryState.error}
            </Alert>
          )}
          <ImageLibraryBrowser
            rootDirectory={browserRoot}
            currentDirectory={currentDirectory}
            directories={libraryState.directories}
            assets={libraryState.assets}
            onDirectoryChange={setCurrentDirectory}
          />
          <Button fullWidth mt="md" onClick={chooseLocation}>
            Choose location
          </Button>
        </>
      )}

      {step === "details" && draft && (
        <div className="image-library-import-details">
          <div className="image-library-import-preview">
            <CachedImage path={draft.sourceImagePath} alt="" fallback={<ImageIcon size={28} />} />
            {drafts.length > 1 && (
              <>
                <button
                  type="button"
                  className="image-library-import-pager-btn is-prev"
                  aria-label="Previous image"
                  disabled={index === 0}
                  onClick={() => importer.setIndex(index - 1)}
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  type="button"
                  className="image-library-import-pager-btn is-next"
                  aria-label="Next image"
                  disabled={index === drafts.length - 1}
                  onClick={() => importer.setIndex(index + 1)}
                >
                  <ChevronRight size={18} />
                </button>
                <span className="image-library-import-pager-count">
                  {index + 1} / {drafts.length}
                </span>
              </>
            )}
          </div>
          <div className="image-library-import-form">
            <TextInput
              size="xs"
              label="Filename (Astro ID)"
              description={
                importer.folder
                  ? `Importing into ${importer.folder}`
                  : "Importing at the library root"
              }
              value={draft.filename}
              error={!draft.filename ? "Required" : undefined}
              rightSection={
                <Text size="xs" c="dimmed">
                  .{sourceExtension}
                </Text>
              }
              rightSectionWidth={`${Math.max(3, sourceExtension.length + 1)}ch`}
              onChange={(event) => {
                const filename = event.currentTarget.value;
                importer.updateDraft(index, (current) => ({ ...current, filename }));
              }}
            />
            {props.library.metadataExtensions.length > 1 && (
              <AdaptiveSelect
                size="xs"
                label="Metadata format"
                data={props.library.metadataExtensions.map((extension) => ({
                  value: extension,
                  label: `.${extension}`,
                }))}
                value={draft.metadataExtension ?? null}
                onChange={(value) =>
                  importer.updateDraft(index, (current) => ({
                    ...current,
                    metadataExtension: value as typeof current.metadataExtension,
                  }))
                }
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
              disabled={!allValid}
              onClick={() => void importAll()}
            >
              {drafts.length > 1 ? `Import ${drafts.length} images` : "Import image"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
