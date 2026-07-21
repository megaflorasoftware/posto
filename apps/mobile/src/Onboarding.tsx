import {
  ActionIcon,
  Alert,
  Avatar,
  Button,
  Center,
  Group,
  Loader,
  Progress,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { assetUrl } from "@posto/ipc";
import type {
  CloneProgress,
  DeviceAuthorization,
  GitHubRepo,
  GitHubUser,
} from "@posto/ipc";
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FolderGit2,
  LockKeyhole,
  LogOut,
  RefreshCw,
  RotateCcw,
  Search,
  Smartphone,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import RepoHome from "./RepoHome";

// A downloaded site's favicon usually lives at one of these `public/` paths;
// the first that loads wins, otherwise the row falls back to the lock/folder
// icon. SVG comes first because it is the Astro default.
const FAVICON_CANDIDATES = ["favicon.svg", "favicon.ico", "favicon.png"];

type Stage =
  | "loading"
  | "signed-out"
  | "authorizing"
  | "repos-loading"
  | "repos"
  | "cloning"
  | "clone-error"
  | "home";

type Props = {
  stage: Stage;
  user: GitHubUser | null;
  device: DeviceAuthorization | null;
  repos: GitHubRepo[];
  downloaded: Set<string>;
  /** Local checkout root per downloaded repo, keyed by `owner/name`. */
  roots: Map<string, string>;
  selectedRepo: GitHubRepo | null;
  readyRoot: string | null;
  progress: CloneProgress;
  error: string | null;
  onSignIn: () => void;
  onSignOut: () => void;
  onOpenVerification: () => void;
  onChooseRepo: (repo: GitHubRepo) => void;
  onRetryRepos: () => void;
  onRetryClone: () => void;
  onCancelClone: () => void;
  onRedownloadRepo: (repo: GitHubRepo, root: string) => Promise<void>;
  onRemoveRepo: (root: string) => Promise<void>;
  onChangeRepo: () => void;
};

function Header({
  stage,
  user,
  onSignOut,
}: Pick<Props, "stage" | "user" | "onSignOut">) {
  return (
    <header className="mobile-header">
      <Text fw={600} size="sm">
        {stage === "repos" || stage === "repos-loading" ? "Repositories" : "Posto"}
      </Text>
      {(stage === "repos" || stage === "repos-loading") && user && (
        <Group gap="xs" wrap="nowrap">
          <Avatar src={user.avatar_url} alt={user.name} size={36} radius="xl" />
          <ActionIcon variant="subtle" color="gray" aria-label="Sign out" onClick={onSignOut}>
            <LogOut size={18} />
          </ActionIcon>
        </Group>
      )}
    </header>
  );
}

function ErrorNotice({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="error-notice" role="alert">
      {error}
    </div>
  );
}

function SignIn({ onSignIn }: Pick<Props, "onSignIn">) {
  return (
    <main className="centered-screen">
      <Stack gap="md" align="center" w="100%" maw={340}>
        <Title order={2}>Posto</Title>
        <Text c="dimmed" ta="center">
          Connect GitHub to choose a site and edit its documents.
        </Text>
        <Button leftSection={<FolderGit2 size={16} />} onClick={onSignIn}>
          Continue with GitHub
        </Button>
      </Stack>
    </main>
  );
}

function Authorizing({ device, onOpenVerification }: Pick<Props, "device" | "onOpenVerification">) {
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    if (!device) return;
    await navigator.clipboard.writeText(device.user_code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <main className="centered-screen">
      {!device ? (
        <Stack align="center" gap="lg">
          <Loader />
          <div>
            <Title order={2} ta="center">Connecting to GitHub</Title>
            <Text c="dimmed" ta="center" mt={6}>Requesting a one-time sign-in code…</Text>
          </div>
        </Stack>
      ) : (
        <Stack gap="xl" w="100%" maw={380}>
          <ThemeIcon size={56} radius="sm" variant="light" mx="auto">
            <Smartphone size={30} />
          </ThemeIcon>
          <div>
            <Title order={2} ta="center">Enter this code on GitHub</Title>
          </div>
          <button className="device-code" onClick={() => void copyCode()}>
            <span>{device.user_code}</span>
            {copied ? <Check size={20} /> : <Copy size={20} />}
          </button>
          <Button
            rightSection={<ExternalLink size={18} />}
            onClick={onOpenVerification}
          >
            Open GitHub
          </Button>
          <Text size="sm" c="dimmed" ta="center">
            Posto will continue automatically after you approve access.
          </Text>
        </Stack>
      )}
    </main>
  );
}

// Shows the downloaded site's favicon when one is present, cascading through
// the candidate paths on load errors. Repos without a local checkout (or with
// no favicon) render the original private/public icon instead.
function RepoRowIcon({ root, isPrivate }: { root: string | undefined; isPrivate: boolean }) {
  const [candidate, setCandidate] = useState(0);
  useEffect(() => setCandidate(0), [root]);

  const fallbackIcon = (
    <ThemeIcon variant="light" color={isPrivate ? undefined : "gray"} radius="sm">
      {isPrivate ? <LockKeyhole size={17} /> : <FolderGit2 size={17} />}
    </ThemeIcon>
  );

  if (!root || candidate >= FAVICON_CANDIDATES.length) return fallbackIcon;
  const src = assetUrl(`${root}/public/${FAVICON_CANDIDATES[candidate]}`);
  if (!src) return fallbackIcon;
  return (
    <img
      className="repo-favicon"
      src={src}
      alt=""
      onError={() => setCandidate((index) => index + 1)}
    />
  );
}

function RepoPicker({ repos, downloaded, roots, error, onChooseRepo, onRetryRepos }: Props) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matching = normalized
      ? repos.filter((repo) => repo.full_name.toLowerCase().includes(normalized))
      : repos;
    return [...matching].sort((left, right) => {
      return Number(downloaded.has(right.full_name)) - Number(downloaded.has(left.full_name));
    });
  }, [downloaded, query, repos]);

  return (
    <main className="repo-screen">
      <div className="repo-screen-search">
        <TextInput
          size="lg"
          radius="sm"
          leftSection={<Search size={20} />}
          placeholder="Search repositories"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          aria-label="Search repositories"
        />
      </div>
      <div className="repo-error-slot">
        <ErrorNotice error={error} />
      </div>
      {error && repos.length === 0 ? (
        <Center className="empty-state">
          <Stack align="center">
            <Text c="dimmed" ta="center">We couldn't load your repositories.</Text>
            <Button variant="light" leftSection={<RefreshCw size={16} />} onClick={onRetryRepos}>
              Try again
            </Button>
          </Stack>
        </Center>
      ) : (
        <ScrollArea className="repo-list" type="auto">
          <div className="repo-list-content">
            {filtered.map((repo) => {
              const isDownloaded = downloaded.has(repo.full_name);
              return (
                <button className="repo-row" key={repo.id} onClick={() => onChooseRepo(repo)}>
                  <RepoRowIcon root={roots.get(repo.full_name)} isPrivate={repo.private} />
                  <div className="repo-info">
                    <Group gap="xs" wrap="nowrap">
                      <Text fw={650} truncate>{repo.name}</Text>
                    </Group>
                    <Text size="xs" c="dimmed" truncate>{repo.owner}</Text>
                  </div>
                  {isDownloaded ? <ChevronRight size={18} /> : <Download size={18} />}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <Center className="empty-state">
                <Text c="dimmed">No repositories match “{query}”.</Text>
              </Center>
            )}
          </div>
        </ScrollArea>
      )}
    </main>
  );
}

function Cloning({ repo, progress }: { repo: GitHubRepo | null; progress: CloneProgress }) {
  const checkingOut = progress.phase === "checking_out";
  const percent = checkingOut
    ? progress.checkout_total
      ? Math.min(100, Math.round((progress.checkout_completed / progress.checkout_total) * 100))
      : 4
    : progress.total_objects
      ? Math.min(100, Math.round((progress.received_objects / progress.total_objects) * 100))
      : 4;
  const megabytes = progress.received_bytes / 1_048_576;

  return (
    <main className="centered-screen">
      <Stack gap="xl" w="100%" maw={380}>
        <ThemeIcon size={56} radius="sm" variant="light" mx="auto">
          <Download size={30} />
        </ThemeIcon>
        <div>
          <Title order={2} ta="center">{repo?.name ?? "Repository"}</Title>
          <Text c="dimmed" ta="center" mt={8}>
            {checkingOut ? "Preparing downloaded files…" : "Downloading the latest repository snapshot…"}
          </Text>
        </div>
        <div>
          <Group justify="space-between" mb={8}>
            <Text size="sm" fw={600}>{percent}%</Text>
            <Text size="xs" c="dimmed">
              {checkingOut
                ? progress.checkout_total
                  ? `${progress.checkout_completed} of ${progress.checkout_total} files`
                  : "Preparing files"
                : megabytes >= 0.1
                  ? `${megabytes.toFixed(1)} MB`
                  : `${progress.received_objects} objects`}
            </Text>
          </Group>
          <Progress value={percent} size="lg" radius="xl" animated />
        </div>
        <Text size="xs" c="dimmed" ta="center">
          Keep Posto open until the repository is ready. Large media libraries may take several minutes.
        </Text>
      </Stack>
    </main>
  );
}

function CloneError({
  repo,
  error,
  onRetry,
  onCancel,
}: {
  repo: GitHubRepo | null;
  error: string | null;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <main className="centered-screen">
      <Stack gap="md" w="100%" maw={420}>
        <div>
          <Title order={2}>Download interrupted</Title>
          <Text c="dimmed" size="sm" mt={4}>{repo?.full_name ?? "Repository"}</Text>
        </div>
        <Alert color="red" title="The repository was not added">
          {error ?? "The download could not be completed."}
        </Alert>
        <Text size="sm" c="dimmed">
          Large repositories need enough free space for both Git data and checked-out files. Keep
          the app open on a stable connection while retrying.
        </Text>
        <Group grow>
          <Button variant="default" onClick={onCancel}>Choose another</Button>
          <Button leftSection={<RotateCcw size={16} />} onClick={onRetry}>Try again</Button>
        </Group>
      </Stack>
    </main>
  );
}

export default function Onboarding(props: Props) {
  function redownloadSelectedRepo() {
    if (!props.selectedRepo || !props.readyRoot) return Promise.resolve();
    return props.onRedownloadRepo(props.selectedRepo, props.readyRoot);
  }

  return (
    <div className="mobile-app">
      {props.stage !== "home" && (
        <Header stage={props.stage} user={props.user} onSignOut={props.onSignOut} />
      )}
      {props.stage === "loading" && <Center className="screen"><Loader /></Center>}
      {props.stage === "signed-out" && <SignIn onSignIn={props.onSignIn} />}
      {props.stage === "authorizing" && (
        <Authorizing device={props.device} onOpenVerification={props.onOpenVerification} />
      )}
      {props.stage === "repos-loading" && <Center className="screen"><Loader /></Center>}
      {props.stage === "repos" && <RepoPicker {...props} />}
      {props.stage === "cloning" && <Cloning repo={props.selectedRepo} progress={props.progress} />}
      {props.stage === "clone-error" && (
        <CloneError
          repo={props.selectedRepo}
          error={props.error}
          onRetry={props.onRetryClone}
          onCancel={props.onCancelClone}
        />
      )}
      {props.stage === "home" && props.readyRoot && (
        <RepoHome
          root={props.readyRoot}
          repo={props.selectedRepo}
          onChangeRepo={props.onChangeRepo}
          onRedownloadRepo={redownloadSelectedRepo}
          onRemoveRepo={() => props.onRemoveRepo(props.readyRoot!)}
        />
      )}
      {props.stage !== "repos" && props.stage !== "clone-error" && (
        <div className="floating-error"><ErrorNotice error={props.error} /></div>
      )}
    </div>
  );
}
