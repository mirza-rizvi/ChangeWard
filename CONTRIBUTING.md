# Contributing to ChangeWard

## Reporting problems

- **Bugs:** open an issue using the **Bug report** form.
- **False positives:** if ChangeWard flagged something harmless, rated it too high, or blocked a publish it shouldn't have, use the **False positive or misleading wording** form.
- **Security problems:** do not open a public issue. Report them privately as described in [SECURITY.md](SECURITY.md).

Please don't paste private page content, user emails or secrets into issues.

## Making changes

1. Fork the repository and create a branch from `dev`.
2. Set up and run the checks:

   ```sh
   pnpm install
   pnpm run typecheck
   pnpm test
   pnpm run bundle
   ```

3. Add or update tests for any change in behaviour.
4. Add a line under the next version in [CHANGELOG.md](CHANGELOG.md).
5. Open a pull request into `dev`. CI must pass before it can be merged.

## Things to keep in mind

- **Permissions:** don't add a capability or network host to `emdash-plugin.jsonc` without explaining why in [docs/CAPABILITIES.md](docs/CAPABILITIES.md). Installed sites have to approve every new permission.
- **Stored data:** ChangeWard stores summaries of changes, not page content. Keep it that way; see [docs/PRIVACY.md](docs/PRIVACY.md).
- **Wording:** describe what changed, for example "new link to an unknown website". Don't claim intent, like "malicious" or "attack".
- **Limits:** each hook runs inside EmDash's plugin sandbox, which allows at most 10 host calls per run. The tests check that every path stays within 9.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
