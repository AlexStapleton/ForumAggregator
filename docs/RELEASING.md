# Releasing

How to cut a version (e.g. 1.1.0). Images are built by CI: `latest` from `main`, and
`X.Y.Z` / `X.Y` / `X` when a `vX.Y.Z` tag is pushed (`.github/workflows/ci.yml`).

## Steps

1. **In the release PR, before tagging:**
   - Bump all packages (keeps `package-lock.json` in step):
     `npm version X.Y.Z --no-git-tag-version --workspaces --include-workspace-root=false`
   - `CHANGELOG.md`: rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD` and add a fresh empty `[Unreleased]`.
   - `README.md`: "Current release: **X.Y.Z**".
   - Check: `npm run build && npm test`, and that
     `node -e "import('./packages/server/dist/version.js').then(m => console.log(m.VERSION))"` prints X.Y.Z.
2. **Merge the PR** into `main`.
3. **Create the release on GitHub:** Releases → Draft a new release → tag `vX.Y.Z` on `main`,
   title `vX.Y.Z`, notes from the changelog section. Publishing it pushes the tag, and CI
   publishes the versioned images. Make sure the tag goes on the **merge commit** of the release
   PR ("Target: main" after merging), not an earlier commit: `v1.13.0` went on 1.12.0's (D-125).
4. **Check** that Docker Hub shows `alexstapo/forumaggregator:X.Y.Z` and that
   `/api/version` on the updated install reports X.Y.Z.

## Which number

- **Patch** (1.1.**1**): fixes only.
- **Minor** (1.**2**.0): new features, nothing you have to change.
- **Major** (**2**.0.0): you have to do something when upgrading (config, data, ports).

Note: v1.0.1 was tagged without step 1, so that image reports 1.0.0.
