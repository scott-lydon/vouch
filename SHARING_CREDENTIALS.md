# Sharing Credentials with Vouch

Audience: anyone running Vouch against a target project (Meridian, Boxy Fractions, OpenEMR, any future one) who needs to feed Vouch real wallet seeds, API tokens, file uploads, or other inputs that would fail a server side check if they were synthetic placeholders.

## Answer up front

Vouch consumes credentials through one file at the **target project's** root: `vouch.inputs.yaml`. Secret values are never written into the file as literals. Each entry that needs a secret references an environment variable by name with `value_from_env:` or `seed_from_env:`. Vouch resolves those env vars at run time, holds the resolved value in memory only, never persists it to the SQLite database, never sends it to the dashboard, never logs it.

**The same file format works whether Vouch runs locally on your Mac or as a deployed service.** What changes between modes is how the env vars get populated, not the manifest:

1. **Local Vouch (your Mac):** macOS login Keychain plus a 12 line shell wrapper, or `~/.zprofile`, or a `chmod 600` dotenv file.
2. **Deployed Vouch (Render, Fly, AWS, etc.):** the platform's own secret manager. Same env var names as you used locally.
3. **Hybrid that works identically in both modes:** 1Password Connect with a shell wrapper locally, the same Connect server referenced from the deployment.

You can start with option 1 today, migrate to option 2 when Vouch is deployed, and `vouch.inputs.yaml` never changes during the migration. That is the whole point of the indirection.

## The contract

Every Vouch target ships a `vouch.inputs.yaml` at the project root (next to `package.json` / `Cargo.toml` / `Anchor.toml`). Vouch reads it on every `init` and every `run`. Three sections, each optional:

```yaml
# vouch.inputs.yaml — checked into source control, contains zero secret values.

text:
  - name: api_token
    description: "Token Vouch sends as the Authorization header on /api/* probes."
    value_from_env: MERIDIAN_API_TOKEN    # populated outside the repo

  - name: customer_email
    description: "Real Stripe-verified email so the form passes server validation."
    value_from_env: VOUCH_REAL_EMAIL

files:
  - name: kyc_passport
    description: "Passport scan that passes the third-party KYC check."
    path: ./fixtures/private/passport.png  # gitignored, on disk, not committed
    mime: image/png

wallets:
  - name: solana_devnet_funded
    description: "Devnet wallet with ~5 SOL for placing test orders."
    chain: solana
    address: 7xK8a...                       # public, fine to commit
    seed_from_env: SOLANA_DEVNET_SEED       # private, NEVER committed
```

What Vouch does at load time:

1. Reads the file.
2. Refuses to start if any literal secret pattern is present anywhere in the file (the keys `seed`, `seed_phrase`, `mnemonic`, `private_key`, `secret`, `password`, `api_key` are forbidden at any depth, see `src/core/inputs.ts` for the full list).
3. Resolves every `*_from_env` reference against the environment Vouch was launched with. If any referenced env var is unset, Vouch fails before opening a browser, not on permutation 47.
4. Verifies every `files:` entry's `path` exists on disk.
5. Holds the resolved values in memory for the duration of the run. They never reach disk, the database, the dashboard JSON payload, or any log line.

Failing fast at load time is intentional: an operator who typo'd `MERIDIAM_API_TOKEN` finds out in two seconds, not after a thirty minute run.

## Local Vouch on your Mac

Three patterns, ordered by "set and forget" quality. Pick one.

### Pattern A. macOS Keychain plus a one-time shell wrapper (recommended)

Strongest "set and forget" on a single Mac. The secret lives in the login Keychain (encrypted by the OS, unlocked automatically at login, survives reboots). A small shell script exports the env vars from Keychain just before launching Vouch, so the secret never sits in plaintext on disk and never appears in your shell history.

#### Step 1: store each secret in the Keychain, once

```bash
# Run once per secret. The `-U` flag means safe to rerun later for rotation.
security add-generic-password \
  -a "$USER" \
  -s "vouch/meridian/api-token" \
  -w 'PASTE_THE_SECRET_HERE' \
  -T /usr/bin/security \
  -U

security add-generic-password \
  -a "$USER" \
  -s "vouch/meridian/solana-devnet-seed" \
  -w 'PASTE_THE_SEED_HERE' \
  -T /usr/bin/security \
  -U
```

The `-s` flag is the lookup name. Convention used here: `vouch/<target>/<purpose>`. This keeps every Vouch related secret findable in one Keychain Access search.

Verify storage:

```bash
security find-generic-password -a "$USER" -s "vouch/meridian/api-token" -w
# Should print the value you pasted. If yes, you are done with this secret forever.
```

#### Step 2: drop a tiny wrapper at `~/bin/vouch-with-creds`

```bash
mkdir -p ~/bin
cat > ~/bin/vouch-with-creds <<'EOF'
#!/usr/bin/env bash
# Resolve every Vouch credential from the macOS Keychain and exec vouch.
# Add new secrets by appending another `export ... = ...` line below.

set -euo pipefail

get_kc() {
  security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null
}

export MERIDIAN_API_TOKEN="$(get_kc 'vouch/meridian/api-token')"
export SOLANA_DEVNET_SEED="$(get_kc 'vouch/meridian/solana-devnet-seed')"

# Add the project's other secrets here as you create them.

exec npx vouch "$@"
EOF
chmod +x ~/bin/vouch-with-creds
```

Make sure `~/bin` is on your PATH (add `export PATH="$HOME/bin:$PATH"` to `~/.zprofile` if not).

#### Step 3: use it

```bash
cd ~/Desktop/Clutter/iOS/meridian
vouch-with-creds init
vouch-with-creds run
```

The wrapper reads from Keychain, exports the env vars into the child process only, and `exec`s Vouch. Your interactive shell never sees the secret. Your shell history is clean. Your dotenv files do not exist.

Rotation later: rerun the `security add-generic-password ... -U` command with the new value. The wrapper picks it up on the next run. The manifest is never touched.

### Pattern B. `~/.zprofile` (simplest, less secure)

If you do not need the Keychain layer, export the env vars from a login script. They are then present in every shell session.

```bash
cat >> ~/.zprofile <<'EOF'

# Vouch credentials for Meridian
export MERIDIAN_API_TOKEN='PASTE_HERE'
export SOLANA_DEVNET_SEED='PASTE_HERE'
EOF
chmod 600 ~/.zprofile
```

Tradeoffs: the secret lives in plaintext inside `~/.zprofile`. Anyone who reads that file reads the secret. FileVault keeps that file unreadable when the disk is powered off, but anyone in your logged in session can `cat ~/.zprofile`. Fine for dev; use Pattern A for anything more sensitive than a devnet seed.

Reload after editing: open a new terminal, or run `source ~/.zprofile` in the current one.

### Pattern C. `chmod 600` dotenv file consumed by a wrapper

If you prefer a per project file:

```bash
cd ~/Desktop/Clutter/iOS/meridian
cat > .env.vouch.local <<'EOF'
MERIDIAN_API_TOKEN=PASTE_HERE
SOLANA_DEVNET_SEED=PASTE_HERE
EOF
chmod 600 .env.vouch.local
echo '.env.vouch.local' >> .gitignore
```

Launch wrapper:

```bash
set -a; source .env.vouch.local; set +a; npx vouch "$@"
```

Same security profile as Pattern B but scoped per project. Easy to delete and recreate during rotation.

## Deployed Vouch

When Vouch's process does not run on your Mac, the Keychain and the dotenv files on your laptop are unreachable. The deployment environment needs to populate the same env var names from its own secret manager. Pick the resolver that matches where you deploy.

The `vouch.inputs.yaml` does not change.

### Render

1. Open your service: [dashboard.render.com](https://dashboard.render.com), pick the Vouch service.
2. Sidebar, click **Environment**.
3. Click **Add Environment Variable**.
4. Key: `MERIDIAN_API_TOKEN`. Value: paste the secret. Click **Save**.
5. Repeat for every `*_from_env` name in `vouch.inputs.yaml`.
6. For multiple Vouch services that share the same secrets, use **Environment Groups** instead: [Render Environment Groups docs](https://render.com/docs/configure-environment-variables#environment-groups). Create one group named `vouch-meridian`, attach it to every Vouch service that targets Meridian. One edit propagates to all.

Render injects the variables at process boot. Vouch's loader resolves them like any other env.

### Fly.io

```bash
fly secrets set \
  MERIDIAN_API_TOKEN='PASTE_HERE' \
  SOLANA_DEVNET_SEED='PASTE_HERE' \
  --app vouch-prod
```

Docs: [fly.io/docs/apps/secrets/](https://fly.io/docs/apps/secrets/). Fly stores secrets encrypted at rest, injects them as env vars at machine start, and refuses to print them back.

### AWS Elastic Container Service or Fargate

Two layers:

1. Store each secret in AWS Secrets Manager: [console.aws.amazon.com/secretsmanager](https://console.aws.amazon.com/secretsmanager). Create a secret per Vouch credential, name it after the env var (e.g., `vouch/meridian/api-token`).
2. In the ECS task definition, reference each secret under `containerDefinitions[].secrets` with the env var name Vouch expects:

```json
{
  "secrets": [
    { "name": "MERIDIAN_API_TOKEN",  "valueFrom": "arn:aws:secretsmanager:us-east-1:...:secret:vouch/meridian/api-token-AbCdEf" },
    { "name": "SOLANA_DEVNET_SEED",  "valueFrom": "arn:aws:secretsmanager:us-east-1:...:secret:vouch/meridian/solana-devnet-seed-AbCdEf" }
  ]
}
```

Docs: [docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data-secrets.html](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data-secrets.html). The task execution role needs `secretsmanager:GetSecretValue` on those ARNs.

### Google Cloud Run

```bash
gcloud secrets create vouch-meridian-api-token --replication-policy=automatic
printf 'PASTE_HERE' | gcloud secrets versions add vouch-meridian-api-token --data-file=-

gcloud run services update vouch-prod \
  --update-secrets MERIDIAN_API_TOKEN=vouch-meridian-api-token:latest
```

Docs: [cloud.google.com/run/docs/configuring/services/secrets](https://cloud.google.com/run/docs/configuring/services/secrets). The Cloud Run service account needs the Secret Manager Secret Accessor role on each secret.

### Doppler (zero infrastructure, free tier)

Doppler is a managed secrets-as-a-service. Strong "set and forget" without standing up infrastructure.

1. Sign in: [doppler.com](https://doppler.com).
2. Create a project named `vouch`. Inside it, create environments `dev`, `prod`.
3. Add every Vouch env var by name. Paste the value.
4. Wrap Vouch's process in the Doppler CLI: `doppler run --project vouch --config prod -- node dist/cli.js run`.

The Doppler CLI fetches secrets at process start and exports them as env vars. Locally, install with `brew install dopplerhq/cli/doppler` then `doppler login`. Same setup, same `vouch.inputs.yaml`, works on your Mac AND on a server.

Docs: [docs.doppler.com](https://docs.doppler.com).

### HashiCorp Vault

For organizations already standardized on Vault. Vouch reads from env, so the wrapper is whatever pulls Vault secrets into env. The two common patterns are the Vault Agent sidecar ([Vault Agent docs](https://developer.hashicorp.com/vault/docs/agent-and-proxy/agent)) and `envconsul` ([envconsul docs](https://github.com/hashicorp/envconsul)). Both inject env vars from a Vault path at process start.

## Hybrid pattern: 1Password Connect

If you want one credential store that backs **both** your local Vouch and your deployed Vouch with the same secret references, run 1Password Connect.

1Password Connect is a self hostable proxy server that exposes a stable HTTP application programming interface (HTTP API) backed by your 1Password vault. The 1Password CLI (`op`) talks to it the same way locally and from a container.

### One time setup

1. Create a 1Password Service Account: [developer.1password.com/docs/service-accounts](https://developer.1password.com/docs/service-accounts).
2. Store every Vouch secret as an item in a vault named `vouch`. One item per secret, field name `credential`.
3. On every Vouch-running machine (your Mac, every deployment), install the `op` CLI: [developer.1password.com/docs/cli/get-started](https://developer.1password.com/docs/cli/get-started).
4. Set `OP_SERVICE_ACCOUNT_TOKEN` in the environment where Vouch runs.

### The wrapper that works in both modes

```bash
#!/usr/bin/env bash
set -euo pipefail

export MERIDIAN_API_TOKEN="$(op read 'op://vouch/meridian-api-token/credential')"
export SOLANA_DEVNET_SEED="$(op read 'op://vouch/solana-devnet-seed/credential')"

exec npx vouch "$@"
```

Same script on your Mac (Keychain-stored `OP_SERVICE_ACCOUNT_TOKEN` via Pattern A above) and on Render / Fly / AWS (`OP_SERVICE_ACCOUNT_TOKEN` set in the platform's secret manager). Rotation happens once in 1Password and propagates everywhere immediately.

This is the closest you can get to a single source of truth that survives across local, continuous integration, staging, and production without ever changing `vouch.inputs.yaml` or the wrapper.

## Manifest reference

Full schema, from `src/core/inputs.ts`:

### Top level

```yaml
text:    [ <TextEntry> ... ]     # form text fields, headers, query params
files:   [ <FileEntry> ... ]     # uploads (passport scans, CSV imports, etc.)
wallets: [ <WalletEntry> ... ]   # crypto wallets with address + optional seed
```

All three sections are optional. Empty file means "use synthetic values," which is fine for targets that do not validate against external systems.

### TextEntry

```yaml
- name: string                     # required, lowercase + underscores, max 64 chars
  description: string              # optional, shown on dashboard
  selector: string                 # optional CSS selector, exact match wins
  value: string                    # exactly one of value | value_from_env
  value_from_env: UPPER_SNAKE_CASE # exactly one of value | value_from_env
```

### FileEntry

```yaml
- name: string                  # required
  description: string           # optional
  selector: string              # optional CSS selector
  path: string                  # required, absolute or project-root relative
  mime: string                  # optional, e.g. image/png
```

The path must exist on disk at run start. Keep large fixture files in `./fixtures/private/<name>` and add `fixtures/private/` to `.gitignore`.

### WalletEntry

```yaml
- name: string                          # required
  description: string                   # optional
  chain: ethereum | solana | polygon | base | other  # required
  address: string                       # required, public, fine to commit
  seed_from_env: UPPER_SNAKE_CASE       # optional; required for actions that need a signer
```

The literal keys `seed`, `seed_phrase`, `mnemonic`, `private_key`, `secret` are forbidden at the wallet level. Vouch refuses to load the file if any are present, regardless of indentation depth.

### Match precedence

When wiring an entry to a discovered form field, Vouch uses this precedence:

1. Explicit `selector:` (CSS exact match)
2. Exact match of `name:` against placeholder, name attribute, aria-label, id, or nearby label text (case insensitive, normalized)
3. Substring match of the same surface fields

Ties at the same precedence level raise an error at run start.

## Fail-closed rules Vouch enforces

These rules run before Vouch opens any browser or sends any HTTP request. If any of them fires, the run aborts with an error that names the offending file and line.

1. **No literal secret keys.** Any of `seed`, `seed_phrase`, `mnemonic`, `private_key`, `secret`, `password`, `api_key` appearing as a key at any depth in `vouch.inputs.yaml` is a hard failure. Move the value behind `*_from_env:` and remove the literal key.
2. **Exactly one of `value` or `value_from_env`.** Text entries that set both, or neither, are rejected.
3. **Env var format is `UPPER_SNAKE_CASE`.** `value_from_env: my_token` is rejected; use `VALUE_FROM_ENV: MY_TOKEN`. This catches the common typo where someone writes the value instead of the env var name.
4. **Referenced env var must be set.** If `vouch.inputs.yaml` references `MERIDIAN_API_TOKEN` and that variable is unset in the environment Vouch was launched with, Vouch fails before doing anything else.
5. **Referenced file path must exist.** `path: ./fixtures/private/passport.png` is verified at load time.
6. **Duplicate `name:` within a section is rejected.** Two text entries both named `customer_email` is an error.
7. **Resolved secrets never reach disk.** Vouch's persistence layer asserts on this. Any attempt to write a resolved `*_from_env` value through the SQLite layer throws.
8. **Resolved secrets never reach the dashboard.** The dashboard JSON payload contains entry NAMES (e.g., `solana_devnet_funded`), never the resolved seed or token.
9. **Resolved secrets never reach the log.** The PSR-3 style structured logger (in Vouch's case, the equivalent in TypeScript) takes context objects, and any field whose source was a `*_from_env` is redacted before serialization.

If any of these protections fails in practice, that is a bug and should be raised as a Vouch issue, not worked around.

## Rotation

The point of the indirection is that rotation never touches `vouch.inputs.yaml`.

- **Local Pattern A (Keychain):** rerun `security add-generic-password ... -U` with the new value. Next Vouch run picks it up.
- **Local Pattern B (`~/.zprofile`):** edit the file, paste the new value, open a new terminal.
- **Local Pattern C (dotenv):** edit `.env.vouch.local`, paste new value.
- **Render / Fly / AWS / GCP / Doppler:** edit the value in the platform's secret manager, redeploy or restart the service (Render and Fly redeploy automatically on secret change).
- **1Password Connect:** edit the item in 1Password. Every machine running the wrapper reads the new value on the next run, no redeploy required.

## Migration path

Start where you are; do not pay for infrastructure you do not need yet.

1. **Slice 0 to slice 3:** local-only Vouch, Pattern B (`~/.zprofile`). Total setup time: two minutes. Good enough for the spec-driven slices that do not touch real third-party services.
2. **Slice 4 onward (real wallets, real APIs):** upgrade to Pattern A (Keychain plus wrapper). Same `vouch.inputs.yaml`, same env var names. The only diff is the wrapper script.
3. **First deployed run:** add the same env var names to whichever platform you deploy on. The manifest does not change. The wrapper either disappears (platform injects env directly) or is replaced by the platform's CLI (Doppler, `op`).
4. **Multi machine / multi environment:** move to 1Password Connect. Same wrapper on every machine, single source of truth.

At no point is `vouch.inputs.yaml` rewritten between stages. The whole purpose of `*_from_env` is to make the manifest portable across every credential backend.

## Common pitfalls

1. **Confusing `value:` with `value_from_env:`.** `value: MY_TOKEN` literally hardcodes the string `MY_TOKEN` as the value. `value_from_env: MY_TOKEN` reads the env var named `MY_TOKEN`. Vouch's env-var-format check (uppercase + underscore) catches most accidents here.
2. **Forgetting to add the env var to the deployment.** Vouch fails fast with a clear "env var X referenced by entry Y is not set" message. Read the error, add the env var, rerun.
3. **Committing a `.env` file.** Always `git status` before any commit on a Vouch target. The convention here is to name local env files `.env.vouch.local` so a project-root `.gitignore` rule `*.local` keeps them out.
4. **Running Vouch in a shell that has not loaded `~/.zprofile`.** macOS only loads `.zprofile` on login shells. If you start Vouch from a subprocess of a non-login shell, the env may be empty. The wrapper-based patterns sidestep this by exporting explicitly.
5. **Using the same env var name across two different targets.** Two Vouch targets that both reference `API_TOKEN` will clash if launched in the same shell. Convention: prefix env var names with the target name, e.g., `MERIDIAN_API_TOKEN`, `OPENEMR_API_TOKEN`.
6. **Storing a Solana keypair as a `text` entry instead of a `wallet` entry.** Wallet entries get the address-plus-seed split, refuse literal seeds, and surface chain-aware actions to Vouch's executor. Text entries do not.

## Where this lives

- The contract: `src/core/inputs.ts` (Vouch source)
- The schema validation tests: `src/core/inputs.test.ts`
- This document: [SHARING_CREDENTIALS.md](./SHARING_CREDENTIALS.md) at the repo root
- The four spec-driven artifacts that describe Vouch's broader architecture: [constitution.md](./constitution.md), [spec.md](./spec.md), [plan.md](./plan.md), [tasks.md](./tasks.md)
