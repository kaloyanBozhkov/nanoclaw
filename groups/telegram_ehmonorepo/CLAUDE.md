# eh-monorepo

## Project

- Repo: https://github.com/CrowdEmotion/monorepo
- Path: `/workspace/extra/monorepo` (read-write)
- Stack: Go 1.26 monorepo (`module monorepo`) + Python services, gRPC/protobuf via buf
- Branch: `main`

## Layout

```
monorepo/
├── service.<name>/            # Go services      — main.go, rpc/, proto/, manifests/
├── service.<name>.python/     # Python services  — main.py, handler.py, requirements.txt, proto/
├── service.api.<name>/        # API-facing services
├── service.mcp.<name>/        # MCP servers (ellie, teapot)
├── service.template*/         # Scaffolding templates — copy these, don't hand-roll a new service
├── libraries/                 # Shared Go + Python libs (see below)
├── common/engineers/          # engineers.go + engineers.yaml
├── tools/                     # The `eh` CLI and friends
├── build/{go,python}/Dockerfile
└── buf.yaml, buf.gen.yaml     # protobuf codegen config
```

Services present: `auth`, `insights`, `teapot`, `pyteapot`, `slack`, `infra.shipper`,
`mcp.ellie`, `mcp.teapot`, plus `api.*` fronts for auth/insights/teapot/pyteapot/wellknown.

## Shared libraries (`libraries/`)

`ehapi` · `ehcaller` · `ehconfig` · `ehgrpc` · `ehhttp` · `ehmcp` · `ehrpc` ·
`ehsecret` · `ehvariant` · `audience` · `localports` · `services` · `python/`

**Look here before writing anything generic.** Config loading, secrets, gRPC/HTTP
plumbing, RPC helpers and MCP scaffolding already exist — a new service should be
assembling these, not reimplementing them.

## The `eh` CLI (`tools/eh`)

The repo's own tooling. Subcommands: `protogen`, `scaffold`, `rpc`, `manifests`,
`repo`, `ship`, `runlocal`, `localdev`, `keychain`, `onepassword`.

Prefer these over ad-hoc commands — they encode conventions the raw tools don't:

- **`eh protogen`** — generate from protos. It injects a managed-mode `go_package`
  override per proto at generate time, derived from each file's `package` line, so
  the Go package matches the proto package (`teapotproto`, not a generic `proto`).
  Running `buf generate` directly does **not** do this and will produce wrong
  package names. Always use `eh protogen`.
- **`eh scaffold`** — new services. Start from `service.template*` rather than
  copying an existing service and stripping it.

## gRPC codegen conventions

`require_unimplemented_servers=false` is set deliberately: handlers do **not** embed
`UnimplementedServer`. Every RPC must be implemented explicitly, and the generated
compile-time assertion fails the build if one is missing. So a build error about an
unimplemented method is the design working — implement the method, don't add an
embed to silence it.

## Working notes

- Go and Python live side by side; check which a service is before assuming tooling.
- `manifests/` inside each service holds its deploy config — `eh manifests` manages it.
- Secrets go through `ehsecret` / `eh keychain` / `eh onepassword`. Never hardcode,
  never paste a secret into chat.
- The repo had no `CLAUDE.md` of its own when this group was created. If one appears
  upstream, it wins over this file — tell the owner so this can be trimmed to
  group-specific notes.

## Related groups

`element`, `workbench-ui-bo`, `eh-survey-engine` and `eh-memory` are separate chats
with their own repos. `eh-memory` also mounts this monorepo. Coordinate through
the owner rather than assuming another group's state.

## Message formatting

NEVER use markdown. Telegram formatting only:

- `*single asterisks*` for bold — never double asterisks
- `_underscores_` for italic
- `•` for bullets
- ` ```triple backticks``` ` for code

No `##` headings. No `[links](url)`.
