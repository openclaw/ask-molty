# Releasing Ask Molty

Ask Molty is a private npm project deployed as a Cloudflare Worker. Numbered
releases publish a signed Git tag and GitHub Release; they do not publish an npm
package or attach a copy of the generated workspace.

The existing `workspace-latest` release serves the GitHub search index used by
the Worker. Keep that tag, release, asset, and its runtime URLs unchanged when
publishing a numbered release. Worker deployment remains a separate operation.

1. Start from clean, current `main`. Update `package.json` and the root package
   versions in `package-lock.json`.
2. Finalize `CHANGELOG.md` under `## <version> - YYYY-MM-DD`, preserving entries,
   contributor credits, and the Highlights line.
3. Run `npm ci`, `npm run build`, and `npm run check`. The export and smoke checks
   require a docs mirror, OpenClaw source checkout, and Gitcrawl database; override
   the paths as described in README, or use the fixture schema from
   `.github/workflows/ci.yml`.
4. Review the release changes, merge the release PR with squash, and wait for CI
   to pass on the exact merged commit.
5. Confirm that neither the local/remote tag nor a GitHub Release already exists
   for `v<version>`. Create and verify a signed tag on that commit, then push it:

   ```bash
   git tag -s "v<version>" <release-commit> -m "Ask Molty <version>"
   git verify-tag "v<version>"
   git push origin "refs/tags/v<version>"
   ```

6. Write the finalized changelog section, beginning with Highlights and omitting
   the version heading, to a notes file. Publish it with:

   ```bash
   gh release create "v<version>" --verify-tag --title "Ask Molty <version>" --notes-file <notes-file>
   ```

7. Read back the GitHub Release and verify the tag resolves to the tested commit.
   Check any triggered workflows and verify that
   `https://docs.openclaw.ai/ask-molty/api/session` still answers. An unauthenticated
   request returns HTTP 401 with `{"authenticated":false,"provider":null}`.
8. Add an empty `## Unreleased` above the released section and land it through a
   reviewed PR. Leave the checkout clean on `main` at `origin/main`.
