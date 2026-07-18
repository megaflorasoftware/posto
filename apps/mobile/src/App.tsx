import { createTheme, MantineProvider } from "@mantine/core";
import { DialogVariantProvider } from "@posto/editor";
import {
  closeInAppBrowser,
  invoke,
  onAuthDeviceCode,
  onCloneProgress,
  openUrlInApp,
} from "@posto/ipc";
import type {
  AuthStatus,
  CloneProgress,
  DeviceAuthorization,
  GitHubRepo,
  GitHubUser,
  ManagedRepo,
} from "@posto/ipc";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import Onboarding from "./Onboarding";

type Stage =
  | "loading"
  | "signed-out"
  | "authorizing"
  | "repos"
  | "cloning"
  | "clone-error"
  | "home";

const emptyProgress: CloneProgress = {
  received_objects: 0,
  total_objects: 0,
  indexed_objects: 0,
  received_bytes: 0,
  checkout_completed: 0,
  checkout_total: 0,
  phase: "downloading",
};

const REPOSITORY_CACHE_KEY = "posto.mobile.repositories.v1";

type RepositoryCache = {
  repos: GitHubRepo[];
  managed: ManagedRepo[];
};

function readRepositoryCache(): RepositoryCache {
  try {
    const cached = JSON.parse(
      localStorage.getItem(REPOSITORY_CACHE_KEY) ?? "null",
    ) as Partial<RepositoryCache> | null;
    return {
      repos: Array.isArray(cached?.repos) ? cached.repos : [],
      managed: Array.isArray(cached?.managed) ? cached.managed : [],
    };
  } catch {
    return { repos: [], managed: [] };
  }
}

function writeRepositoryCache(cache: RepositoryCache) {
  try {
    localStorage.setItem(REPOSITORY_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Repository refresh still works when persistent web storage is unavailable.
  }
}

function clearRepositoryCache() {
  try {
    localStorage.removeItem(REPOSITORY_CACHE_KEY);
  } catch {
    // Nothing else is required for sign-out; in-memory state is cleared below.
  }
}

const mobileTheme = createTheme({
  components: {
    ActionIcon: { defaultProps: { size: "lg" } },
    Button: { defaultProps: { size: "md" } },
    TextInput: { defaultProps: { size: "lg" } },
    ThemeIcon: { defaultProps: { size: "lg" } },
  },
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function App() {
  const cachedRepositories = useMemo(readRepositoryCache, []);
  const [stage, setStage] = useState<Stage>("loading");
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [device, setDevice] = useState<DeviceAuthorization | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>(cachedRepositories.repos);
  const [managed, setManaged] = useState<ManagedRepo[]>(cachedRepositories.managed);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [readyRoot, setReadyRoot] = useState<string | null>(null);
  const [progress, setProgress] = useState<CloneProgress>(emptyProgress);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    let frame = 0;

    const updateViewport = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        root.style.setProperty(
          "--mobile-viewport-height",
          `${viewport?.height ?? window.innerHeight}px`,
        );
        root.style.setProperty(
          "--mobile-viewport-offset-top",
          `${viewport?.offsetTop ?? 0}px`,
        );
      });
    };

    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);

    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      root.style.removeProperty("--mobile-viewport-height");
      root.style.removeProperty("--mobile-viewport-offset-top");
    };
  }, []);

  const loadRepos = useCallback(async () => {
    setError(null);
    setStage("repos");
    const [available, downloaded] = await Promise.allSettled([
      invoke<GitHubRepo[]>("list_user_repos"),
      invoke<ManagedRepo[]>("list_repos"),
    ]);
    if (available.status === "fulfilled") setRepos(available.value);
    if (downloaded.status === "fulfilled") setManaged(downloaded.value);
    if (available.status === "rejected") {
      setError(message(available.reason));
    } else if (downloaded.status === "rejected") {
      setError(message(downloaded.reason));
    }
  }, []);

  useEffect(() => {
    writeRepositoryCache({ repos, managed });
  }, [managed, repos]);

  useEffect(() => {
    const stopDevice = onAuthDeviceCode(setDevice);
    const stopProgress = onCloneProgress(setProgress);
    void invoke<AuthStatus>("auth_status")
      .then((status) => {
        setUser(status.user);
        if (status.signed_in) return loadRepos();
        setStage("signed-out");
      })
      .catch((statusError) => {
        setError(message(statusError));
        setStage("signed-out");
      });
    return () => {
      stopDevice();
      stopProgress();
    };
  }, [loadRepos]);

  async function signIn() {
    setError(null);
    setDevice(null);
    setStage("authorizing");
    try {
      const signedInUser = await invoke<GitHubUser>("sign_in");
      setUser(signedInUser);
      await loadRepos();
    } catch (signInError) {
      setError(message(signInError));
      setStage("signed-out");
    } finally {
      // The device-flow page may still be presented over the app.
      void closeInAppBrowser();
    }
  }

  async function signOut() {
    setError(null);
    try {
      await invoke("sign_out");
      setUser(null);
      setRepos([]);
      setManaged([]);
      clearRepositoryCache();
      setStage("signed-out");
    } catch (signOutError) {
      setError(message(signOutError));
    }
  }

  async function chooseRepo(repo: GitHubRepo) {
    setError(null);
    setSelectedRepo(repo);
    const existing = managed.find(
      (candidate) => candidate.owner === repo.owner && candidate.name === repo.name,
    );
    if (existing) {
      setReadyRoot(existing.root);
      setStage("home");
      void invoke("set_last_root", { root: existing.root }).catch((rememberError) => {
        setError(`Repository opened, but it could not be remembered: ${message(rememberError)}`);
      });
      return;
    }
    await downloadRepo(repo);
  }

  async function downloadRepo(repo: GitHubRepo) {
    setProgress(emptyProgress);
    setStage("cloning");
    try {
      const root = await invoke<string>("clone_repo", { url: repo.clone_url });
      setReadyRoot(root);
      setManaged((current) => [
        ...current,
        { owner: repo.owner, name: repo.name, root, url: repo.clone_url },
      ]);
      setStage("home");
      void invoke("set_last_root", { root }).catch((rememberError) => {
        setError(`Repository opened, but it could not be remembered: ${message(rememberError)}`);
      });
    } catch (cloneError) {
      setError(message(cloneError));
      setStage("clone-error");
    }
  }

  async function redownloadRepo(repo: GitHubRepo, root: string) {
    await invoke("remove_repo", { root });
    setManaged((current) => current.filter((candidate) => candidate.root !== root));
    setReadyRoot(null);
    await downloadRepo(repo);
  }

  const downloaded = useMemo(
    () => new Set(managed.map((repo) => `${repo.owner}/${repo.name}`)),
    [managed],
  );

  return (
    <MantineProvider defaultColorScheme="auto" theme={mobileTheme}>
      <DialogVariantProvider variant="drawer">
      <Onboarding
        stage={stage}
        user={user}
        device={device}
        repos={repos}
        downloaded={downloaded}
        selectedRepo={selectedRepo}
        readyRoot={readyRoot}
        progress={progress}
        error={error}
        onSignIn={() => void signIn()}
        onSignOut={() => void signOut()}
        onOpenVerification={() => device && void openUrlInApp(device.verification_uri)}
        onChooseRepo={(repo) => void chooseRepo(repo)}
        onRetryRepos={() => void loadRepos()}
        onRetryClone={() => selectedRepo && void chooseRepo(selectedRepo)}
        onCancelClone={() => {
          setError(null);
          setStage("repos");
        }}
        onRedownloadRepo={(repo, root) => redownloadRepo(repo, root)}
        onChangeRepo={() => setStage("repos")}
      />
      </DialogVariantProvider>
    </MantineProvider>
  );
}
