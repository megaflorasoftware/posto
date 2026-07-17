import { MantineProvider } from "@mantine/core";
import {
  invoke,
  onAuthDeviceCode,
  onCloneProgress,
  openUrl,
} from "@posto/ipc";
import type {
  AuthStatus,
  CloneProgress,
  DeviceAuthorization,
  GitHubRepo,
  GitHubUser,
  ManagedRepo,
} from "@posto/ipc";
import { useCallback, useEffect, useMemo, useState } from "react";
import Onboarding from "./Onboarding";

type Stage = "loading" | "signed-out" | "authorizing" | "repos" | "cloning" | "ready";

const emptyProgress: CloneProgress = {
  received_objects: 0,
  total_objects: 0,
  indexed_objects: 0,
  received_bytes: 0,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function App() {
  const [stage, setStage] = useState<Stage>("loading");
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [device, setDevice] = useState<DeviceAuthorization | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [managed, setManaged] = useState<ManagedRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [readyRoot, setReadyRoot] = useState<string | null>(null);
  const [progress, setProgress] = useState<CloneProgress>(emptyProgress);
  const [error, setError] = useState<string | null>(null);

  const loadRepos = useCallback(async () => {
    setError(null);
    setStage("repos");
    try {
      const [available, downloaded] = await Promise.all([
        invoke<GitHubRepo[]>("list_user_repos"),
        invoke<ManagedRepo[]>("list_repos"),
      ]);
      setRepos(available);
      setManaged(downloaded);
    } catch (loadError) {
      setError(message(loadError));
    }
  }, []);

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
    }
  }

  async function signOut() {
    setError(null);
    try {
      await invoke("sign_out");
      setUser(null);
      setRepos([]);
      setManaged([]);
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
      await invoke("set_last_root", { root: existing.root });
      setReadyRoot(existing.root);
      setStage("ready");
      return;
    }
    setProgress(emptyProgress);
    setStage("cloning");
    try {
      const root = await invoke<string>("clone_repo", { url: repo.clone_url });
      await invoke("set_last_root", { root });
      setReadyRoot(root);
      setManaged((current) => [
        ...current,
        { owner: repo.owner, name: repo.name, root, url: repo.clone_url },
      ]);
      setStage("ready");
    } catch (cloneError) {
      setError(message(cloneError));
      setStage("repos");
    }
  }

  const downloaded = useMemo(
    () => new Set(managed.map((repo) => `${repo.owner}/${repo.name}`)),
    [managed],
  );

  return (
    <MantineProvider
      defaultColorScheme="auto"
      theme={{
        primaryColor: "violet",
        fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif",
        headings: { fontFamily: "Georgia, ui-serif, serif" },
      }}
    >
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
        onOpenVerification={() => device && void openUrl(device.verification_uri)}
        onChooseRepo={(repo) => void chooseRepo(repo)}
        onRetryRepos={() => void loadRepos()}
      />
    </MantineProvider>
  );
}
