# Changelog

## 0.2.0

- Discover the local T3 Code environment and every environment linked through T3 Connect.
- Route project and thread operations automatically to their owning environment.
- Add short-lived DPoP authorization for relay and remote-environment requests.
- Reuse the signed-in T3 Code desktop session through Linux keyring, macOS Keychain, or Windows
  DPAPI without publishing credentials.
- Add `list_environments` and environment labels to project and thread results.
- Add natural-language target-resolution guidance with exact-match preference and safe
  disambiguation.
- Use a portable per-user local-token path on Linux, macOS, and Windows.

## 0.1.0

- Initial standalone bridge for one local T3 Code environment.
