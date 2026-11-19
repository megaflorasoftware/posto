---
title: Publishing a site
description: Review and publish local changes, pull remote updates, and understand how Posto scopes Git operations.
---

Posto uses Git to publish local edits and pull changes made elsewhere. You do not need to run Git commands directly.

## Publishing changes

When there are unpublished changes in the selected site, **Publish** opens a review showing each added, changed, renamed, or deleted file. Enter a commit message, then publish to commit and push those changes. Pushing to the default branch typically starts the host's deployment.

You can revert an individual file from the review. Reverting a new file deletes it, so Posto asks for confirmation first.

On desktop, Posto uses the credentials that the repository would use for `git push`. On mobile, it uses the GitHub account that cloned the repository.

In a repository with several projects, the review and commit include only changes under the selected project directory. Unrelated changes elsewhere in the repository remain unpublished.

:::caution[Publishing goes directly to the default branch] Publishing commits and pushes straight to the repository's default branch (usually `main`). There is no draft branch or review step — once the host finishes deploying, the change is live. :::

## Publishing CDN images

When a site stores images on a [CDN](/frameworks/cdn-media/), the review also lists how many images will upload or be deleted, and a progress bar tracks the upload. The list of changed files shows what the commit will contain, after uploaded images leave the repository and content points at their CDN URLs. The first time this device publishes to a CDN, Posto asks for the storage password and saves it in the device's keychain.

The review stays open while publishing and shows each step. If anything fails, your changes are left exactly as they were, ready to publish again. If Posto quits partway through, it finishes or undoes that publish the next time you open the project.

## Pulling in updates

When the upstream branch has new commits—because another person published or you edited from another device—Posto replaces **Publish** with **Fetch Changes** on desktop and shows a **Pull** action on mobile.

Pulling updates the local repository, then refreshes project detection, the file list, schemas, and the open file. Posto preserves local edits around the update when it can. A pull is blocked if unpublished changes outside the selected project conflict with incoming changes; resolve those repository changes with Git before trying again.

Pull before starting a new edit so your work begins from the latest published version.
