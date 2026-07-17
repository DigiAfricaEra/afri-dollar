# AfriDollar Bridge Contract

Cross-chain bridge contract for secure asset transfers between Stellar and other blockchains.

## Overview

The bridge contract implements a lock-mint/burn-unlock mechanism for cross-chain asset transfers:

1. **Lock** - Assets are locked on the source chain
2. **Mint** - Wrapped assets are minted 1:1 on the destination chain
3. **Burn** - Wrapped assets are burned on the destination chain
4. **Unlock** - Original assets are unlocked on the source chain

## Features

- **Asset Locking**: Securely lock assets for cross-chain transfer
- **Wrapped Asset Minting**: Mint wrapped tokens 1:1 on destination chain
- **Wrapped Asset Burning**: Burn wrapped tokens to initiate return transfer
- **Asset Unlocking**: Unlock original assets with proof verification
- **Proof Verification**: Transaction proof validation to prevent fraud
- **Bridge Fee Management**: Configurable fee structure (basis points)
- **Request Tracking**: Complete lifecycle tracking of bridge requests

## Data Structures

### BridgeRequest

```rust
pub struct BridgeRequest {
    pub id: u64,
    pub source_chain: Symbol,
    pub destination_chain: Symbol,
    pub asset: Address,
    pub amount: i128,
    pub sender: Address,
    pub recipient: Bytes,
    pub status: BridgeStatus,
    pub created_at: u64,
    pub completed_at: Option<u64>,
}
```

### BridgeStatus

```rust
pub enum BridgeStatus {
    Pending,   // Request initiated
    Locked,    // Assets locked on source
    Minted,    // Wrapped assets minted
    Burned,    // Wrapped assets burned
    Unlocked,  // Original assets unlocked
    Failed,    // Transfer failed
}
```

## Core Functions

### lock_asset

Lock assets on the source chain for cross-chain transfer.

```rust
pub fn lock_asset(
    env: Env,
    asset: Address,
    amount: i128,
    destination_chain: Symbol,
    recipient: Bytes,
) -> Result<u64, Error>
```

**Parameters:**

- `asset`: The asset address to lock
- `amount`: The amount to lock (deducts bridge fee)
- `destination_chain`: Destination chain identifier
- `recipient`: Recipient address on destination chain (hex encoded)

**Returns:** Bridge request ID

**Events:** `BridgeInitiated`

### mint_wrapped

Mint wrapped assets on the destination chain.

```rust
pub fn mint_wrapped(
    env: Env,
    bridge_request_id: u64,
    proof: Bytes,
) -> Result<(), Error>
```

**Parameters:**

- `bridge_request_id`: The bridge request ID
- `proof`: Transaction proof for verification

**Returns:** `Ok(())` on success

**Events:** `WrappedMinted`

### burn_wrapped

Burn wrapped assets on the destination chain.

```rust
pub fn burn_wrapped(
    env: Env,
    asset: Address,
    amount: i128,
    source_chain: Symbol,
    recipient: Bytes,
) -> Result<u64, Error>
```

**Parameters:**

- `asset`: The wrapped asset address to burn
- `amount`: The amount to burn
- `source_chain`: Source chain identifier
- `recipient`: Recipient address on source chain (hex encoded)

**Returns:** New bridge request ID for unlocking

**Events:** `WrappedBurned`

### unlock_asset

Unlock original assets on the source chain.

```rust
pub fn unlock_asset(
    env: Env,
    bridge_request_id: u64,
    proof: Bytes,
) -> Result<(), Error>
```

**Parameters:**

- `bridge_request_id`: The bridge request ID
- `proof`: Transaction proof for verification

**Returns:** `Ok(())` on success

**Events:** `AssetsUnlocked`

### set_bridge_fee

Set the bridge fee percentage (requires admin authorization).

```rust
pub fn set_bridge_fee(
    env: Env,
    fee_percentage: u32,
) -> Result<(), Error>
```

**Parameters:**

- `fee_percentage`: Fee in basis points (100 = 1%)

**Returns:** `Ok(())` on success

### get_bridge_request

Retrieve a bridge request by ID.

```rust
pub fn get_bridge_request(
    env: Env,
    request_id: u64,
) -> Option<BridgeRequest>
```

**Returns:** `Some(BridgeRequest)` if found, `None` otherwise

### get_bridge_request_ids

Get all bridge request IDs.

```rust
pub fn get_bridge_request_ids(env: Env) -> Vec<u64>
```

**Returns:** Vector of all bridge request IDs

### get_bridge_fee

Get the current bridge fee percentage.

```rust
pub fn get_bridge_fee(env: Env) -> u32
```

**Returns:** Fee percentage in basis points

## Events

- `BridgeInitiated` - New bridge request created
- `AssetsLocked` - Assets locked on source chain
- `WrappedMinted` - Wrapped assets minted on destination
- `WrappedBurned` - Wrapped assets burned on destination
- `AssetsUnlocked` - Original assets unlocked on source
- `BridgeFailed` - Bridge request failed

## Bridge Flow

### Outbound (Stellar → External Chain)

1. User calls `lock_asset` to lock tokens
2. Bridge fee is deducted (default 0.30%)
3. `BridgeInitiated` event emitted
4. Off-chain relayer monitors event
5. Relayer submits proof to external chain
6. Wrapped tokens minted on destination

### Inbound (External Chain → Stellar)

1. User burns wrapped tokens on external chain
2. `burn_wrapped` called on Stellar (via relayer)
3. `WrappedBurned` event emitted
4. Off-chain relayer monitors event
5. Relayer submits proof to source chain
6. Original tokens unlocked on Stellar

## Fee Structure

- Fees are calculated in basis points
- Default fee: 30 basis points (0.30%)
- Fee is deducted from the locked amount
- Only admin can update the fee percentage

## Security

- **Authorization**: Admin functions require `require_auth`
- **Proof Verification**: Transaction proofs prevent fraudulent claims
- **Status Tracking**: Requests progress through defined states
- **Initialization Guard**: Prevents re-initialization
- **TTL Management**: Instance storage TTL is extended on state changes

## Testing

Run tests:

```bash
cargo test -p afri-contract-bridge
```

Run tests with output:

```bash
cargo test -p afri-contract-bridge -- --nocapture
```

## Integration

This contract is part of the AfriDollar Soroban contract suite:

- `afri-contract-shared` - Shared types and utilities
- `afri-contract-counter` - Reference contract
- `afri-contract-bridge` - This contract

## Build

Build the contract:

```bash
cd apps/contracts
cargo build -p afri-contract-bridge
```

Build optimized WASM:

```bash
cd apps/contracts
cargo build --release -p afri-contract-bridge
```

## License

MIT - See LICENSE file for details
