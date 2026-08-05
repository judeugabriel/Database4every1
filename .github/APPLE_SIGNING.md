# Apple signing and notarization

macOS release artifacts must be signed with a **Developer ID Application**
certificate and notarized by Apple. Ad-hoc signing (`-`) is intentionally not
used because Gatekeeper still reports those downloads as unverified.

This requires a paid Apple Developer Program membership. Add these encrypted
repository or environment secrets in **GitHub → Settings → Secrets and
variables → Actions**:

- `APPLE_CERTIFICATE`: base64 representation of the exported Developer ID
  Application `.p12` certificate, including its private key.
- `APPLE_CERTIFICATE_PASSWORD`: password chosen while exporting the `.p12`.
- `KEYCHAIN_PASSWORD`: a strong temporary password used for the CI keychain.
- `APPLE_ID`: Apple ID email belonging to the developer team.
- `APPLE_PASSWORD`: an app-specific password generated at
  `appleid.apple.com`, not the normal Apple ID password.
- `APPLE_TEAM_ID`: the 10-character team identifier from the Apple Developer
  membership page.

Export the certificate from **Keychain Access → My Certificates** and encode it:

```sh
openssl base64 -A -in DeveloperIDApplication.p12 -out certificate-base64.txt
```

Copy the complete contents of `certificate-base64.txt` into
`APPLE_CERTIFICATE`. Never commit the `.p12`, its password, or that encoded
text to the repository.

During a release, the workflow imports the certificate into an ephemeral
keychain. Tauri then signs the application, submits it to Apple's notary
service, staples the notarization ticket, and builds the DMG. The workflow
finally verifies the signature, Gatekeeper assessment, and stapled tickets.
It fails instead of publishing an ad-hoc-signed macOS installer when secrets
are missing or verification fails.
