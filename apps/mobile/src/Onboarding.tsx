import {
  ActionIcon,
  Avatar,
  Badge,
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
  Search,
  Smartphone,
} from "lucide-react";
import { useMemo, useState } from "react";

type Stage = "loading" | "signed-out" | "authorizing" | "repos" | "cloning" | "ready";

type Props = {
  stage: Stage;
  user: GitHubUser | null;
  device: DeviceAuthorization | null;
  repos: GitHubRepo[];
  downloaded: Set<string>;
  selectedRepo: GitHubRepo | null;
  readyRoot: string | null;
  progress: CloneProgress;
  error: string | null;
  onSignIn: () => void;
  onSignOut: () => void;
  onOpenVerification: () => void;
  onChooseRepo: (repo: GitHubRepo) => void;
  onRetryRepos: () => void;
};

function Header({ user, onSignOut }: Pick<Props, "user" | "onSignOut">) {
  return (
    <header className="mobile-header">
      <div className="wordmark" aria-label="Posto">
        <span>P</span>
        <strong>posto</strong>
      </div>
      {user && (
        <Group gap="xs" wrap="nowrap">
          <Avatar src={user.avatar_url} alt={user.name} size={30} radius="xl" />
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
    <main className="welcome-screen">
      <div className="welcome-art" aria-hidden="true">
        <div className="paper paper-back" />
        <div className="paper paper-front">
          <span />
          <span />
          <span />
          <i>P</i>
        </div>
      </div>
      <Stack gap="md" align="center" className="welcome-copy">
        <Text className="eyebrow">Your site, in your pocket</Text>
        <Title order={1}>Write wherever the idea finds you.</Title>
        <Text c="dimmed" ta="center" maw={330}>
          Connect GitHub to edit and publish your site without bringing a laptop.
        </Text>
      </Stack>
      <Stack gap="sm" className="welcome-actions">
        <Button size="lg" radius="xl" leftSection={<FolderGit2 size={20} />} onClick={onSignIn}>
          Continue with GitHub
        </Button>
        <Group gap={6} justify="center" c="dimmed">
          <LockKeyhole size={13} />
          <Text size="xs">Your token stays in this device's secure storage</Text>
        </Group>
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
          <Loader color="violet" />
          <div>
            <Title order={2} ta="center">Connecting to GitHub</Title>
            <Text c="dimmed" ta="center" mt={6}>Requesting a one-time sign-in code…</Text>
          </div>
        </Stack>
      ) : (
        <Stack gap="xl" w="100%" maw={380}>
          <ThemeIcon size={58} radius="xl" variant="light" mx="auto">
            <Smartphone size={27} />
          </ThemeIcon>
          <div>
            <Text className="eyebrow" ta="center">One quick step</Text>
            <Title order={2} ta="center" mt={6}>Enter this code on GitHub</Title>
          </div>
          <button className="device-code" onClick={() => void copyCode()}>
            <span>{device.user_code}</span>
            {copied ? <Check size={20} /> : <Copy size={20} />}
          </button>
          <Button
            size="lg"
            radius="xl"
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

function RepoPicker({ repos, downloaded, error, onChooseRepo, onRetryRepos }: Props) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? repos.filter((repo) => repo.full_name.toLowerCase().includes(normalized))
      : repos;
  }, [query, repos]);

  return (
    <main className="repo-screen">
      <div className="screen-title">
        <Text className="eyebrow">Choose a site</Text>
        <Title order={1}>Your repositories</Title>
        <Text c="dimmed" mt={6}>Pick the site you want available on this device.</Text>
      </div>
      <TextInput
        size="md"
        radius="xl"
        leftSection={<Search size={18} />}
        placeholder="Search repositories"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        aria-label="Search repositories"
      />
      <ErrorNotice error={error} />
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
          <Stack gap="xs">
            {filtered.map((repo) => {
              const isDownloaded = downloaded.has(repo.full_name);
              return (
                <button className="repo-row" key={repo.id} onClick={() => onChooseRepo(repo)}>
                  <ThemeIcon variant="light" color={repo.private ? "grape" : "gray"} radius="md">
                    {repo.private ? <LockKeyhole size={17} /> : <FolderGit2 size={17} />}
                  </ThemeIcon>
                  <div className="repo-info">
                    <Group gap="xs" wrap="nowrap">
                      <Text fw={650} truncate>{repo.name}</Text>
                      {repo.private && <Badge size="xs" variant="light">Private</Badge>}
                    </Group>
                    <Text size="xs" c="dimmed" truncate>{repo.owner}</Text>
                  </div>
                  {isDownloaded ? <Badge variant="dot">On device</Badge> : <ChevronRight size={18} />}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <Center className="empty-state">
                <Text c="dimmed">No repositories match “{query}”.</Text>
              </Center>
            )}
          </Stack>
        </ScrollArea>
      )}
    </main>
  );
}

function Cloning({ repo, progress }: { repo: GitHubRepo | null; progress: CloneProgress }) {
  const percent = progress.total_objects
    ? Math.min(100, Math.round((progress.received_objects / progress.total_objects) * 100))
    : 4;
  const megabytes = progress.received_bytes / 1_048_576;

  return (
    <main className="centered-screen">
      <Stack gap="xl" w="100%" maw={380}>
        <ThemeIcon size={62} radius="xl" variant="light" mx="auto">
          <Download size={28} />
        </ThemeIcon>
        <div>
          <Text className="eyebrow" ta="center">Making it available offline</Text>
          <Title order={2} ta="center" mt={6}>{repo?.name ?? "Repository"}</Title>
          <Text c="dimmed" ta="center" mt={8}>Downloading files and commit history…</Text>
        </div>
        <div>
          <Group justify="space-between" mb={8}>
            <Text size="sm" fw={600}>{percent}%</Text>
            <Text size="xs" c="dimmed">
              {megabytes >= 0.1 ? `${megabytes.toFixed(1)} MB` : `${progress.received_objects} objects`}
            </Text>
          </Group>
          <Progress value={percent} size="md" radius="xl" animated />
        </div>
        <Text size="xs" c="dimmed" ta="center">Keep Posto open until the download finishes.</Text>
      </Stack>
    </main>
  );
}

function Ready({ repo, root }: { repo: GitHubRepo | null; root: string | null }) {
  return (
    <main className="centered-screen">
      <Stack gap="xl" align="center" maw={380}>
        <div className="success-mark"><Check size={34} /></div>
        <div>
          <Text className="eyebrow" ta="center">Ready to write</Text>
          <Title order={2} ta="center" mt={6}>{repo?.name ?? "Your site"} is on this device.</Title>
          <Text c="dimmed" ta="center" mt={10}>
            The repository is ready. The file browser and editor arrive in the next mobile milestone.
          </Text>
        </div>
        {root && <Text size="xs" c="dimmed" className="root-path">{root}</Text>}
      </Stack>
    </main>
  );
}

export default function Onboarding(props: Props) {
  return (
    <div className="mobile-app">
      <Header user={props.user} onSignOut={props.onSignOut} />
      {props.stage === "loading" && <Center className="screen"><Loader color="violet" /></Center>}
      {props.stage === "signed-out" && <SignIn onSignIn={props.onSignIn} />}
      {props.stage === "authorizing" && (
        <Authorizing device={props.device} onOpenVerification={props.onOpenVerification} />
      )}
      {props.stage === "repos" && <RepoPicker {...props} />}
      {props.stage === "cloning" && <Cloning repo={props.selectedRepo} progress={props.progress} />}
      {props.stage === "ready" && <Ready repo={props.selectedRepo} root={props.readyRoot} />}
      {props.stage !== "repos" && <div className="floating-error"><ErrorNotice error={props.error} /></div>}
    </div>
  );
}
