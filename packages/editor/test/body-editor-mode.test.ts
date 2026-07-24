// @vitest-environment jsdom

import { expect, test } from "vitest";
import { bodyEditorMode } from "../src/components/BodyEditor";
import { genericAdapter } from "@posto/core/project/generic";
import { astroAdapter } from "@posto/core/project/astro";

test("MDX preservation does not depend on component discovery", () => {
  expect(bodyEditorMode(true, genericAdapter.capabilities.componentBlocks)).toEqual({
    mdx: true,
    componentBlocksEnabled: false,
  });
  expect(bodyEditorMode(true, astroAdapter.capabilities.componentBlocks)).toEqual({
    mdx: true,
    componentBlocksEnabled: true,
  });
  expect(bodyEditorMode(false, astroAdapter.capabilities.componentBlocks)).toEqual({
    mdx: false,
    componentBlocksEnabled: true,
  });
});
