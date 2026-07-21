---
title: Publishing a site
description: How publishing commits and pushes changes, and how pulling updates works.
---

Posto stores changes with Git. Publishing commits and pushes your edits; pulling brings in changes made elsewhere. You don't run Git commands directly.

## Publishing changes

When there are uncommitted changes, the **Publish** button is enabled. It opens a view listing the changed files and a field for a commit message. Publishing commits those changes and pushes them to the site's repository. Pushing to the default branch typically triggers the host's deploy.

Individual changes can be reverted from the same view before publishing.

Pushing uses the credentials the repository already has: on desktop, whatever `git push` from a terminal would use; on mobile, the GitHub sign-in used to clone the site.

:::caution[Publishing goes directly to the default branch] Publishing commits and pushes straight to the repository's default branch (usually `main`). There is no draft branch or review step — once the host finishes deploying, the change is live. :::

## Pulling in updates

When the repository has changed elsewhere — another person published, or you edited from another device — Posto detects that the local copy is behind its upstream and shows a **Fetch Changes** / **Pull** action.

Pulling updates the local copy to match the latest published version and refreshes the file list and the open file. Pull before editing so your changes apply on top of the current state of the repository rather than an older one.
