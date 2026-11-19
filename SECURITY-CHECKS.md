# Secret scanning

Install Gitleaks (`brew install gitleaks`) and enable the tracked hooks in each clone:

```sh
git config core.hooksPath .githooks
```

The commit hook scans staged changes. The push hook and GitHub Actions scan all
locally available history. Output is redacted. CI uses a version and checksum
pinned Gitleaks binary, read-only permissions, and no saved checkout credentials.
No app runtime dependencies or appearance changes are required.

Run manually: `gitleaks git --redact --no-banner --log-opts="--all" .`.
Treat a new finding as potentially compromised; revoke a live secret before
considering history cleanup. Do not add broad file or key-pattern exceptions.
Reviewed historical exceptions, if any, are exact commit/file/rule/line fingerprints
in `.gitleaksignore`; they do not exempt future occurrences.
