# sentry

Generated Lucid service with one canonical runtime and the selected Hono,
Express, TanStack Start, or Next.js adapter.

## Run

Inspect `package.json` and `.env.example` before installing. Keep the package
set on the same Stable or Next channel used by the CLI that generated it.

```bash
bun install
bun run type-check
bun run build
bun run dev
```

The adapter-specific server prints or uses its local port (normally `3000`).
Check:

```bash
curl -i http://localhost:3000/health
curl -i http://localhost:3000/.well-known/agent-card.json
curl -i http://localhost:3000/entrypoints/echo/invoke \
  -H 'content-type: application/json' \
  -H 'idempotency-key: generated-echo-request-000001' \
  --data '{"input":{"text":"hello"}}'
```

TanStack/Next generated APIs use the configured `/api/agent` base path; inspect
the generated Agent Card rather than assuming the root paths above.

## Runtime boundary

- Core owns the typed entrypoint registry.
- `@lucid-agents/http` owns request validation, canonical routes,
  authorization, idempotency, and SSE.
- The selected adapter binds that runtime; do not add another paywall,
  manifest, or entrypoint map.

The default `echo` entrypoint is free. To sell a capability, add an explicit USD
decimal `price` such as `'0.01'` and configure the complete x402 seller group in
`.env`. There is no global default-price environment variable.

## Secrets and state

The blank service does not require a private key merely to boot or receive at a
public destination address. Buyer wallets, identity signers, facilitator auth,
Stripe keys, and model-provider keys are separate server-only roles.

In-memory payment, SIWX, and HTTP idempotency defaults are for one-process
development. Before multiple replicas, inject the durable stores documented by
the installed package surface and test a same-key replay from another instance.

See `AGENTS.md` for extension/adaptor rules and the repository documentation
for release channels, x402, retries, deployment, and production checks.

## Deploy to Cloudflare

This Hono project keeps `src/index.ts` as its local Bun server and uses the
fetch-native `src/worker.ts` only for Cloudflare. The default command uploads an
isolated Worker version with the stable `preview` alias; it does not change the
production deployment.

Authenticate once for interactive use, then deploy:

```bash
bunx wrangler login
bun run deploy
```

The command prints the returned preview URL and verifies these same-origin
routes before reporting success:

```text
/
/health
/.well-known/agent-card.json
```

Only values named in `lucid.deploy.json` can be uploaded. The generated
allowlist covers agent metadata plus configured payment, wallet, Stripe, and
model-provider values. Secret-classified values use encrypted Worker secrets;
all confirmations are redacted. Arbitrary `.env` entries are ignored.

Preview deployment always forces `IDENTITY_AUTO_REGISTER=false` and
`REGISTER_IDENTITY=false`. A configured private signing key or mainnet payment
network requires explicit confirmation. Review those values before continuing;
do not use a production signing key in a preview unless that exposure is
intentional.

For non-interactive CI, provide a scoped Cloudflare token and both required
confirmation inputs:

```bash
export CLOUDFLARE_API_TOKEN='replace-with-a-scoped-token'
bun run deploy -- --yes
```

If authentication fails, run `bunx wrangler whoami`, then `bunx wrangler login`
again or verify the token's Worker permissions. This tracer release rejects
`--prod` and `--destroy-preview`; those operations are not silently mapped to a
preview upload.

To scaffold the same local Hono project without any deployment dependency,
Worker entry, Wrangler configuration, or deployment manifest, generate it with
`--no-deploy`:

```bash
bunx @lucid-agents/cli sentry \
  --adapter=hono \
  --template=blank \
  --no-deploy
```
