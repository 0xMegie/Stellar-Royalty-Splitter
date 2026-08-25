# Deployment Guide

Checklist and tooling for deploying the Stellar Royalty Splitter contract to
testnet or mainnet. Use this alongside `scripts/deploy.sh` and
`scripts/validate-deployment.sh`.

## Table of Contents

- [Pre-Deployment Checklist](#pre-deployment-checklist)
- [Running Validation](#running-validation)
- [Deploying](#deploying)
- [Post-Deployment Checklist](#post-deployment-checklist)
- [Rollback Procedure](#rollback-procedure)

## Pre-Deployment Checklist

- [ ] Rust toolchain and `wasm32-unknown-unknown` target installed
- [ ] Stellar CLI installed (`cargo install --locked stellar-cli`)
- [ ] Signing identity exists (`stellar keys show <identity>`) and is funded
      on the target network
- [ ] Contract builds cleanly (`cargo build --target wasm32-unknown-unknown --release`)
- [ ] WASM optimizes cleanly (`stellar contract optimize`)
- [ ] Collaborator addresses and share basis points are finalized and sum to
      10,000 (100.00%)
- [ ] The first collaborator in the list is the intended admin — `initialize()`
      requires that address's auth
- [ ] Simulated contract upload succeeds (no funds spent, catches permission
      or balance issues early)
- [ ] `backend/.env` target (`ROYALTY_CONTRACT_ID`, `STELLAR_NETWORK`) is the
      one you intend to update

Run all of the above automatically with:

```bash
STELLAR_NETWORK=testnet STELLAR_IDENTITY=deployer ./scripts/validate-deployment.sh pre
```

## Running Validation

`scripts/validate-deployment.sh` has two modes:

```bash
# Before deploying: build, WASM, identity/balance, simulated upload
./scripts/validate-deployment.sh pre

# After deploying: on-chain state checks against a live contract ID
./scripts/validate-deployment.sh post <CONTRACT_ID>
```

Each check prints `[✓]` on success or `[✗]` on failure, and the script exits
non-zero if any check fails — safe to wire into CI or a release runbook.
Respects the same `STELLAR_NETWORK` / `STELLAR_IDENTITY` environment
variables as `scripts/deploy.sh`.

## Deploying

Once `pre` validation passes:

```bash
STELLAR_NETWORK=testnet STELLAR_IDENTITY=deployer ./scripts/deploy.sh
```

This builds, optimizes, deploys, and writes the resulting `CONTRACT_ID` to
`.contract-id` and `backend/.env`. It prints the `initialize` invocation you
still need to run manually (admin auth can't be scripted safely).

## Post-Deployment Checklist

- [ ] `is_initialized()` returns `true` after calling `initialize`
- [ ] `get_admin()` returns the expected first-collaborator address
- [ ] Collaborators/shares match what was intended (spot-check via
      `stellar contract invoke -- get_collaborators` if available, or the
      backend `/api/collaborators/:contractId` endpoint)
- [ ] `backend/.env` `ROYALTY_CONTRACT_ID` and `STELLAR_NETWORK` match this
      deployment
- [ ] Backend restarted / redeployed so it picks up the new contract ID
- [ ] A test distribution on testnet succeeds end-to-end before treating a
      mainnet deployment as final

Run the automated portion with:

```bash
STELLAR_NETWORK=testnet STELLAR_IDENTITY=deployer ./scripts/validate-deployment.sh post <CONTRACT_ID>
```

## Rollback Procedure

Soroban contracts are immutable once deployed — there is no in-place revert.
If a deployment is misconfigured or broken:

1. **Do not point the backend at the bad contract.** If `backend/.env` was
   already updated, revert `ROYALTY_CONTRACT_ID` to the previous known-good
   contract ID (check `.contract-id` history / git history of `backend/.env`
   if tracked, or your deployment log) and restart the backend.
2. **If `initialize()` was never called** on the bad contract, it's inert —
   no funds can be distributed through it. Simply stop referencing it; no
   further action is required on-chain.
3. **If `initialize()` succeeded but the configuration is wrong** (wrong
   collaborators/shares), deploy a corrected contract from scratch using
   `scripts/deploy.sh` and repeat the full checklist above. Do not attempt to
   "fix" the live contract — Soroban contract state/logic for a deployed
   WASM cannot be changed without an explicit upgrade path, and this
   contract does not expose one for its core split configuration.
4. **If funds were already sent to the bad contract** before the issue was
   caught, they are recoverable only via whatever withdrawal/admin function
   the contract exposes (see `is_initialized`/`get_admin` and the contract's
   own README for any admin-only recovery calls) — there is no generic
   rollback for on-chain state.
5. **Record the incident**: keep the bad `CONTRACT_ID`, the network, the
   timestamp, and the root cause in your team's deployment log so future
   `pre` validation runs can be extended to catch the same class of mistake.
