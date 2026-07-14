import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Loader,
  Modal,
  Select,
  TextInput,
} from "@mantine/core";
import { ArrowLeft, Search } from "lucide-react";
import { invoke, openDirectory, openUrl } from "../ipc";

/** One row of the portal's /api/themes response (one row per theme×category). */
type CatalogRow = {
  Theme: {
    slug: string;
    title: string;
    description: string;
    image: string;
  };
  Author?: { name: string; avatar: string | null };
  ThemeCategory?: { value: string; name: string };
};

type CatalogTheme = {
  slug: string;
  title: string;
  description: string;
  image: string;
  author: { name: string; avatar: string | null } | null;
  categories: { value: string; name: string }[];
};

/** The join in /api/themes repeats a theme once per category; fold those. */
function parseCatalog(raw: string): CatalogTheme[] {
  const rows = JSON.parse(raw) as CatalogRow[];
  const bySlug = new Map<string, CatalogTheme>();
  for (const row of rows) {
    if (!row?.Theme?.slug) continue;
    let theme = bySlug.get(row.Theme.slug);
    if (!theme) {
      theme = {
        slug: row.Theme.slug,
        title: row.Theme.title,
        description: row.Theme.description,
        image: row.Theme.image,
        author: row.Author ? { name: row.Author.name, avatar: row.Author.avatar } : null,
        categories: [],
      };
      bySlug.set(theme.slug, theme);
    }
    if (row.ThemeCategory && !theme.categories.some((c) => c.value === row.ThemeCategory!.value)) {
      theme.categories.push(row.ThemeCategory);
    }
  }
  return [...bySlug.values()];
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function TemplateGallery(props: {
  onClose: () => void;
  /** Called with the cloned project's root once the template is on disk. */
  onCloned: (dir: string) => void;
}) {
  const [themes, setThemes] = useState<CatalogTheme[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | null>(null);

  const [selected, setSelected] = useState<CatalogTheme | null>(null);
  // null while the details request (which carries the repo URL) is in flight.
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("themes_api", { path: "/api/themes?price%5B%5D=free&technology%5B%5D=mdx" })
      .then((raw) => {
        if (!cancelled) setThemes(parseCatalog(raw));
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The list response has no repo URL; the details endpoint does.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setRepoUrl(null);
    setDetailsError(null);
    invoke<string>("themes_api", {
      path: `/api/themes/details?slug=${encodeURIComponent(selected.slug)}`,
    })
      .then((raw) => {
        if (cancelled) return;
        const url: unknown = (JSON.parse(raw) as { Theme?: { repoUrl?: unknown } })?.Theme?.repoUrl;
        if (typeof url === "string" && url.startsWith("https://")) {
          setRepoUrl(url);
        } else {
          setDetailsError("This template doesn't provide a public repository to clone.");
        }
      })
      .catch((e) => {
        if (!cancelled) setDetailsError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const categoryOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const theme of themes ?? []) {
      for (const cat of theme.categories) seen.set(cat.value, cat.name);
    }
    return [...seen]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [themes]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (themes ?? []).filter(
      (theme) =>
        (!category || theme.categories.some((c) => c.value === category)) &&
        (!term ||
          theme.title.toLowerCase().includes(term) ||
          theme.description.toLowerCase().includes(term)),
    );
  }, [themes, search, category]);

  function openTheme(theme: CatalogTheme) {
    setSelected(theme);
    setName(theme.slug);
    setCloneError(null);
  }

  function closeModal() {
    if (cloning) return; // mid-clone; let it finish or fail
    setSelected(null);
  }

  const nameValid = NAME_PATTERN.test(name.trim());

  async function createSite() {
    if (!repoUrl || !nameValid) return;
    // The dialog picks the parent folder; the project lands in a new
    // subfolder named by the user.
    const parent = await openDirectory();
    if (typeof parent !== "string") return;
    const dest = parent.replace(/[/\\]+$/, "") + "/" + name.trim();
    setCloning(true);
    setCloneError(null);
    try {
      await invoke("clone_template", { url: repoUrl, dest });
    } catch (e) {
      setCloneError(String(e));
      setCloning(false);
      return;
    }
    props.onCloned(dest);
  }

  return (
    <div className="template-page">
      <header className="template-header">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          aria-label="Back"
          onClick={props.onClose}
        >
          <ArrowLeft size={18} />
        </ActionIcon>
        <div className="template-heading">
          <h2>Start with a template</h2>
          <p className="template-note">
            Free MDX templates from the{" "}
            <Anchor
              size="sm"
              href="https://astro.build/themes/"
              onClick={(e) => {
                e.preventDefault();
                void openUrl("https://astro.build/themes/");
              }}
            >
              Astro Themes
            </Anchor>{" "}
            catalog, built by independent authors. Some customizations may require editing code.
          </p>
        </div>
        <TextInput
          size="xs"
          w={200}
          placeholder="Search templates"
          leftSection={<Search size={14} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <Select
          size="xs"
          w={170}
          placeholder="All categories"
          clearable
          data={categoryOptions}
          value={category}
          onChange={setCategory}
        />
      </header>

      {loadError ? (
        <div className="template-status">
          <Alert color="red">{loadError}</Alert>
        </div>
      ) : themes === null ? (
        <div className="template-status">
          <Loader size="sm" />
        </div>
      ) : visible.length === 0 ? (
        <div className="template-status">No templates match.</div>
      ) : (
        <div className="template-grid">
          {visible.map((theme) => (
            <button
              key={theme.slug}
              type="button"
              className="template-card"
              onClick={() => openTheme(theme)}
            >
              <img className="template-card-image" src={theme.image} alt="" loading="lazy" />
              <div className="template-card-body">
                <div className="template-card-title-row">
                  <span className="template-card-title">{theme.title}</span>
                  {theme.categories.map((cat) => (
                    <Badge key={cat.value} size="xs" variant="light" color="gray">
                      {cat.name}
                    </Badge>
                  ))}
                </div>
                <p className="template-card-description">{theme.description}</p>
                {theme.author && (
                  <span className="template-card-author">
                    {theme.author.avatar && <img src={theme.author.avatar} alt="" />}
                    {theme.author.name}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      <Modal opened={selected !== null} onClose={closeModal} title="Use this template?">
        {selected && (
          <>
            <img className="template-modal-image" src={selected.image} alt="" />
            <p className="template-modal-description">{selected.description}</p>
            {detailsError ? (
              <Alert color="red" mt="sm">
                {detailsError}
              </Alert>
            ) : (
              <TextInput
                mt="sm"
                size="xs"
                label="Project name"
                description="The folder the template is copied into — you'll pick where it goes next."
                value={name}
                error={
                  !nameValid &&
                  "Use letters, numbers, dots, dashes, and underscores (no leading dot)."
                }
                onChange={(e) => setName(e.currentTarget.value)}
              />
            )}
            {cloneError && (
              <Alert color="red" mt="sm">
                {cloneError}
              </Alert>
            )}
            <div className="template-modal-actions">
              <Button variant="default" size="xs" disabled={cloning} onClick={closeModal}>
                Cancel
              </Button>
              <Button
                size="xs"
                loading={cloning || (repoUrl === null && detailsError === null)}
                disabled={repoUrl === null || !nameValid}
                onClick={() => void createSite()}
              >
                {cloning ? "Copying template…" : "Choose location & create"}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
