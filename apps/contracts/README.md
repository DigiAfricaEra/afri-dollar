# AfriDollar Soroban Contracts

A [Stellar Soroban](https://developers.stellar.org/docs/build/smart-contracts/overview)
Rust workspace for AfriDollar's on-chain financial logic. It is structured to
scale to many contracts and shared libraries without changing its layout.

## Layout

```
apps/contracts/
├── Cargo.toml            # Workspace root (globs members, shared deps, release profile)
├── Cargo.lock            # Committed for reproducible builds
├── rust-toolchain.toml   # Pins toolchain + wasm32v1-none target
├── Makefile              # Local development workflows
├── contracts/            # Deployable contracts (each builds a .wasm)
│   └── counter/          # Sample contract: init, storage, events, tests
└── crates/               # Shared, non-deployable libraries
    └── shared/           # Common errors + storage-TTL helpers
```

New contracts go under `contracts/<name>` and shared libraries under
`crates/<name>`. Both directories are globbed by the workspace `Cargo.toml`, so
**adding a member requires no changes to the workspace file**.

## Prerequisites

- **Rust** 1.84 or newer (`stable` is recommended). Install via
  [rustup](https://rustup.rs/).
- The **`wasm32v1-none`** build target. Soroban SDK 26 requires this target;
  the older `wasm32-unknown-unknown` is unsupported on modern Rust.
- _(Optional)_ the **Stellar CLI** for optimizing and deploying WASM:
  `cargo install --locked stellar-cli`.

The toolchain and target are declared in `rust-toolchain.toml`, so rustup
installs them automatically the first time you run a `cargo` command in this
directory. To add the target manually:

```bash
rustup target add wasm32v1-none
```

## Local Setup

```bash
cd apps/contracts
rustup show          # Triggers toolchain/target install from rust-toolchain.toml
make build-native    # Quick sanity check: compile the workspace for the host
```

## Building Contracts

Build optimized WASM artifacts for every contract in the workspace:

```bash
make build
# or directly:
cargo build --release --target wasm32v1-none
```

Artifacts are written to `target/wasm32v1-none/release/<contract>.wasm`
(e.g. `counter.wasm`).

### Optimizing WASM

The release profile already produces small artifacts. To shrink them further
with the Stellar CLI:

```bash
make optimize
# or per-file:
stellar contract optimize --wasm target/wasm32v1-none/release/counter.wasm
```

## Running Tests

Unit tests run natively (no WASM build required) and exercise contracts through
their generated test clients:

```bash
make test
# or:
cargo test
```

## Linting & Formatting

```bash
make fmt-check   # cargo fmt --all --check
make lint        # cargo clippy --all-targets --all-features -- -D warnings
```

Run `make fmt` to auto-format before committing.

## Adding a New Contract

1. Create the crate folder and manifest:

   ```bash
   mkdir -p contracts/my-contract/src
   ```

2. Add `contracts/my-contract/Cargo.toml`. Use the workspace's shared
   dependencies and the `cdylib` + `rlib` crate types — copy
   [`contracts/counter/Cargo.toml`](contracts/counter/Cargo.toml) as a template:

   ```toml
   [package]
   name = "my-contract"
   version.workspace = true
   edition.workspace = true
   license.workspace = true
   publish = false

   [lib]
   crate-type = ["cdylib", "rlib"]
   doctest = false

   [dependencies]
   soroban-sdk = { workspace = true }
   afri-contract-shared = { workspace = true }

   [dev-dependencies]
   soroban-sdk = { workspace = true, features = ["testutils"] }
   ```

3. Implement the contract in `contracts/my-contract/src/lib.rs`. The
   [`counter`](contracts/counter/src/lib.rs) contract is the reference: it shows
   one-time initialization, instance storage, events via `#[contractevent]`, and
   admin-gated authorization.

4. Build and test:

   ```bash
   cargo test -p my-contract
   cargo build --release --target wasm32v1-none -p my-contract
   ```

No edits to the workspace `Cargo.toml` are needed — the `contracts/*` glob picks
the new crate up automatically.

### Sharing Code Between Contracts

Put reusable types and helpers in `crates/shared` (or a new `crates/<name>`
library) and depend on it via the workspace. The sample
[`afri-contract-shared`](crates/shared/src/lib.rs) crate provides the common
`Error` enum and an `extend_instance_ttl` helper used by the counter contract.

## CI/CD

Continuous integration is defined in
[`.github/workflows/contracts.yml`](../../.github/workflows/contracts.yml). On
every pull request and on pushes to `main` that touch `apps/contracts/`, CI:

1. Verifies formatting (`cargo fmt --all --check`).
2. Runs clippy with warnings treated as errors.
3. Runs the workspace test suite.
4. Builds the workspace (release).
5. Builds the WASM artifacts (`wasm32v1-none`).
6. Uploads the generated `.wasm` files as a build artifact.

The committed `Cargo.lock` keeps CI and local builds reproducible.

## Reference

- [Soroban smart contracts](https://developers.stellar.org/docs/build/smart-contracts/overview)
- [`soroban-sdk` documentation](https://docs.rs/soroban-sdk)
- [Stellar CLI](https://developers.stellar.org/docs/tools/cli/stellar-cli)
