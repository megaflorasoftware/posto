---
title: Tracking deployment status
description: Connect GitHub, follow the latest Actions run on main, and open the deployed site from Posto.
next: false
---

When a site deploys through [GitHub Actions](https://docs.github.com/en/actions), Posto follows the latest workflow run on `main` so you can tell when a published change is live.

## The deployment indicator

The preview header shows a deployment indicator for the current site. After Posto loads the repository's recent runs, the indicator reflects the latest run on `main`:

- **Queued** — a run is waiting to start.
- **Running** — a run is in progress; the ring fills as it advances.
- **Success** — the last run completed successfully.
- **Failure** — the last run failed.

Posto checks the status periodically and refreshes shortly after publishing so a newly triggered run appears promptly.

Open the indicator to see deployment details. The desktop drawer and mobile **Deployments** screen link to the repository's Actions page. They also offer an **Open Site** action when Posto can read a live URL from the project or, as a fallback, from GitHub Pages.

If you are not signed in, choose **Continue with GitHub**, enter the one-time device code on GitHub, and approve access. Posto stores the session in the system credential store. If access to that stored credential was denied, the drawer offers **Approve GitHub Access** to retry.

## Requirements

- The selected site is inside a repository whose `origin` remote points to GitHub.
- Deployment runs through **GitHub Actions** on `main`. Runs on other branches and deployments that do not create an Actions workflow run do not appear.
- Posto is signed in to GitHub so it can read workflow status. Mobile uses the same sign-in for browsing and cloning repositories; desktop uses it for deployment status and the GitHub Pages URL fallback.
