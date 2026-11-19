// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CdnSource } from "@posto/core/media/sources";
import { invoke, listMediaObjects, saveMediaCredential } from "@posto/ipc";
import { ImagePicker } from "../src/components/ImagePicker";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

let saved = true;
vi.mock("@posto/ipc", () => ({
  invoke: vi.fn(),
  listMediaObjects: vi.fn(),
  openPath: vi.fn(),
  saveMediaCredential: vi.fn(),
  thumbnailUrl: vi.fn().mockResolvedValue(null),
}));

const source: CdnSource = {
  name: "cdn",
  label: "Media CDN",
  provider: "bunny",
  bucket: "site-media",
  prefix: "images",
  publicUrl: "https://media.example.com",
};

beforeEach(() => {
  saved = true;
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command) => {
      if (command === "media_credential_exists") return saved;
      if (command === "list_dir_files_optional") return null;
      throw new Error(`Unexpected command: ${command}`);
    });
  vi.mocked(listMediaObjects)
    .mockReset()
    .mockImplementation(async (_source, prefix) =>
      prefix === "images"
        ? {
            objects: [
              { key: "images/harbor-1a2b3c4d.jpg", size: 1, sha256: null },
              { key: "images/notes.pdf", size: 1, sha256: null },
            ],
            directories: ["images/trips"],
          }
        : {
            objects: [{ key: "images/trips/dock-5e6f7a8b.jpg", size: 1, sha256: null }],
            directories: [],
          },
    );
  vi.mocked(saveMediaCredential)
    .mockReset()
    .mockImplementation(async (_source, credential) => {
      if (credential.secret !== "right") throw new Error("Storage rejected the saved credentials.");
      saved = true;
    });
});

afterEach(cleanup);

function picker(onPick = vi.fn()) {
  render(
    <MantineProvider forceColorScheme="light">
      <ImagePicker
        root="/repo"
        media={{ name: "cdn", input: "public/uploads", output: "/uploads" }}
        cdnSource={source}
        onClose={vi.fn()}
        onPick={onPick}
      />
    </MantineProvider>,
  );
  return onPick;
}

test("lists CDN images, opens folders, and picks by public URL", async () => {
  const onPick = picker();

  expect(await screen.findByText("harbor-1a2b3c4d.jpg")).toBeTruthy();
  expect(screen.queryByText("notes.pdf")).toBeNull();
  expect(screen.queryByText("No images in public/uploads")).toBeNull();

  fireEvent.click(screen.getByText("trips").closest("button")!);
  fireEvent.click((await screen.findByText("dock-5e6f7a8b.jpg")).closest("button")!);
  expect(onPick).toHaveBeenCalledWith("https://media.example.com/images/trips/dock-5e6f7a8b.jpg");
  expect(listMediaObjects).toHaveBeenLastCalledWith(source, "images/trips");
});

test("asks for the storage password before browsing", async () => {
  saved = false;
  picker();

  const password = await screen.findByLabelText("Storage zone password");
  fireEvent.change(password, { target: { value: "wrong" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and browse" }));
  expect(await screen.findByText("Storage rejected the saved credentials.")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Storage zone password"), { target: { value: "right" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and browse" }));
  await waitFor(() => expect(screen.getByText("harbor-1a2b3c4d.jpg")).toBeTruthy());
  expect(saveMediaCredential).toHaveBeenLastCalledWith(source, { secret: "right" }, "images");
});

test("browsing can be skipped without a password", async () => {
  saved = false;
  picker();

  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

  expect(screen.getByText(/appear here once this device has its storage password/)).toBeTruthy();
  expect(listMediaObjects).not.toHaveBeenCalled();
});
