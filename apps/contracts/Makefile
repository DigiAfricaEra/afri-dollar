# AfriDollar Soroban contracts — local development workflows.
#
# Common targets:
#   make build      Build optimized WASM artifacts for every contract
#   make test       Run the workspace unit-test suite
#   make fmt        Format all crates
#   make fmt-check  Verify formatting (used by CI)
#   make lint       Run clippy with warnings denied (used by CI)
#   make optimize   Shrink WASM artifacts with the Stellar CLI
#   make clean      Remove build output

# Soroban SDK 26 builds against wasm32v1-none (Rust 1.84+).
WASM_TARGET := wasm32v1-none
WASM_DIR := target/$(WASM_TARGET)/release

.PHONY: default all build build-native test fmt fmt-check lint optimize clean

default: build

all: fmt-check lint test build

# Build release WASM for all `cdylib` contracts in the workspace.
build:
	cargo build --release --target $(WASM_TARGET)
	@ls -lh $(WASM_DIR)/*.wasm 2>/dev/null || true

# Build the workspace for the host target (faster feedback than WASM).
build-native:
	cargo build --release

test:
	cargo test

fmt:
	cargo fmt --all

fmt-check:
	cargo fmt --all --check

lint:
	cargo clippy --all-targets --all-features -- -D warnings

# Requires the Stellar CLI: `cargo install --locked stellar-cli`.
optimize: build
	@for wasm in $(WASM_DIR)/*.wasm; do \
		echo "Optimizing $$wasm"; \
		stellar contract optimize --wasm $$wasm; \
	done

clean:
	cargo clean
