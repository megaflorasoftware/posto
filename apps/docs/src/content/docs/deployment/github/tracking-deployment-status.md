---
title: Tracking deployment status
description: How Posto shows GitHub Actions deployment status for a site.
---

When a site deploys through [GitHub Actions](https://docs.github.com/en/actions), Posto shows the status of the latest run so you can see whether a publish has finished deploying.

## The deployment indicator

The header shows a deployment indicator for the current site. Once Posto knows the repository's recent runs, it becomes a progress ring reflecting the workflow run on the default branch:

- **Queued** — a run is waiting to start.
- **Running** — a run is in progress; the ring fills as it advances.
- **Success** — the last run completed successfully.
- **Failure** — the last run failed.

The status is polled periodically, and refreshed shortly after you publish so a newly triggered run appears without waiting for the next poll.

Opening the indicator shows the deployment drawer (desktop) or the Deployments screen (mobile), which links out to the repository's Actions page on GitHub.

## Requirements

- The site's repository is hosted on GitHub.
- Deployment runs through **GitHub Actions** on the default branch. The ring tracks that branch's workflow runs; deploys that don't run as GitHub Actions won't appear.
- Posto is signed in to GitHub, which it uses to read workflow-run status. On the mobile app this is the same sign-in used to browse and clone repositories; on desktop it is used only for deployment status.
