#![no_std]
pub mod auth;
mod storage;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token,
    xdr::ToXdr, Address, BytesN, Env, Map, String, Vec,
};

#[contracttype]
#[derive(Clone)]
pub struct Recipient {
    pub address: Address,
    pub share: u32,
}

/// One entry in the royalty rate change history (#323).
#[contracttype]
#[derive(Clone)]
pub struct RoyaltyRateChange {
    pub old_rate: u32,
    pub new_rate: u32,
    pub timestamp: u64,
    pub caller: Address,
}

/// A pending timelocked admin rotation (#778).
///
/// Created by `initiate_admin_rotation`; consumed by `finalize_admin_rotation`
/// once `initiated_at + timelock` has elapsed, or discarded by
/// `cancel_admin_rotation`.
#[contracttype]
#[derive(Clone)]
pub struct AdminRotation {
    pub new_admin: Address,
    pub initiated_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct MigrationRecord {
    pub from_version: String,
    pub to_version: String,
    pub applied_at: u64,
    pub note: String,
}

/// Selects which distribution operation a pause/unpause applies to (#749).
///
/// `Primary` and `Secondary` allow an admin to pause one distribution path
/// while leaving the other running. They are independent of, and layered on
/// top of, the existing global `pause()`/`unpause()` switch: a global pause
/// still blocks both operations regardless of this per-operation state.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationType {
    PrimaryDistribution,
    SecondaryDistribution,
}

/// Typed storage keys.
///
/// Instance storage keys: small, frequently accessed values (Admin, Paused, etc.).
/// Persistent storage keys: large or infrequently accessed values (Collaborators,
/// ShareMap, DefaultRecipients) — stored separately to avoid bloating the instance
/// entry and unnecessarily increasing ledger fees.
#[contracttype]
#[derive(Clone)]
pub enum StorageKey {
    // Instance storage
    Admin,
    SecondaryPool,
    SecondaryToken,
    ContractVersion,
    RoyaltyRate,
    LastDistribution,
    LastSecondaryDistribution,
    Paused,
    PausedPrimary,
    PausedSecondary,
    DistributeHistory,
    PendingAdmin,
    AdminList,
    AdminThreshold,
    IncentivesEnabled,
    PendingAdminRotation,
    AdminRotationTimelock,
    EmergencyPaused,
    AnomalyThreshold,
    // Persistent storage
    Collaborators,
    ShareMap,
    DefaultRecipients,
    RoyaltyRateHistory,
    InitializeCollaboratorsHash,
    InitializeSharesHash,
    InitializeCommitLedger,
    InitializeNonce,
    AppliedMigrations,
    MigrationMemo,
    ContributorJoinDate,
    ContributorActivityCount,
}

/// Maximum number of rate-change entries kept in history.
/// Older entries are dropped when the cap is reached.
pub const RATE_HISTORY_CAP: u32 = 20;

/// Maximum number of collaborators accepted by `initialize`.
/// Bounded by Soroban execution and storage costs.
pub const MAX_COLLABORATORS: u32 = 10;

/// Maximum number of recipients accepted by `set_recipients`, `set_default_recipients`,
/// and `distribute_with_override`.
pub const MAX_RECIPIENTS: u32 = 10;

/// Maximum number of admins in the multi-sig admin list (`set_admins`).
pub const MAX_ADMIN_LIST: u32 = 10;

/// Window (seconds) after a collaborator's join date during which they
/// qualify for the early-adopter incentive bonus (#776). 30 days.
pub const EARLY_ADOPTER_WINDOW_SECS: u64 = 2_592_000;

/// Early-adopter incentive bonus, in basis points (0.5%).
pub const EARLY_ADOPTER_BONUS_BPS: u32 = 50;

/// Activity incentive bonus granted per `ACTIVITY_BONUS_STEP` recorded
/// secondary-royalty payments a collaborator has personally made, in basis
/// points (0.1% per step).
pub const ACTIVITY_BONUS_BPS_PER_STEP: u32 = 10;

/// Number of recorded activities per activity-bonus step.
pub const ACTIVITY_BONUS_STEP: u32 = 100;

/// Maximum number of activity-bonus steps counted per collaborator — caps
/// the activity component at 100 bps (1%) before the overall per-collaborator
/// cap below is applied.
pub const ACTIVITY_BONUS_MAX_STEPS: u32 = 10;

/// Maximum incentive bonus a single collaborator can receive, in basis
/// points (10%) — the safety bound called for by #776's acceptance criteria.
pub const MAX_INDIVIDUAL_INCENTIVE_BPS: u32 = 1_000;

/// Maximum combined incentive bonus across all collaborators in one
/// distribution, in basis points (20%). Individual bonuses are scaled down
/// proportionally when their raw sum would exceed this.
pub const MAX_TOTAL_INCENTIVE_BPS: u32 = 2_000;

/// Default duration (seconds) a timelocked admin rotation must wait before
/// `finalize_admin_rotation` can complete it (#778). 48 hours.
pub const DEFAULT_ADMIN_ROTATION_TIMELOCK: u64 = 172_800;

/// Minimum configurable timelock duration (seconds) for admin rotation — 1 hour.
/// Prevents `set_admin_rotation_timelock` from being configured down to a
/// value so small the timelock provides no meaningful protection.
pub const MIN_ADMIN_ROTATION_TIMELOCK: u64 = 3_600;

/// Maximum configurable timelock duration (seconds) for admin rotation — 30 days.
pub const MAX_ADMIN_ROTATION_TIMELOCK: u64 = 2_592_000;

/// Maximum number of tokens accepted per `batch_distribute` call.
///
/// `batch_distribute` loops over every token in `tokens` within a single
/// contract invocation, doing a `balance` read plus up to `n` collaborator
/// `transfer`s per token — unbounded `tokens.len()` means unbounded work in
/// one call, risking Soroban's per-invocation CPU instruction budget. 50 is
/// a conservative cap (each token can fan out into up to `MAX_COLLABORATORS`
/// transfers, so a full batch is at most 500 transfers) well under the
/// budget while leaving room for realistic multi-token distributions.
///
/// Not the same axis as the backend's `MAX_BATCH_OPERATIONS` (see
/// `backend/src/validation.js`), which bounds how many *separate*
/// single-token `distribute` calls (potentially against different
/// contracts) the backend groups into one RPC round trip — that's an
/// off-chain batching optimization, unrelated to this on-chain loop bound.
pub const MAX_BATCH_TOKENS: u32 = 50;

/// Backward-compatible alias for integration tests and external references.
pub type DataKey = StorageKey;

pub use storage::MIN_TTL;

/// On-chain contract version in [semantic versioning](https://semver.org/) format
/// (`MAJOR.MINOR.PATCH`, e.g. `"0.1.0"`).
///
/// Written to `StorageKey::ContractVersion` during `initialize` and exposed via
/// `get_version()`. Deploying upgraded WASM creates a new contract instance;
/// existing instances retain their stored version so integrators can detect
/// capability differences off-chain. No automatic state migration is performed
/// between versions — read `get_version()` before invoking version-specific
/// entrypoints and plan migrations explicitly when redeploying.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    Underfunded = 1,
    AlreadyInitialized = 2,
    EmptyCollaborators = 3,
    TooManyRecipients = 4,
    LengthMismatch = 5,
    InvalidShareTotal = 6,
    ZeroShare = 7,
    DuplicateRecipient = 8,
    InvalidBasisPoints = 9,
    NotInitialized = 10,
    NoCollaborators = 11,
    NoShareMap = 12,
    ArithmeticOverflow = 13,
    RoyaltyRateZero = 14,
    RoyaltyRateTooHigh = 15,
    ContractPaused = 16,
    AmountNotPositive = 17,
    InsufficientBalance = 18,
    EmptyRecipients = 19,
    AmountTooSmall = 20,
    PoolExceedsBalance = 21,
    NoSecondaryRoyalties = 22,
    NoSecondaryToken = 23,
    CollaboratorNotFound = 24,
    InvalidUpdatedShareTotal = 25,
    SalePriceNotPositive = 26,
    InputTooLarge = 27,
    NoBalance = 28,
    NoInitializationCommitment = 29,
    InitializationRevealTooEarly = 30,
    InitializationCommitmentMismatch = 31,
    TooManyBatchTokens = 32,
    RoyaltyAmountNotPositive = 33,
    NoPendingAdminRotation = 34,
    AdminRotationTimelockNotElapsed = 35,
    InvalidTimelockDuration = 36,
    EmergencyContractPaused = 37,
    InvalidAnomalyThreshold = 38,
}

#[contract]
pub struct RoyaltySplitter;

#[contractimpl]
impl RoyaltySplitter {
    fn fail(env: &Env, error: ContractError) -> ! {
        soroban_sdk::panic_with_error!(env, error);
    }

    fn require_admin_address(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&StorageKey::Admin)
            .unwrap_or_else(|| Self::fail(env, ContractError::NotInitialized))
    }

    fn require_collaborators(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&StorageKey::Collaborators)
            .unwrap_or_else(|| Self::fail(env, ContractError::NoCollaborators))
    }

    fn require_share_map(env: &Env) -> Map<Address, u32> {
        env.storage()
            .instance()
            .get(&StorageKey::ShareMap)
            .unwrap_or_else(|| Self::fail(env, ContractError::NoShareMap))
    }

    fn checked_add_share_total(env: &Env, total: u32, share: u32) -> u32 {
        total
            .checked_add(share)
            .unwrap_or_else(|| Self::fail(env, ContractError::ArithmeticOverflow))
    }

    fn checked_bps_amount(env: &Env, amount: i128, bps: u32) -> i128 {
        if amount < 0 {
            Self::fail(env, ContractError::ArithmeticOverflow);
        }

        let numerator = (amount as u128)
            .checked_mul(bps as u128)
            .unwrap_or_else(|| Self::fail(env, ContractError::ArithmeticOverflow));
        let result = numerator / 10_000;
        if result > i128::MAX as u128 {
            Self::fail(env, ContractError::ArithmeticOverflow);
        }
        result as i128
    }

    fn initialize_validated(
        env: &Env,
        collaborators: Vec<Address>,
        shares: Vec<u32>,
    ) {
        if collaborators.is_empty() {
            Self::fail(env, ContractError::EmptyCollaborators);
        }

        if collaborators.len() > MAX_COLLABORATORS {
            Self::fail(env, ContractError::TooManyRecipients);
        }

        if collaborators.len() != shares.len() {
            Self::fail(env, ContractError::LengthMismatch);
        }

        let mut total: u32 = 0;
        for share in shares.iter() {
            total = Self::checked_add_share_total(env, total, share);
        }

        if total != 10_000 {
            Self::fail(env, ContractError::InvalidShareTotal);
        }

        let mut share_map: Map<Address, u32> = Map::new(env);

        for i in 0..collaborators.len() {
            let addr = collaborators.get(i).unwrap();
            let share = shares.get(i).unwrap();

            if share == 0 {
                Self::fail(env, ContractError::ZeroShare);
            }

            if share_map.contains_key(addr.clone()) {
                Self::fail(env, ContractError::DuplicateRecipient);
            }

            share_map.set(addr, share);
        }

        // Record each collaborator's join date for the early-adopter
        // incentive bonus (#776). initialize_validated only runs once per
        // contract (guarded by the AlreadyInitialized check in initialize/
        // reveal_initialize), so every collaborator here is joining fresh.
        let now = env.ledger().timestamp();
        let mut join_dates: Map<Address, u64> = Map::new(env);
        for addr in collaborators.iter() {
            join_dates.set(addr, now);
        }
        storage::persistent_set(env, &StorageKey::ContributorJoinDate, &join_dates);

        let admin = collaborators.get(0).unwrap();
        storage::instance_set(env, &StorageKey::Admin, &admin);
        storage::persistent_set(env, &StorageKey::Collaborators, &collaborators);
        storage::persistent_set(env, &StorageKey::ShareMap, &share_map);

        let version = String::from_str(env, VERSION);
        storage::instance_set(env, &StorageKey::ContractVersion, &version);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("init")),
            (collaborators, shares),
        );
    }

    /// Initialize the contract with collaborators and their revenue shares.
    ///
    /// Can only be called once. The first address in `collaborators` becomes
    /// the admin and must authorize this transaction.
    ///
    /// # Arguments
    /// * `collaborators` - Recipient wallet addresses; first is admin (max 10).
    /// * `shares` - Basis-point allocations per collaborator (must sum to 10,000).
    ///
    /// # Authorization
    /// Requires signature from `collaborators[0]` (the admin).
    ///
    /// # Panics
    /// On invalid collaborators/shares, duplicate addresses, or re-initialization.
    pub fn initialize(env: Env, collaborators: Vec<Address>, shares: Vec<u32>) {
        storage::extend_instance_ttl(&env);

        if env.storage().instance().has(&StorageKey::Admin) {
            Self::fail(&env, ContractError::AlreadyInitialized);
        }

        if collaborators.is_empty() {
            Self::fail(&env, ContractError::EmptyCollaborators);
        }

        // #744: the len bound is also enforced inside initialize_validated
        // below (which reveal_initialize relies on exclusively); kept here
        // too only because collaborators.get(0) on the next line needs a
        // non-empty, non-oversized list to safely identify the admin before
        // authorization runs. Both checks must stay in sync with
        // initialize_validated's — see that function's own bound check.
        if collaborators.len() > MAX_COLLABORATORS {
            Self::fail(&env, ContractError::TooManyRecipients);
        }

        // The first collaborator is the admin and must sign the init tx,
        // preventing any third party from front-running initialization.
        auth::require_admin(
            &env,
            &collaborators.get(0).unwrap(),
            auth::msg::INITIALIZE_ADMIN,
        );

        Self::initialize_validated(&env, collaborators, shares);
    }

    /// Store hashes for a hidden initialization payload. The commitment is
    /// intentionally permissionless because the admin address is part of the
    /// hidden collaborator list and cannot be authenticated until reveal.
    pub fn commit_initialize(env: Env, collaborators_hash: BytesN<32>, shares_hash: BytesN<32>) {
        storage::extend_instance_ttl(&env);

        if env.storage().instance().has(&StorageKey::Admin) {
            Self::fail(&env, ContractError::AlreadyInitialized);
        }

        let current_nonce: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::InitializeNonce)
            .unwrap_or(0);
        let nonce: u32 = current_nonce
            .checked_add(1)
            .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));

        storage::instance_set(&env, &StorageKey::InitializeCollaboratorsHash, &collaborators_hash);
        storage::instance_set(&env, &StorageKey::InitializeSharesHash, &shares_hash);
        storage::instance_set(&env, &StorageKey::InitializeCommitLedger, &env.ledger().sequence());
        storage::instance_set(&env, &StorageKey::InitializeNonce, &nonce);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("initcmt")),
            (collaborators_hash, shares_hash, nonce),
        );
    }

    /// Reveal and consume a prior initialization commitment after one ledger.
    pub fn reveal_initialize(env: Env, collaborators: Vec<Address>, shares: Vec<u32>) {
        storage::extend_instance_ttl(&env);

        if env.storage().instance().has(&StorageKey::Admin) {
            Self::fail(&env, ContractError::AlreadyInitialized);
        }

        let committed_collaborators: BytesN<32> = env
            .storage()
            .instance()
            .get(&StorageKey::InitializeCollaboratorsHash)
            .unwrap_or_else(|| Self::fail(&env, ContractError::NoInitializationCommitment));
        let committed_shares: BytesN<32> = env
            .storage()
            .instance()
            .get(&StorageKey::InitializeSharesHash)
            .unwrap_or_else(|| Self::fail(&env, ContractError::NoInitializationCommitment));
        let commit_ledger: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::InitializeCommitLedger)
            .unwrap_or_else(|| Self::fail(&env, ContractError::NoInitializationCommitment));

        if env.ledger().sequence() <= commit_ledger {
            Self::fail(&env, ContractError::InitializationRevealTooEarly);
        }

        let collaborators_hash = env.crypto().sha256(&collaborators.clone().to_xdr(&env));
        let shares_hash = env.crypto().sha256(&shares.clone().to_xdr(&env));
        if collaborators_hash != committed_collaborators || shares_hash != committed_shares {
            Self::fail(&env, ContractError::InitializationCommitmentMismatch);
        }

        let admin = collaborators.get(0).unwrap_or_else(|| Self::fail(&env, ContractError::EmptyCollaborators));
        auth::require_admin(&env, &admin, auth::msg::INITIALIZE_ADMIN);
        Self::initialize_validated(&env, collaborators, shares);

        env.storage().instance().remove(&StorageKey::InitializeCollaboratorsHash);
        env.storage().instance().remove(&StorageKey::InitializeSharesHash);
        env.storage().instance().remove(&StorageKey::InitializeCommitLedger);
    }

    /// Apply versioned state migrations after a WASM upgrade.
    ///
    /// The current migration is intentionally additive: it records that the
    /// instance has been migrated from `from_version` to the current contract
    /// `VERSION` and writes an optional memo slot for future schema evolution.
    /// Re-running the same migration is idempotent and leaves storage unchanged.
    pub fn migrate(env: Env, from_version: String) {
        storage::extend_instance_ttl(&env);
        Self::check_admin_auth(&env, auth::msg::UPDATE_WASM_ADMIN);

        let to_version = String::from_str(&env, VERSION);
        let mut records: Vec<MigrationRecord> =
            storage::persistent_get(&env, &StorageKey::AppliedMigrations)
                .unwrap_or(Vec::new(&env));

        for record in records.iter() {
            if record.from_version == from_version && record.to_version == to_version {
                return;
            }
        }

        if !env.storage().instance().has(&StorageKey::MigrationMemo) {
            storage::instance_set(
                &env,
                &StorageKey::MigrationMemo,
                &String::from_str(&env, "optional-field-placeholder"),
            );
        }

        records.push_back(MigrationRecord {
            from_version: from_version.clone(),
            to_version: to_version.clone(),
            applied_at: env.ledger().timestamp(),
            note: String::from_str(&env, "recorded additive migration framework"),
        });
        storage::persistent_set(&env, &StorageKey::AppliedMigrations, &records);
        storage::instance_set(&env, &StorageKey::ContractVersion, &to_version);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("migrate")),
            (from_version, to_version),
        );
    }

    pub fn get_applied_migrations(env: Env) -> Vec<MigrationRecord> {
        storage::extend_instance_ttl(&env);
        storage::persistent_get(&env, &StorageKey::AppliedMigrations)
            .unwrap_or(Vec::new(&env))
    }

    /// Set the secondary royalty rate for resales.
    ///
    /// # Arguments
    /// * `new_rate` - Royalty rate in basis points (0–10,000). 0 disables royalties;
    ///   10,000 means 100% of the sale price goes to the royalty pool.
    ///
    /// # Authorization
    /// Requires admin signature.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    /// * `"royalty rate cannot exceed 10000 basis points"` — `new_rate > 10_000`
    pub fn set_royalty_rate(env: Env, new_rate: u32) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_ROYALTY_RATE_ADMIN);

        if new_rate == 0 {
            Self::fail(&env, ContractError::RoyaltyRateZero);
        }

        if new_rate > 10_000 {
            Self::fail(&env, ContractError::RoyaltyRateTooHigh);
        }

        // Read old rate before overwriting — 0 means never set.
        let old_rate: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::RoyaltyRate)
            .unwrap_or(0);

        storage::instance_set(&env, &StorageKey::RoyaltyRate, &new_rate);

        // Append to capped history in persistent storage (#323).
        // Gas note: one persistent read + write per call; capped at RATE_HISTORY_CAP
        // entries (~20 × ~80 bytes) so storage growth is bounded.
        let caller: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("contract not initialized");

        let mut history: Vec<RoyaltyRateChange> =
            storage::persistent_get::<Vec<RoyaltyRateChange>>(&env, &StorageKey::RoyaltyRateHistory)
                .unwrap_or(Vec::new(&env));

        if history.len() >= RATE_HISTORY_CAP {
            // Drop the oldest entry to keep the vec at the cap.
            let mut trimmed: Vec<RoyaltyRateChange> = Vec::new(&env);
            for i in 1..history.len() {
                trimmed.push_back(history.get(i).unwrap());
            }
            history = trimmed;
        }

        history.push_back(RoyaltyRateChange {
            old_rate,
            new_rate,
            timestamp: env.ledger().timestamp(),
            caller,
        });

        storage::persistent_set(&env, &StorageKey::RoyaltyRateHistory, &history);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("rate_set")),
            new_rate,
        );
    }

    /// Returns the on-chain history of royalty rate changes, oldest first.
    ///
    /// Each entry contains the old rate, new rate, block timestamp, and the
    /// admin address that made the change. Capped at [`RATE_HISTORY_CAP`]
    /// entries — once full, the oldest entry is dropped on each new change.
    ///
    /// Returns an empty vec if `set_royalty_rate` has never been called.
    pub fn get_royalty_rate_history(env: Env) -> Vec<RoyaltyRateChange> {
        storage::extend_instance_ttl(&env);
        storage::persistent_get::<Vec<RoyaltyRateChange>>(&env, &StorageKey::RoyaltyRateHistory)
            .unwrap_or(Vec::new(&env))
    }

    /// Pause the contract — halts `distribute` and `distribute_secondary_royalties`.
    ///
    /// While paused, any call to `distribute` or `distribute_secondary_royalties`
    /// will panic with `"contract is paused"`. Read-only functions are unaffected.
    ///
    /// # Authorization
    /// Requires admin signature.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn pause(env: Env) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::PAUSE_ADMIN);
        storage::instance_set(&env, &StorageKey::Paused, &true);
        let admin = Self::require_admin_address(&env);
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("paused")),
            admin,
        );
    }

    /// Transfer admin rights to a new address (single-admin mode only).
    ///
    /// Immediate single-step transfer — the new admin does NOT need to confirm.
    /// Disabled when multi-sig is active; use `propose_admin_transfer` instead.
    ///
    /// # Arguments
    /// * `new_admin` - Address that will become the contract admin.
    ///
    /// # Authorization
    /// Requires signature from the current admin.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    /// * `"use propose_admin_transfer when multi-sig is active"` — if AdminList is set
    pub fn admin_transfer(env: Env, new_admin: Address) {
        storage::extend_instance_ttl(&env);

        // Block single-step transfer when multi-sig is configured (#321 + #320 safety)
        if env.storage().instance().has(&StorageKey::AdminList) {
            panic!("use propose_admin_transfer when multi-sig is active");
        }

        let admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("contract not initialized");

        auth::require_admin(&env, &admin, auth::msg::ADMIN_TRANSFER_ADMIN);

        let previous_admin = admin.clone();
        storage::instance_set(&env, &StorageKey::Admin, &new_admin);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("admin_xfr")),
            (previous_admin, new_admin),
        );
    }

    /// Propose a new admin — first step of the two-step admin transfer (#320).
    ///
    /// Stores `new_admin` as pending; the transfer is not complete until
    /// `accept_admin` is called by `new_admin`.
    ///
    /// # Authorization
    /// Requires current admin (or multi-sig threshold) signature.
    pub fn propose_admin_transfer(env: Env, new_admin: Address) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::PROPOSE_ADMIN_ADMIN);
        storage::instance_set(&env, &StorageKey::PendingAdmin, &new_admin);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("adm_prop")),
            new_admin,
        );
    }

    /// Accept a pending admin transfer — second step of the two-step flow (#320).
    ///
    /// Completes the transfer initiated by `propose_admin_transfer`. Only the
    /// address nominated in `propose_admin_transfer` can call this.
    ///
    /// # Authorization
    /// Requires signature from the *pending* admin (not the current admin).
    ///
    /// # Panics
    /// * `"no pending admin transfer"` — called without a prior `propose_admin_transfer`
    pub fn accept_admin(env: Env) {
        storage::extend_instance_ttl(&env);

        let pending: Address = env
            .storage()
            .instance()
            .get(&StorageKey::PendingAdmin)
            .expect("no pending admin transfer");

        // Only the pending (new) admin signs acceptance — not the current admin(s).
        let context = String::from_str(&env, auth::msg::ACCEPT_ADMIN_PENDING);
        env.events().publish((symbol_short!("auth_req"),), context);
        pending.require_auth();

        let previous_admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("contract not initialized");

        storage::instance_set(&env, &StorageKey::Admin, &pending);
        env.storage().instance().remove(&StorageKey::PendingAdmin);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("adm_acc")),
            (previous_admin, pending),
        );
    }

    /// Unpause the contract — re-enables `distribute` and `distribute_secondary_royalties`.
    ///
    /// # Authorization
    /// Requires admin signature.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn unpause(env: Env) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::UNPAUSE_ADMIN);
        storage::instance_set(&env, &StorageKey::Paused, &false);
        let admin = Self::require_admin_address(&env);
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("unpaused")),
            admin,
        );
    }

    /// Replace the contract's executable WASM while preserving instance storage.
    ///
    /// The Wasm blob identified by `wasm_hash` must already be uploaded to the
    /// ledger. The upgrade takes effect after the current transaction completes;
    /// existing storage entries are unchanged.
    ///
    /// # Arguments
    /// * `wasm_hash` - SHA-256 hash of the uploaded replacement Wasm.
    ///
    /// # Authorization
    /// Requires admin signature.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn update_wasm(env: Env, wasm_hash: BytesN<32>) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::UPDATE_WASM_ADMIN);

        env.deployer().update_current_contract_wasm(wasm_hash);
    }

    /// Returns `true` if the contract is currently paused, `false` otherwise.
    /// Defaults to `false` before `pause` is ever called.
    pub fn is_paused(env: Env) -> bool {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::Paused)
            .unwrap_or(false)
    }

    /// Pause a single distribution operation without affecting the other (#749).
    ///
    /// Lets an admin pause only `distribute`/`distribute_with_override`
    /// (`OperationType::PrimaryDistribution`) or only
    /// `distribute_secondary_royalties` (`OperationType::SecondaryDistribution`)
    /// while the other operation keeps running. This is independent of, and
    /// layered on top of, the global `pause()` switch: calling the global
    /// `pause()` still blocks both operations regardless of this state, and
    /// this function does not change the global `Paused` flag.
    ///
    /// # Authorization
    /// Requires admin signature (same rules as `pause`/`unpause`).
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn pause_operation(env: Env, operation: OperationType) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::PAUSE_OPERATION_ADMIN);

        let key = Self::operation_pause_key(operation);
        storage::instance_set(&env, &key, &true);

        let admin = Self::require_admin_address(&env);
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("op_pause")),
            (admin, Self::operation_event_tag(operation)),
        );
    }

    /// Unpause a single distribution operation (#749). See `pause_operation`.
    ///
    /// # Authorization
    /// Requires admin signature.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn unpause_operation(env: Env, operation: OperationType) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::UNPAUSE_OPERATION_ADMIN);

        let key = Self::operation_pause_key(operation);
        storage::instance_set(&env, &key, &false);

        let admin = Self::require_admin_address(&env);
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("op_unpaus")),
            (admin, Self::operation_event_tag(operation)),
        );
    }

    /// Returns `true` if `operation` is currently paused (#749).
    ///
    /// This reflects only the per-operation pause state; it does not consult
    /// the global `Paused` flag. Callers that need "is this operation
    /// effectively blocked" should check both `is_paused()` and
    /// `is_operation_paused(operation)` — which is exactly what `distribute`,
    /// `distribute_with_override`, and `distribute_secondary_royalties` do
    /// internally.
    pub fn is_operation_paused(env: Env, operation: OperationType) -> bool {
        storage::extend_instance_ttl(&env);
        let key = Self::operation_pause_key(operation);
        env.storage().instance().get(&key).unwrap_or(false)
    }

    /// Maps an `OperationType` to its dedicated storage key.
    fn operation_pause_key(operation: OperationType) -> StorageKey {
        match operation {
            OperationType::PrimaryDistribution => StorageKey::PausedPrimary,
            OperationType::SecondaryDistribution => StorageKey::PausedSecondary,
        }
    }

    /// Short event-log tag identifying which operation a pause/unpause event
    /// applied to. Kept ASCII/short to fit `symbol_short!` constraints.
    fn operation_event_tag(operation: OperationType) -> soroban_sdk::Symbol {
        match operation {
            OperationType::PrimaryDistribution => symbol_short!("primary"),
            OperationType::SecondaryDistribution => symbol_short!("secondry"),
        }
    }

    /// Returns `true` if `operation` is currently blocked — by the
    /// emergency pause (#779), the global pause switch, or its own
    /// per-operation pause state (#749).
    fn is_blocked(env: &Env, operation: OperationType) -> bool {
        if Self::is_emergency_paused_flag(env) {
            return true;
        }

        let globally_paused: bool = env
            .storage()
            .instance()
            .get::<StorageKey, bool>(&StorageKey::Paused)
            .unwrap_or(false);
        if globally_paused {
            return true;
        }

        let key = Self::operation_pause_key(operation);
        env.storage().instance().get(&key).unwrap_or(false)
    }

    /// Raw emergency-pause flag read, shared by `is_blocked` and
    /// `batch_distribute` (#779).
    fn is_emergency_paused_flag(env: &Env) -> bool {
        env.storage()
            .instance()
            .get::<StorageKey, bool>(&StorageKey::EmergencyPaused)
            .unwrap_or(false)
    }

    /// Returns `true` if `initialize` has been called, `false` otherwise.
    ///
    /// Safe to call at any time — does not require initialization.
    /// Extends TTL on every call so the storage entry stays live.
    pub fn is_initialized(env: Env) -> bool {
        storage::extend_instance_ttl(&env);
        env.storage().instance().has(&StorageKey::Admin)
    }

    /// Returns the current contract admin address.
    ///
    /// Read-only view for integrators and frontends.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn get_admin(env: Env) -> Address {
        storage::extend_instance_ttl(&env);
        Self::require_admin_address(&env)
    }

    /// Returns the contract's current on-chain balance of `token`.
    ///
    /// # Arguments
    /// * `token` - The token contract address to query.
    pub fn get_balance(env: Env, token: Address) -> i128 {
        storage::extend_instance_ttl(&env);
        token::Client::new(&env, &token).balance(&env.current_contract_address())
    }

    /// Set the default recipient list for royalty distributions.
    ///
    /// This provides a fallback recipient list that can be used when no override
    /// list is supplied to distribute(). Useful for standard royalty splits that
    /// don't change frequently.
    ///
    /// # Authorization
    /// Requires admin signature.
    pub fn set_default_recipients(env: Env, recipients: Vec<Recipient>) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_DEFAULT_RECIPIENTS_ADMIN);
        Self::validate_default_recipient_basis_points(&env, &recipients);
        Self::validate_recipient_list(&env, &recipients);

        // DefaultRecipients uses persistent storage (#322)
        storage::persistent_set(&env, &StorageKey::DefaultRecipients, &recipients);

        env.events().publish(
            (symbol_short!("default"), symbol_short!("rcpt_set")),
            recipients.len(),
        );
    }

    /// Update the primary collaborator recipient list stored in persistent storage.
    ///
    /// Replaces `StorageKey::Collaborators` and `StorageKey::ShareMap` so the
    /// updated list survives ledger TTL and is returned by `get_recipients()`.
    ///
    /// # Authorization
    /// Requires admin signature.
    pub fn set_recipients(env: Env, recipients: Vec<Recipient>) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_RECIPIENTS_ADMIN);
        Self::validate_recipient_list(&env, &recipients);

        let mut collaborators: Vec<Address> = Vec::new(&env);
        let mut share_map: Map<Address, u32> = Map::new(&env);

        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            collaborators.push_back(recipient.address.clone());
            share_map.set(recipient.address.clone(), recipient.share);
        }

        // Collaborators and ShareMap use persistent storage (#322)
        storage::persistent_set(&env, &StorageKey::Collaborators, &collaborators);
        storage::persistent_set(&env, &StorageKey::ShareMap, &share_map);

        // Record a join date for any newly-added collaborator without
        // disturbing existing collaborators' tenure (#776) — replacing the
        // list here shouldn't reset an early adopter's incentive eligibility.
        let mut join_dates: Map<Address, u64> =
            storage::persistent_get::<Map<Address, u64>>(&env, &StorageKey::ContributorJoinDate)
                .unwrap_or(Map::new(&env));
        let now = env.ledger().timestamp();
        for addr in collaborators.iter() {
            if !join_dates.contains_key(addr.clone()) {
                join_dates.set(addr, now);
            }
        }
        storage::persistent_set(&env, &StorageKey::ContributorJoinDate, &join_dates);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("recip_set")),
            recipients.len(),
        );
    }

    /// Admin-only recovery of stuck token balances held by the contract.
    ///
    /// Transfers `amount` of `token` from the contract to the admin address.
    /// Use when funds remain after a partial distribution failure.
    ///
    /// # Authorization
    /// Requires admin signature.
    pub fn withdraw(env: Env, token: Address, amount: i128) {
        storage::extend_instance_ttl(&env);

        let admin = Self::require_admin_address(&env);

        Self::check_admin_auth(&env, auth::msg::WITHDRAW_ADMIN);

        if amount <= 0 {
            Self::fail(&env, ContractError::AmountNotPositive);
        }

        let token_client = token::Client::new(&env, &token);
        let balance = token_client.balance(&env.current_contract_address());
        if amount > balance {
            Self::fail(&env, ContractError::InsufficientBalance);
        }

        token_client.transfer(&env.current_contract_address(), &admin, &amount);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("withdraw")),
            (token, amount),
        );
    }

    /// Get the default recipient list.
    ///
    /// Returns the configured default recipient list, or an empty vec if none has been set.
    /// Safe to call before initialization or when no defaults are configured.
    pub fn get_default_recipients(env: Env) -> Vec<Recipient> {
        storage::extend_instance_ttl(&env);
        // DefaultRecipients uses persistent storage (#322)
        storage::persistent_get::<Vec<Recipient>>(&env, &StorageKey::DefaultRecipients)
            .unwrap_or(Vec::new(&env))
    }

    /// Distribute the full contract balance of `token` to recipients with override support.
    ///
    /// # Arguments
    /// * `token` - The token address to distribute (e.g., XLM or other Stellar asset)
    /// * `override_recipients` - Optional override recipient list. If provided, uses this
    ///   list instead of default recipients. If None/empty, falls back to default recipients
    ///   if configured, otherwise uses the original collaborator list.
    ///
    /// # Distribution Logic
    /// Each recipient receives: (total_amount * their_share) / 10,000
    /// The last recipient receives any remaining dust from integer division rounding.
    ///
    /// # Authorization
    /// Requires admin signature
    ///
    /// # Panics
    /// * `"recipients list cannot be empty"` — no recipients are configured
    /// * `ContractError::Underfunded` — contract has zero balance of the token
    /// * `"contract is paused"` — contract is currently paused
    pub fn distribute_with_override(env: Env, token: Address, override_recipients: Vec<Recipient>) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::DISTRIBUTE_OVERRIDE_ADMIN);

        // Emergency pause (#779) takes precedence and gets its own distinct
        // error so clients know `clear_emergency_pause` (not `unpause`) is
        // the way out. Otherwise blocked by either the global pause switch
        // or a primary-distribution-specific pause (#749) — global pause
        // always wins for backward compatibility.
        if Self::is_emergency_paused_flag(&env) {
            Self::fail(&env, ContractError::EmergencyContractPaused);
        }
        if Self::is_blocked(&env, OperationType::PrimaryDistribution) {
            Self::fail(&env, ContractError::ContractPaused);
        }

        let token_client = token::Client::new(&env, &token);
        let amount = token_client.balance(&env.current_contract_address());
        if amount == 0 {
            soroban_sdk::panic_with_error!(&env, ContractError::Underfunded);
        }

        // Anomaly detection (#779): a single distribution larger than the
        // configured threshold auto-trips the emergency pause instead of
        // completing. This returns normally (does not panic) — Soroban's
        // atomic execution model would roll back the pause flag itself
        // along with everything else in this call if it then panicked, so
        // the call must succeed as a no-op for the pause to durably persist.
        // The *next* call sees EmergencyPaused already set and is rejected
        // by the check above.
        if Self::trip_anomaly_pause_if_exceeded(&env, &token, amount) {
            return;
        }

        // Determine which recipient list to use
        let recipients_to_use: Vec<Recipient> = if !override_recipients.is_empty() {
            // Use override recipients if provided
            override_recipients
        } else {
            // Try to use default recipients (persistent storage), fall back to collaborators
            let defaults: Vec<Recipient> =
                storage::persistent_get::<Vec<Recipient>>(&env, &StorageKey::DefaultRecipients)
                    .unwrap_or(Vec::new(&env));

            if !defaults.is_empty() {
                defaults
            } else {
                // Fall back to original collaborator list (persistent storage)
                let collaborators: Vec<Address> =
                    storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
                        .expect("no collaborators");

                let share_map: Map<Address, u32> =
                    storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                        .expect("no share map");

                let mut recipients: Vec<Recipient> = Vec::new(&env);
                for addr in collaborators.iter() {
                    let share = share_map.get(addr.clone()).unwrap_or(0);
                    recipients.push_back(Recipient {
                        address: addr,
                        share,
                    });
                }
                recipients
            }
        };

        // Reuses the same checks as set_recipients/set_default_recipients (#713):
        // non-empty, within MAX_RECIPIENTS, no zero-share or duplicate-address
        // entries, and shares sum to 10,000. Runs before any state mutation or
        // token transfer below, so an invalid override_recipients list (or a
        // corrupted stored fallback) never partially distributes funds.
        Self::validate_recipient_list(&env, &recipients_to_use);

        let n = recipients_to_use.len();

        // Guard: each recipient must receive at least 1 stroop to avoid silent dust no-ops (#263).
        if amount < n as i128 {
            Self::fail(&env, ContractError::AmountTooSmall);
        }
        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;

        // Calculate payouts for all recipients except the last one
        for i in 0..(n - 1) {
            let recipient = recipients_to_use.get(i).unwrap();
            let payout = Self::checked_bps_amount(&env, amount, recipient.share);
            payouts.push_back((recipient.address.clone(), payout));
            total_calculated = total_calculated
                .checked_add(payout)
                .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));
        }

        // Last recipient receives the remainder to avoid dust loss.
        // Dust is bounded by (n - 1) stroops in the worst case.
        let last = recipients_to_use.get(n - 1).unwrap();
        payouts.push_back((
            last.address.clone(),
            amount
                .checked_sub(total_calculated)
                .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow)),
        ));

        for (addr, payout) in payouts.iter() {
            token_client.transfer(&env.current_contract_address(), &addr, &payout);
            env.events().publish(
                (symbol_short!("royalty"), symbol_short!("dist")),
                (addr, payout, token.clone(), symbol_short!("primary")),
            );
        }

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("dist_all")),
            (token, amount),
        );

        storage::instance_set(
            &env,
            &StorageKey::LastDistribution,
            &env.ledger().timestamp(),
        );

        // Increment distribute history counter with overflow safety
        let current_count: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::DistributeHistory)
            .unwrap_or(0);

        // Use saturating add to prevent overflow - will cap at u64::MAX
        let new_count = current_count.saturating_add(1);
        storage::instance_set(&env, &StorageKey::DistributeHistory, &new_count);
    }

    // #777: distribute()/distribute_with_override() treat any failed
    // transfer as fatal — the whole tx reverts, and per Soroban's atomic
    // execution model nothing from a reverted tx is ever observable
    // on-chain, not even events published earlier in the same call. A
    // transfer can fail for reasons outside this contract's control (a
    // classic-asset recipient missing a trustline, a frozen/deauthorized
    // account, an adversarial recipient contract), and today that one bad
    // recipient blocks payment to every other, uninvolved collaborator.
    // This function uses the token client's `try_transfer` so one failing
    // transfer doesn't sink the rest: successes commit, failures are
    // collected and returned; their share of the balance stays in the
    // contract (recover via `withdraw` or a retry through
    // `distribute_with_override`, which recomputes against the
    // then-current balance).
    /// Distribute the full contract balance of `token`, tolerating
    /// individual recipient transfer failures instead of aborting (#777).
    /// Same recipient resolution / per-recipient split as
    /// `distribute_with_override`. Emits `dist_strt` once up front,
    /// `dist` per successful transfer, `dist_fail` once if any failed, and
    /// `dist_all` (amount actually transferred) if any succeeded.
    /// `LastDistribution`/`get_distribute_count` update only on success.
    /// Requires admin signature. Panics like `distribute_with_override`
    /// for every check before the transfer loop; a per-recipient failure
    /// after that is recorded, not panicked on.
    ///
    /// Returns the list of recipient addresses whose transfer failed.
    pub fn distribute_resilient(
        env: Env,
        token: Address,
        override_recipients: Vec<Recipient>,
    ) -> Vec<Address> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::DISTRIBUTE_RESILIENT_ADMIN);

        if Self::is_blocked(&env, OperationType::PrimaryDistribution) {
            Self::fail(&env, ContractError::ContractPaused);
        }

        let token_client = token::Client::new(&env, &token);
        let amount = token_client.balance(&env.current_contract_address());
        if amount == 0 {
            Self::fail(&env, ContractError::Underfunded);
        }

        let recipients_to_use: Vec<Recipient> = if !override_recipients.is_empty() {
            override_recipients
        } else {
            let defaults: Vec<Recipient> =
                storage::persistent_get::<Vec<Recipient>>(&env, &StorageKey::DefaultRecipients)
                    .unwrap_or(Vec::new(&env));

            if !defaults.is_empty() {
                defaults
            } else {
                let collaborators: Vec<Address> =
                    storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
                        .expect("no collaborators");
                let share_map: Map<Address, u32> =
                    storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                        .expect("no share map");

                let mut recipients: Vec<Recipient> = Vec::new(&env);
                for addr in collaborators.iter() {
                    let share = share_map.get(addr.clone()).unwrap_or(0);
                    recipients.push_back(Recipient {
                        address: addr,
                        share,
                    });
                }
                recipients
            }
        };

        Self::validate_recipient_list(&env, &recipients_to_use);

        let n = recipients_to_use.len();
        if amount < n as i128 {
            Self::fail(&env, ContractError::AmountTooSmall);
        }

        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;
        for i in 0..(n - 1) {
            let recipient = recipients_to_use.get(i).unwrap();
            let payout = Self::checked_bps_amount(&env, amount, recipient.share);
            payouts.push_back((recipient.address.clone(), payout));
            total_calculated = total_calculated
                .checked_add(payout)
                .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));
        }
        let last = recipients_to_use.get(n - 1).unwrap();
        payouts.push_back((
            last.address.clone(),
            amount
                .checked_sub(total_calculated)
                .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow)),
        ));

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("dist_strt")),
            (token.clone(), amount, n as u32),
        );

        let mut failed: Vec<Address> = Vec::new(&env);
        let mut distributed: i128 = 0;
        let mut succeeded: u64 = 0;

        for (addr, payout) in payouts.iter() {
            match token_client.try_transfer(&env.current_contract_address(), &addr, &payout) {
                Ok(Ok(())) => {
                    succeeded += 1;
                    distributed = distributed
                        .checked_add(payout)
                        .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));
                    env.events().publish(
                        (symbol_short!("royalty"), symbol_short!("dist")),
                        (addr.clone(), payout, token.clone(), symbol_short!("primary")),
                    );
                }
                _ => {
                    failed.push_back(addr.clone());
                }
            }
        }

        if !failed.is_empty() {
            env.events().publish(
                (symbol_short!("royalty"), symbol_short!("dist_fail")),
                (token.clone(), failed.clone()),
            );
        }

        if succeeded > 0 {
            env.events().publish(
                (symbol_short!("royalty"), symbol_short!("dist_all")),
                (token, distributed),
            );

            storage::instance_set(
                &env,
                &StorageKey::LastDistribution,
                &env.ledger().timestamp(),
            );

            // Matches distribute_with_override's convention: +1 per call
            // (not per recipient), regardless of how many of this call's
            // transfers succeeded.
            let current_count: u64 = env
                .storage()
                .instance()
                .get(&StorageKey::DistributeHistory)
                .unwrap_or(0);
            storage::instance_set(
                &env,
                &StorageKey::DistributeHistory,
                &current_count.saturating_add(1),
            );
        }

        failed
    }

    /// Get the total number of successful royalty distributions.
    ///
    /// Returns a monotonically increasing counter that increments on every
    /// successful distribute() or distribute_with_override() call. Never decrements.
    /// Uses saturating arithmetic to prevent overflow (caps at u64::MAX).
    ///
    /// Safe to call at any time — returns 0 if no distributions have occurred.
    pub fn get_distribute_count(env: Env) -> u64 {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::DistributeHistory)
            .unwrap_or(0)
    }

    /// Distribute the full contract balance of `token` to all collaborators.
    ///
    /// # Arguments
    /// * `token` - The token address to distribute (e.g., XLM or other Stellar asset)
    ///
    /// # Distribution Logic
    /// Each collaborator receives: (total_amount * their_share) / 10,000
    /// The last collaborator receives any remaining dust from integer division rounding.
    ///
    /// # Authorization
    /// Requires admin signature
    ///
    /// # Panics
    /// * `"recipients list cannot be empty"` — no collaborators are configured
    /// * `ContractError::Underfunded` — contract has zero balance of the token
    /// * `"contract is paused"` — contract is currently paused
    pub fn distribute(env: Env, token: Address) {
        // Call the enhanced version with empty override for backward compatibility
        Self::distribute_with_override(env.clone(), token, Vec::new(&env));
    }

    /// Distribute royalties for multiple tokens in one transaction, using the
    /// same per-token payout logic as `distribute()`. Admin auth and the
    /// paused check happen once for the whole batch.
    ///
    /// # Arguments
    /// * `tokens` - Token addresses to distribute.
    ///
    /// # Authorization
    /// Requires admin signature (checked once for the entire batch).
    ///
    /// See [`ContractError`] for panic conditions (uninitialized, paused,
    /// empty recipients, zero balance, amount too small).
    pub fn batch_distribute(env: Env, tokens: Vec<Address>) {
        storage::extend_instance_ttl(&env);

        // Check admin auth once for the entire batch
        Self::check_admin_auth(&env, auth::msg::BATCH_DISTRIBUTE_ADMIN);

        // #744: bound the number of tokens processed per call — see
        // MAX_BATCH_TOKENS doc comment for why. Checked before the
        // (already-existing) paused check so an oversized batch fails fast
        // with a specific error rather than getting past the paused gate
        // and only then hitting resource limits mid-loop.
        if tokens.len() > MAX_BATCH_TOKENS {
            Self::fail(&env, ContractError::TooManyBatchTokens);
        }

        // Emergency pause (#779) takes precedence — see
        // distribute_with_override for why it's checked separately.
        if Self::is_emergency_paused_flag(&env) {
            Self::fail(&env, ContractError::EmergencyContractPaused);
        }

        // Check paused state once for the entire batch
        if env
            .storage()
            .instance()
            .get::<StorageKey, bool>(&StorageKey::Paused)
            .unwrap_or(false)
        {
            Self::fail(&env, ContractError::ContractPaused);
        }

        // Get recipient list once (reused for all distributions)
        let recipients_to_use: Vec<Recipient> = {
            let defaults: Vec<Recipient> =
                storage::persistent_get::<Vec<Recipient>>(&env, &StorageKey::DefaultRecipients)
                    .unwrap_or(Vec::new(&env));

            if !defaults.is_empty() {
                defaults
            } else {
                // Fall back to original collaborator list (persistent storage)
                let collaborators: Vec<Address> =
                    storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
                        .expect("no collaborators");

                let share_map: Map<Address, u32> =
                    storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                        .expect("no share map");

                let mut recipients: Vec<Recipient> = Vec::new(&env);
                for addr in collaborators.iter() {
                    let share = share_map.get(addr.clone()).unwrap_or(0);
                    recipients.push_back(Recipient {
                        address: addr,
                        share,
                    });
                }
                recipients
            }
        };

        if recipients_to_use.is_empty() {
            Self::fail(&env, ContractError::EmptyRecipients);
        }

        // Validate shares sum to 10,000 (once for all distributions)
        let mut total_shares: u32 = 0;
        for i in 0..recipients_to_use.len() {
            total_shares = Self::checked_add_share_total(
                &env,
                total_shares,
                recipients_to_use.get(i).unwrap().share,
            );
        }
        if total_shares != 10_000 {
            Self::fail(&env, ContractError::InvalidShareTotal);
        }

        let n = recipients_to_use.len();

        // Process each token distribution
        for token in tokens.iter() {
            let token_client = token::Client::new(&env, &token);
            let amount = token_client.balance(&env.current_contract_address());

            // Anomaly detection (#779) — see distribute_with_override for
            // why this returns normally instead of panicking on trip. Any
            // earlier tokens in this same batch that already transferred
            // stay transferred (this call is not reverting); the counter/
            // timestamp update below is skipped for the whole batch,
            // consistent with treating a tripped batch as not a normal
            // completed distribution.
            if Self::trip_anomaly_pause_if_exceeded(&env, &token, amount) {
                return;
            }

            if amount == 0 {
                Self::fail(&env, ContractError::NoBalance);
            }

            // Guard: each recipient must receive at least 1 stroop
            if amount < n as i128 {
                Self::fail(&env, ContractError::AmountTooSmall);
            }

            let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
            let mut total_calculated: i128 = 0;

            // Calculate payouts for all recipients except the last one
            for i in 0..(n - 1) {
                let recipient = recipients_to_use.get(i).unwrap();
                let payout = Self::checked_bps_amount(&env, amount, recipient.share);
                payouts.push_back((recipient.address.clone(), payout));
                total_calculated = total_calculated
                    .checked_add(payout)
                    .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));
            }

            // Last recipient receives the remainder to avoid dust loss
            let last = recipients_to_use.get(n - 1).unwrap();
            payouts.push_back((
                last.address.clone(),
                amount
                    .checked_sub(total_calculated)
                    .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow)),
            ));

            // Execute transfers for this token
            for (addr, payout) in payouts.iter() {
                token_client.transfer(&env.current_contract_address(), &addr, &payout);
                env.events().publish(
                    (symbol_short!("royalty"), symbol_short!("dist")),
                    (addr, payout, token.clone(), symbol_short!("batch")),
                );
            }

            // Emit distribution event for this token
            env.events().publish(
                (symbol_short!("royalty"), symbol_short!("dist_all")),
                (token.clone(), amount),
            );
        }

        // Update distribution timestamp and counter once for the batch
        storage::instance_set(
            &env,
            &StorageKey::LastDistribution,
            &env.ledger().timestamp(),
        );

        let current_count: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::DistributeHistory)
            .unwrap_or(0);

        // Increment by the number of tokens distributed
        let new_count = current_count.saturating_add(tokens.len() as u64);
        storage::instance_set(&env, &StorageKey::DistributeHistory, &new_count);

        // Emit batch completion event
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("batch")),
            tokens.len(),
        );
    }

    /// Record a secondary royalty payment transferred from a resale.
    ///
    /// Pulls `royalty_amount` of `token` from `from` into the contract's
    /// secondary pool via `transfer_from`. The caller must have pre-approved
    /// the contract as a spender for at least `royalty_amount`.
    ///
    /// # Arguments
    /// * `token` - Token used for the royalty payment.
    /// * `from` - Address paying the royalty (typically the marketplace or buyer).
    /// * `royalty_amount` - Amount in token's smallest unit (e.g., stroops for XLM).
    ///
    /// # Authorization
    /// Requires signature from `from`.
    pub fn record_secondary_royalty(env: Env, token: Address, from: Address, royalty_amount: i128) {
        storage::extend_instance_ttl(&env);
        auth::require_payer(&env, &from, auth::msg::RECORD_SECONDARY_PAYER);

        // #744: reject non-positive amounts before any transfer or state
        // change. A zero amount would be a wasted no-op transfer; a negative
        // amount would silently shrink the tracked secondary pool without
        // moving any tokens (the token contract's own transfer_from would
        // likely reject a negative amount too, but that's not guaranteed
        // for every token implementation, and this check fails fast with a
        // clear, contract-specific error either way).
        if royalty_amount <= 0 {
            Self::fail(&env, ContractError::RoyaltyAmountNotPositive);
        }

        let token_client = token::Client::new(&env, &token);

        token_client.transfer_from(
            &env.current_contract_address(),
            &from,
            &env.current_contract_address(),
            &royalty_amount,
        );

        let current_pool: i128 = env
            .storage()
            .instance()
            .get(&StorageKey::SecondaryPool)
            .unwrap_or(0);

        let new_pool = current_pool
            .checked_add(royalty_amount)
            .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));

        storage::instance_set(&env, &StorageKey::SecondaryPool, &new_pool);

        storage::instance_set(&env, &StorageKey::SecondaryToken, &token);

        // Activity incentive tracking (#776): a collaborator engaging with
        // the contract by recording secondary royalty payments earns
        // activity credit toward the incentive bonus. `from` is often a
        // marketplace/reseller rather than a collaborator, so this only
        // counts when `from` is itself a registered collaborator.
        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .unwrap_or(Map::new(&env));
        if share_map.contains_key(from.clone()) {
            let mut activity: Map<Address, u32> = storage::persistent_get::<Map<Address, u32>>(
                &env,
                &StorageKey::ContributorActivityCount,
            )
            .unwrap_or(Map::new(&env));
            let count = activity.get(from.clone()).unwrap_or(0).saturating_add(1);
            activity.set(from, count);
            storage::persistent_set(&env, &StorageKey::ContributorActivityCount, &activity);
        }
    }

    /// Distribute all accumulated secondary royalties to collaborators.
    ///
    /// Splits the entire secondary pool proportionally by basis-point shares.
    /// Resets the pool to zero after distribution. The last collaborator absorbs
    /// any integer-division dust (bounded by `n - 1` stroops).
    ///
    /// # Authorization
    /// Requires admin signature.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    /// * `"contract is paused"` — contract is currently paused
    /// * `"no secondary royalties to distribute"` — pool is empty
    /// * `"no secondary token set"` — no royalty has ever been recorded
    /// * `"total shares must sum to 10000"` — share map does not total 100%
    /// * `"pool exceeds contract balance"` — pool accounting is inconsistent
    pub fn distribute_secondary_royalties(env: Env) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::DISTRIBUTE_SECONDARY_ADMIN);

        // Emergency pause (#779) takes precedence — see distribute_with_override
        // for why it's checked separately from the general block below.
        // Otherwise blocked by either the global pause switch or a
        // secondary-distribution-specific pause (#749) — global pause
        // always wins for backward compatibility.
        if Self::is_emergency_paused_flag(&env) {
            Self::fail(&env, ContractError::EmergencyContractPaused);
        }
        if Self::is_blocked(&env, OperationType::SecondaryDistribution) {
            Self::fail(&env, ContractError::ContractPaused);
        }

        if Self::get_total_shares(env.clone()) != 10_000 {
            Self::fail(&env, ContractError::InvalidShareTotal);
        }

        let pool: i128 = env
            .storage()
            .instance()
            .get(&StorageKey::SecondaryPool)
            .unwrap_or(0);

        if pool == 0 {
            Self::fail(&env, ContractError::NoSecondaryRoyalties);
        }

        let token: Address = env
            .storage()
            .instance()
            .get(&StorageKey::SecondaryToken)
            .unwrap_or_else(|| Self::fail(&env, ContractError::NoSecondaryToken));

        // Anomaly detection (#779) — see distribute_with_override for why
        // this returns normally instead of panicking on trip.
        if Self::trip_anomaly_pause_if_exceeded(&env, &token, pool) {
            return;
        }

        let token_client = token::Client::new(&env, &token);
        let balance = token_client.balance(&env.current_contract_address());

        if pool > balance {
            Self::fail(&env, ContractError::PoolExceedsBalance);
        }

        // Collaborators and ShareMap from persistent storage (#322)
        let collaborators: Vec<Address> =
            storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
                .expect("no collaborators");

        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .expect("no share map");

        let n = collaborators.len();
        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;

        for i in 0..(n - 1) {
            let addr = collaborators.get(i).unwrap();
            let share = share_map.get(addr.clone()).unwrap_or(0);
            let payout = Self::checked_bps_amount(&env, pool, share);
            payouts.push_back((addr, payout));
            total_calculated = total_calculated
                .checked_add(payout)
                .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));
        }

        // Last collaborator receives the remainder. Dust bounded by (n - 1) stroops.
        let last = collaborators.get(n - 1).unwrap();
        payouts.push_back((
            last,
            pool.checked_sub(total_calculated)
                .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow)),
        ));

        for (addr, payout) in payouts.iter() {
            token_client.transfer(&env.current_contract_address(), &addr, &payout);
            env.events().publish(
                (symbol_short!("royalty"), symbol_short!("sec_pay")),
                (addr, payout, token.clone(), symbol_short!("secondary")),
            );
        }

        storage::instance_set(&env, &StorageKey::SecondaryPool, &0_i128);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("sec_dist")),
            (token, pool),
        );

        storage::instance_set(
            &env,
            &StorageKey::LastSecondaryDistribution,
            &env.ledger().timestamp(),
        );
    }

    /// Calculate and return the royalty amount for a given secondary sale price.
    ///
    /// This is a pure read function — it does not transfer tokens or modify state.
    /// Use it to preview the royalty before calling `record_secondary_royalty`.
    ///
    /// # Arguments
    /// * `sale_price` - The resale price in token's smallest unit (must be > 0).
    ///
    /// # Returns
    /// `sale_price * royalty_rate / 10_000`. Returns 0 if no rate has been set.
    ///
    /// # Panics
    /// * `"sale price must be positive"` — `sale_price <= 0`
    pub fn record_secondary_sale(env: Env, sale_price: i128) -> i128 {
        storage::extend_instance_ttl(&env);

        if sale_price <= 0 {
            Self::fail(&env, ContractError::SalePriceNotPositive);
        }

        let rate: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::RoyaltyRate)
            .unwrap_or(0);

        Self::checked_bps_amount(&env, sale_price, rate)
    }

    /// Returns the current secondary royalty rate in basis points (0–10,000).
    /// Returns 0 if `set_royalty_rate` has never been called.
    pub fn get_royalty_rate(env: Env) -> u32 {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::RoyaltyRate)
            .unwrap_or(0)
    }

    /// Returns all recipients as an ordered list of (address, share) pairs.
    ///
    /// Each entry contains the collaborator's address and their basis-point share.
    /// Preserves the insertion order from `initialize`. Returns an empty vec if
    /// called before initialization.
    pub fn get_recipients(env: Env) -> Vec<Recipient> {
        storage::extend_instance_ttl(&env);

        // Collaborators and ShareMap from persistent storage (#322)
        let collaborators: Vec<Address> =
            storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
                .unwrap_or(Vec::new(&env));

        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .unwrap_or(Map::new(&env));

        let mut recipients: Vec<Recipient> = Vec::new(&env);
        for addr in collaborators.iter() {
            let share = share_map.get(addr.clone()).unwrap_or(0);
            recipients.push_back(Recipient {
                address: addr,
                share,
            });
        }
        recipients
    }

    /// Returns the contract's semantic version string (set from [`VERSION`] at
    /// initialization time).
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn get_version(env: Env) -> String {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::ContractVersion)
            .unwrap_or_else(|| Self::fail(&env, ContractError::NotInitialized))
    }

    /// Returns the basis-point share for a registered collaborator.
    ///
    /// # Arguments
    /// * `collaborator` - Address to look up.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    /// * `"collaborator not found"` — address is not a registered collaborator
    pub fn get_share(env: Env, collaborator: Address) -> u32 {
        storage::extend_instance_ttl(&env);
        // ShareMap from persistent storage (#322)
        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .expect("contract not initialized");

        share_map
            .get(collaborator)
            .unwrap_or_else(|| Self::fail(&env, ContractError::CollaboratorNotFound))
    }

    /// Update a collaborator's share allocation.
    ///
    /// # Authorization
    /// Requires admin signature
    pub fn update_share(env: Env, collaborator: Address, new_share: u32) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::UPDATE_SHARE_ADMIN);

        // ShareMap from persistent storage (#322)
        let mut share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .expect("contract not initialized");

        if !share_map.contains_key(collaborator.clone()) {
            Self::fail(&env, ContractError::CollaboratorNotFound);
        }

        let old_share = share_map.get(collaborator.clone()).unwrap();
        let current_total = Self::get_total_shares(env.clone());
        let new_total = current_total
            .checked_sub(old_share)
            .and_then(|remaining| remaining.checked_add(new_share))
            .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));

        if new_total != 10_000 {
            Self::fail(&env, ContractError::InvalidUpdatedShareTotal);
        }

        if new_share == 0 {
            Self::fail(&env, ContractError::ZeroShare);
        }

        share_map.set(collaborator.clone(), new_share);
        storage::persistent_set(&env, &StorageKey::ShareMap, &share_map);

        env.events().publish(
            (symbol_short!("share"), symbol_short!("updated")),
            (collaborator, new_share),
        );
    }

    /// Returns true if the given address is a registered collaborator.
    ///
    /// Safe to call before initialization — returns `false` rather than panicking.
    ///
    /// # Arguments
    /// * `addr` - Address to check.
    pub fn is_collaborator(env: Env, addr: Address) -> bool {
        storage::extend_instance_ttl(&env);
        // ShareMap from persistent storage (#322)
        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .unwrap_or(Map::new(&env));

        share_map.contains_key(addr)
    }

    /// Returns the number of registered collaborators.
    /// Returns 0 if called before initialization.
    pub fn collaborator_count(env: Env) -> u32 {
        storage::extend_instance_ttl(&env);
        // Collaborators from persistent storage (#322)
        let collaborators: Vec<Address> =
            storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
                .unwrap_or(Vec::new(&env));
        collaborators.len()
    }

    /// Returns the ordered list of all registered collaborator addresses.
    /// Returns an empty vec if called before initialization.
    pub fn get_collaborators(env: Env) -> Vec<Address> {
        storage::extend_instance_ttl(&env);
        // Collaborators from persistent storage (#322)
        storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
            .unwrap_or(Vec::new(&env))
    }

    /// Returns the full share map (Address → basis points) in a single call.
    pub fn get_all_shares(env: Env) -> Map<Address, u32> {
        storage::extend_instance_ttl(&env);
        // ShareMap from persistent storage (#322)
        storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
            .unwrap_or(Map::new(&env))
    }

    /// Returns the current size of the secondary royalty pool (undistributed amount).
    /// Returns 0 if no royalties have been recorded yet.
    pub fn get_secondary_pool(env: Env) -> i128 {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::SecondaryPool)
            .unwrap_or(0)
    }

    /// Returns the timestamp of the last primary distribution, or None if never distributed.
    pub fn get_last_distribution(env: Env) -> Option<u64> {
        storage::extend_instance_ttl(&env);
        env.storage().instance().get(&StorageKey::LastDistribution)
    }

    /// Returns the timestamp of the last secondary distribution, or None if never distributed.
    pub fn get_last_secondary_distribution(env: Env) -> Option<u64> {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::LastSecondaryDistribution)
    }

    /// Returns the sum of all collaborator basis-point shares.
    ///
    /// Under normal operation this always returns 10,000. Useful for
    /// pre-flight validation before calling `distribute`.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn get_total_shares(env: Env) -> u32 {
        storage::extend_instance_ttl(&env);
        // ShareMap from persistent storage (#322)
        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .expect("contract not initialized");

        let mut total = 0;
        for item in share_map.iter() {
            total = Self::checked_add_share_total(&env, total, item.1);
        }
        total
    }

    /// Configure a multi-sig admin list and signing threshold (#321).
    ///
    /// Once set, all sensitive functions require the first `threshold` addresses
    /// in `admins` to authorize each call. The single-step `admin_transfer` is
    /// disabled when this is active — use `propose_admin_transfer` instead.
    ///
    /// # Arguments
    /// * `admins` - Ordered list of admin addresses (max 10).
    /// * `threshold` - Number of admins that must sign (1 ≤ threshold ≤ admins.len()).
    ///
    /// # Authorization
    /// Requires current admin (or multi-sig threshold) signature.
    pub fn set_admins(env: Env, admins: Vec<Address>, threshold: u32) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_ADMINS_ADMIN);

        if admins.is_empty() {
            panic!("admin list cannot be empty");
        }
        if admins.len() > MAX_ADMIN_LIST {
            Self::fail(&env, ContractError::InputTooLarge);
        }
        if threshold < 1 {
            panic!("threshold must be at least 1");
        }
        if threshold > admins.len() as u32 {
            panic!("threshold cannot exceed admin count");
        }

        // Check for duplicate addresses
        let mut seen: Vec<Address> = Vec::new(&env);
        for i in 0..admins.len() {
            let addr = admins.get(i).unwrap();
            for j in 0..seen.len() {
                if seen.get(j).unwrap() == addr {
                    panic!("duplicate admin address");
                }
            }
            seen.push_back(addr);
        }

        storage::instance_set(&env, &StorageKey::AdminList, &admins);
        storage::instance_set(&env, &StorageKey::AdminThreshold, &threshold);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("adms_set")),
            (admins.len(), threshold),
        );
    }

    /// Returns the configured multi-sig admin list, or an empty vec if not set.
    pub fn get_admins(env: Env) -> Vec<Address> {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::AdminList)
            .unwrap_or(Vec::new(&env))
    }


    // #776: optional contributor reward incentives. Disabled by default —
    // enabling changes payout shares, so it's an explicit admin opt-in per
    // contract, not a forced default. Two components, each independently
    // bounded, feed a per-collaborator bonus (in basis points):
    //   - an early-adopter bonus while within EARLY_ADOPTER_WINDOW_SECS of
    //     their join date (recorded at `initialize`/`set_recipients`);
    //   - an activity bonus based on how many secondary-royalty payments
    //     they've personally recorded via `record_secondary_royalty` — the
    //     closest existing signal of a collaborator actively engaging with
    //     the contract, since `distribute`-side calls are admin-only and
    //     wouldn't distinguish which collaborator triggered them under
    //     multi-sig.
    // Each collaborator's combined bonus is capped at
    // MAX_INDIVIDUAL_INCENTIVE_BPS; the sum across all collaborators is
    // additionally capped at MAX_TOTAL_INCENTIVE_BPS, scaling every
    // individual bonus down proportionally if needed. The bonus pool is
    // funded by shrinking every collaborator's base share by the same
    // factor, so the adjusted list always sums to exactly 10,000 basis
    // points — see `calculate_incentive_shares`.

    /// Enable or disable incentive-adjusted distribution (#776). Disabled by
    /// default. While disabled, `calculate_incentive_shares`
    /// returns the plain recipient list unchanged.
    ///
    /// # Authorization
    /// Requires admin signature.
    pub fn set_incentives_enabled(env: Env, enabled: bool) {
        storage::extend_instance_ttl(&env);
        Self::check_admin_auth(&env, auth::msg::SET_INCENTIVES_ENABLED_ADMIN);
        storage::instance_set(&env, &StorageKey::IncentivesEnabled, &enabled);
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("incn_set")),
            enabled,
        );
    }

    /// Returns whether incentive-adjusted distribution is enabled.
    pub fn is_incentives_enabled(env: Env) -> bool {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::IncentivesEnabled)
            .unwrap_or(false)
    }

    /// Returns a collaborator's recorded join date, or `None` if they have
    /// never been a collaborator on this contract.
    pub fn get_contributor_join_date(env: Env, collaborator: Address) -> Option<u64> {
        storage::extend_instance_ttl(&env);
        let join_dates: Map<Address, u64> =
            storage::persistent_get::<Map<Address, u64>>(&env, &StorageKey::ContributorJoinDate)
                .unwrap_or(Map::new(&env));
        join_dates.get(collaborator)
    }

    /// Returns how many secondary-royalty payments a collaborator has
    /// personally recorded via `record_secondary_royalty`. Returns 0 if none.
    pub fn get_contributor_activity_count(env: Env, collaborator: Address) -> u32 {
        storage::extend_instance_ttl(&env);
        let activity: Map<Address, u32> = storage::persistent_get::<Map<Address, u32>>(
            &env,
            &StorageKey::ContributorActivityCount,
        )
        .unwrap_or(Map::new(&env));
        activity.get(collaborator).unwrap_or(0)
    }

    /// A collaborator's incentive bonus in basis points, before the
    /// aggregate `MAX_TOTAL_INCENTIVE_BPS` scale-down.
    fn incentive_bonus_bps(env: &Env, addr: &Address, now: u64) -> u32 {
        let mut bonus: u32 = 0;

        let join_dates: Map<Address, u64> =
            storage::persistent_get::<Map<Address, u64>>(env, &StorageKey::ContributorJoinDate)
                .unwrap_or(Map::new(env));
        if let Some(join_date) = join_dates.get(addr.clone()) {
            if now.saturating_sub(join_date) <= EARLY_ADOPTER_WINDOW_SECS {
                bonus = bonus.saturating_add(EARLY_ADOPTER_BONUS_BPS);
            }
        }

        let activity: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(env, &StorageKey::ContributorActivityCount)
                .unwrap_or(Map::new(env));
        let count = activity.get(addr.clone()).unwrap_or(0);
        let steps = (count / ACTIVITY_BONUS_STEP).min(ACTIVITY_BONUS_MAX_STEPS);
        bonus = bonus.saturating_add(steps.saturating_mul(ACTIVITY_BONUS_BPS_PER_STEP));

        bonus.min(MAX_INDIVIDUAL_INCENTIVE_BPS)
    }

    /// Returns the recipient list with incentive bonuses applied (#776), or
    /// the plain `get_recipients()` list unchanged if incentives are
    /// disabled or nobody currently qualifies for a bonus. Named
    /// `calculate_incentive_shares` rather than the
    /// `calculate_distribution_with_incentives` name #776 suggests —
    /// Soroban caps contract function names at 32 characters.
    ///
    /// Bonuses are funded by shrinking every collaborator's base share by
    /// the same factor, so the returned list always sums to exactly 10,000
    /// basis points. Pure read — does not transfer tokens or modify state.
    pub fn calculate_incentive_shares(env: Env) -> Vec<Recipient> {
        storage::extend_instance_ttl(&env);

        let base = Self::get_recipients(env.clone());
        let enabled: bool = env
            .storage()
            .instance()
            .get(&StorageKey::IncentivesEnabled)
            .unwrap_or(false);
        if !enabled || base.is_empty() {
            return base;
        }

        let now = env.ledger().timestamp();
        let n = base.len();
        let mut raw_bonuses: Vec<u32> = Vec::new(&env);
        let mut total_bonus: u32 = 0;
        for r in base.iter() {
            let b = Self::incentive_bonus_bps(&env, &r.address, now);
            raw_bonuses.push_back(b);
            total_bonus = total_bonus.saturating_add(b);
        }

        if total_bonus == 0 {
            return base;
        }

        let effective_total = total_bonus.min(MAX_TOTAL_INCENTIVE_BPS);
        let mut scaled_bonuses: Vec<u32> = Vec::new(&env);
        let mut scaled_sum: u32 = 0;
        for i in 0..n {
            let raw = raw_bonuses.get(i).unwrap();
            let scaled = if total_bonus == effective_total {
                raw
            } else {
                ((raw as u64) * (effective_total as u64) / (total_bonus as u64)) as u32
            };
            scaled_bonuses.push_back(scaled);
            scaled_sum = scaled_sum.saturating_add(scaled);
        }

        // scaled_sum <= effective_total <= MAX_TOTAL_INCENTIVE_BPS (2,000),
        // so this can never underflow.
        let pool_bps = 10_000u32 - scaled_sum;

        let mut adjusted: Vec<Recipient> = Vec::new(&env);
        let mut assigned_total: u32 = 0;
        for i in 0..(n - 1) {
            let r = base.get(i).unwrap();
            let shrunk_base = ((r.share as u64) * (pool_bps as u64) / 10_000) as u32;
            let new_share = shrunk_base.saturating_add(scaled_bonuses.get(i).unwrap());
            assigned_total = assigned_total.saturating_add(new_share);
            adjusted.push_back(Recipient {
                address: r.address,
                share: new_share,
            });
        }

        // Last recipient absorbs the rounding remainder, same convention
        // used throughout distribute()/distribute_with_override() for
        // payout dust — guarantees the list always sums to exactly 10,000.
        let last = base.get(n - 1).unwrap();
        let last_share = 10_000u32
            .checked_sub(assigned_total)
            .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));
        adjusted.push_back(Recipient {
            address: last.address,
            share: last_share,
        });

        adjusted
    }

    /// Distribute the full contract balance of `token` using
    /// incentive-adjusted shares (#776). Identical payout mechanics to
    /// `distribute_with_override` (share * amount / 10,000, last recipient
    /// absorbs dust), but computed from
    /// `calculate_incentive_shares` instead of the plain
    /// recipient list.
    ///
    /// # Authorization
    /// Requires admin signature.
    ///
    /// # Panics
    /// Same conditions as `distribute_with_override`.
    pub fn distribute_with_incentives(env: Env, token: Address) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::DISTRIBUTE_INCENTIVES_ADMIN);

        let recipients = Self::calculate_incentive_shares(env.clone());
        Self::execute_distribution(env, token, recipients);
    }

    /// Shared payout loop for `distribute_with_override` and
    /// `distribute_with_incentives` (#776): validates `recipients`, splits
    /// the full token balance proportionally (last recipient absorbs
    /// dust), transfers to each, and updates distribution bookkeeping.
    fn execute_distribution(env: Env, token: Address, recipients: Vec<Recipient>) {
        if Self::is_blocked(&env, OperationType::PrimaryDistribution) {
            Self::fail(&env, ContractError::ContractPaused);
        }

        let token_client = token::Client::new(&env, &token);
        let amount = token_client.balance(&env.current_contract_address());
        if amount == 0 {
            soroban_sdk::panic_with_error!(&env, ContractError::Underfunded);
        }

        Self::validate_recipient_list(&env, &recipients);

        let n = recipients.len();
        if amount < n as i128 {
            Self::fail(&env, ContractError::AmountTooSmall);
        }

        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;
        for i in 0..(n - 1) {
            let recipient = recipients.get(i).unwrap();
            let payout = Self::checked_bps_amount(&env, amount, recipient.share);
            payouts.push_back((recipient.address.clone(), payout));
            total_calculated = total_calculated
                .checked_add(payout)
                .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));
        }
        let last = recipients.get(n - 1).unwrap();
        payouts.push_back((
            last.address.clone(),
            amount
                .checked_sub(total_calculated)
                .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow)),
        ));

        for (addr, payout) in payouts.iter() {
            token_client.transfer(&env.current_contract_address(), &addr, &payout);
            env.events().publish(
                (symbol_short!("royalty"), symbol_short!("dist")),
                (addr, payout, token.clone(), symbol_short!("primary")),
            );
        }

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("dist_all")),
            (token, amount),
        );

        storage::instance_set(
            &env,
            &StorageKey::LastDistribution,
            &env.ledger().timestamp(),
        );

        let current_count: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::DistributeHistory)
            .unwrap_or(0);
        storage::instance_set(
            &env,
            &StorageKey::DistributeHistory,
            &current_count.saturating_add(1),
        );
    }

    /// Initiate a timelocked admin rotation (#778).
    ///
    /// Starts the configurable timelock (48 hours by default, see
    /// `set_admin_rotation_timelock`); the rotation only takes effect once
    /// `finalize_admin_rotation` is called after it elapses. Calling this
    /// again before finalization replaces any existing pending rotation
    /// (there is only ever one pending rotation at a time).
    ///
    /// # Authorization
    /// Requires current admin (or multi-sig threshold) signature.
    pub fn initiate_admin_rotation(env: Env, new_admin: Address) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::INITIATE_ADMIN_ROTATION_ADMIN);

        let initiated_at = env.ledger().timestamp();
        let rotation = AdminRotation {
            new_admin: new_admin.clone(),
            initiated_at,
        };
        storage::instance_set(&env, &StorageKey::PendingAdminRotation, &rotation);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("rot_init")),
            (new_admin, initiated_at),
        );
    }

    /// Cancel a pending admin rotation (#778). Reverts to no pending rotation;
    /// the current admin is unaffected.
    ///
    /// # Authorization
    /// Requires current admin (or multi-sig threshold) signature — i.e. only
    /// the admin the rotation would replace can cancel it.
    ///
    /// # Panics
    /// * `ContractError::NoPendingAdminRotation` — no rotation is pending
    pub fn cancel_admin_rotation(env: Env) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::CANCEL_ADMIN_ROTATION_ADMIN);

        let rotation: AdminRotation = env
            .storage()
            .instance()
            .get(&StorageKey::PendingAdminRotation)
            .unwrap_or_else(|| Self::fail(&env, ContractError::NoPendingAdminRotation));

        env.storage()
            .instance()
            .remove(&StorageKey::PendingAdminRotation);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("rot_cncl")),
            rotation.new_admin,
        );
    }

    /// Complete a pending admin rotation once its timelock has elapsed (#778).
    ///
    /// Permissionless by design: the outcome (which address becomes admin)
    /// was already fixed and authorized at `initiate_admin_rotation` time, so
    /// finalization only needs to enforce that the timelock has elapsed —
    /// there is no bypass, and anyone (e.g. the new admin themselves, or an
    /// automation script) can trigger it once the deadline passes. The
    /// current admin can still prevent it any time before this call
    /// succeeds via `cancel_admin_rotation`.
    ///
    /// # Panics
    /// * `ContractError::NoPendingAdminRotation` — no rotation is pending
    /// * `ContractError::AdminRotationTimelockNotElapsed` — called too early
    pub fn finalize_admin_rotation(env: Env) {
        storage::extend_instance_ttl(&env);

        let rotation: AdminRotation = env
            .storage()
            .instance()
            .get(&StorageKey::PendingAdminRotation)
            .unwrap_or_else(|| Self::fail(&env, ContractError::NoPendingAdminRotation));

        let timelock = Self::admin_rotation_timelock(&env);
        let ready_at = rotation
            .initiated_at
            .checked_add(timelock)
            .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));

        if env.ledger().timestamp() < ready_at {
            Self::fail(&env, ContractError::AdminRotationTimelockNotElapsed);
        }

        let previous_admin = Self::require_admin_address(&env);
        storage::instance_set(&env, &StorageKey::Admin, &rotation.new_admin);
        env.storage()
            .instance()
            .remove(&StorageKey::PendingAdminRotation);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("rot_fin")),
            (previous_admin, rotation.new_admin),
        );
    }

    /// Returns the pending admin rotation, or `None` if none is in progress.
    pub fn get_pending_admin_rotation(env: Env) -> Option<AdminRotation> {
        storage::extend_instance_ttl(&env);
        env.storage().instance().get(&StorageKey::PendingAdminRotation)
    }

    /// Configure the admin rotation timelock duration, in seconds (#778).
    ///
    /// Bounded to `[MIN_ADMIN_ROTATION_TIMELOCK, MAX_ADMIN_ROTATION_TIMELOCK]`
    /// (1 hour – 30 days) so it can't be configured away to something that
    /// provides no real protection, or up to something impractically long.
    ///
    /// # Authorization
    /// Requires current admin (or multi-sig threshold) signature.
    ///
    /// # Panics
    /// * `ContractError::InvalidTimelockDuration` — `seconds` outside the bounds
    pub fn set_admin_rotation_timelock(env: Env, seconds: u64) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_ADMIN_ROTATION_TIMELOCK_ADMIN);

        if seconds < MIN_ADMIN_ROTATION_TIMELOCK || seconds > MAX_ADMIN_ROTATION_TIMELOCK {
            Self::fail(&env, ContractError::InvalidTimelockDuration);
        }

        storage::instance_set(&env, &StorageKey::AdminRotationTimelock, &seconds);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("rot_tlck")),
            seconds,
        );
    }

    /// Returns the currently configured admin rotation timelock, in seconds.
    /// Defaults to [`DEFAULT_ADMIN_ROTATION_TIMELOCK`] (48 hours) until
    /// explicitly changed via `set_admin_rotation_timelock`.
    pub fn get_admin_rotation_timelock(env: Env) -> u64 {
        storage::extend_instance_ttl(&env);
        Self::admin_rotation_timelock(&env)
    }

    fn admin_rotation_timelock(env: &Env) -> u64 {
        env.storage()
            .instance()
            .get(&StorageKey::AdminRotationTimelock)
            .unwrap_or(DEFAULT_ADMIN_ROTATION_TIMELOCK)
    }

    // #779: emergency pause + anomaly detection. Distinct from, and
    // stronger than, the existing pause()/unpause() and pause_operation()/
    // unpause_operation() (#749) switches — see is_blocked, which checks
    // this flag first. Two ways to trip it:
    //   - manually, via trigger_emergency_pause (same admin authorization
    //     as routine operations — raising the alarm is the conservative,
    //     low-risk direction);
    //   - automatically, when a single distribution amount exceeds an
    //     admin-configured anomaly threshold (set_anomaly_threshold).
    // Clearing it requires a *stronger* bar than routine operations: when
    // multi-sig is configured, every admin in the list must authorize (not
    // just AdminThreshold of them) — see require_emergency_clear_auth.
    //
    // A note on why the automatic trip doesn't panic: Soroban transactions
    // are atomic, so a call that panics rolls back every storage write it
    // made, including the EmergencyPaused flag itself. `distribute`-family
    // functions therefore set the flag and return normally (no transfers,
    // no error) when an anomaly trips; the *next* call sees the flag
    // already durably set and is rejected outright.

    /// Configure the maximum single-distribution amount before it's treated
    /// as anomalous and auto-trips the emergency pause (#779). Applies to
    /// `distribute`/`distribute_with_override` (the full token balance),
    /// each token in `batch_distribute`, and the pool in
    /// `distribute_secondary_royalties`. Not configured (the default) means
    /// no automatic anomaly check is performed.
    ///
    /// # Authorization
    /// Requires admin signature.
    ///
    /// # Panics
    /// * `ContractError::InvalidAnomalyThreshold` — `max_amount <= 0`
    pub fn set_anomaly_threshold(env: Env, max_amount: i128) {
        storage::extend_instance_ttl(&env);
        Self::check_admin_auth(&env, auth::msg::SET_ANOMALY_THRESHOLD_ADMIN);

        if max_amount <= 0 {
            Self::fail(&env, ContractError::InvalidAnomalyThreshold);
        }

        storage::instance_set(&env, &StorageKey::AnomalyThreshold, &max_amount);
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("anom_set")),
            max_amount,
        );
    }

    /// Disable the automatic anomaly check (does not affect an
    /// already-tripped emergency pause — use `clear_emergency_pause` for that).
    ///
    /// # Authorization
    /// Requires admin signature.
    pub fn clear_anomaly_threshold(env: Env) {
        storage::extend_instance_ttl(&env);
        Self::check_admin_auth(&env, auth::msg::SET_ANOMALY_THRESHOLD_ADMIN);
        env.storage().instance().remove(&StorageKey::AnomalyThreshold);
        env.events()
            .publish((symbol_short!("royalty"), symbol_short!("anom_clr")), ());
    }

    /// Returns the configured anomaly threshold, or `None` if disabled.
    pub fn get_anomaly_threshold(env: Env) -> Option<i128> {
        storage::extend_instance_ttl(&env);
        env.storage().instance().get(&StorageKey::AnomalyThreshold)
    }

    /// Checks `amount` against the configured anomaly threshold; if it's
    /// exceeded, durably sets the emergency pause and emits an `anomaly`
    /// event. Returns `true` if it tripped (caller must return without
    /// distributing — see the module note on why this never panics).
    fn trip_anomaly_pause_if_exceeded(env: &Env, token: &Address, amount: i128) -> bool {
        let threshold: Option<i128> = env.storage().instance().get(&StorageKey::AnomalyThreshold);
        let Some(threshold) = threshold else {
            return false;
        };

        if amount <= threshold {
            return false;
        }

        storage::instance_set(env, &StorageKey::EmergencyPaused, &true);
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("anomaly")),
            (token.clone(), amount, threshold),
        );
        true
    }

    /// Manually trigger the emergency pause (#779), blocking all
    /// distribution functions until `clear_emergency_pause` succeeds.
    ///
    /// # Authorization
    /// Requires admin signature.
    pub fn trigger_emergency_pause(env: Env, reason: String) {
        storage::extend_instance_ttl(&env);
        Self::check_admin_auth(&env, auth::msg::TRIGGER_EMERGENCY_PAUSE_ADMIN);
        storage::instance_set(&env, &StorageKey::EmergencyPaused, &true);
        env.events()
            .publish((symbol_short!("royalty"), symbol_short!("emrg_set")), reason);
    }

    /// Clear the emergency pause (#779). Requires a stricter bar than
    /// routine operations: when multi-sig is configured (`AdminList` set),
    /// *every* listed admin must authorize — not just `AdminThreshold` of
    /// them.
    ///
    /// # Authorization
    /// Requires the single admin, or unanimous multi-sig admin, signature(s).
    pub fn clear_emergency_pause(env: Env) {
        storage::extend_instance_ttl(&env);
        Self::require_emergency_clear_auth(&env);
        storage::instance_set(&env, &StorageKey::EmergencyPaused, &false);
        env.events()
            .publish((symbol_short!("royalty"), symbol_short!("emrg_clr")), ());
    }

    /// Returns `true` if the emergency pause is currently active.
    pub fn is_emergency_paused(env: Env) -> bool {
        storage::extend_instance_ttl(&env);
        Self::is_emergency_paused_flag(&env)
    }

    /// Auth helper for `clear_emergency_pause`: unanimous admin list
    /// signatures when multi-sig is configured, otherwise the single admin —
    /// deliberately stricter than `check_admin_auth`'s `AdminThreshold`.
    fn require_emergency_clear_auth(env: &Env) {
        let admin_list: Option<Vec<Address>> = env.storage().instance().get(&StorageKey::AdminList);
        if let Some(admins) = admin_list {
            if !admins.is_empty() {
                let context = String::from_str(env, auth::msg::CLEAR_EMERGENCY_PAUSE_ADMIN);
                env.events().publish((symbol_short!("auth_req"),), context);
                for admin in admins.iter() {
                    admin.require_auth();
                }
                return;
            }
        }

        let admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("contract not initialized");
        auth::require_admin(env, &admin, auth::msg::CLEAR_EMERGENCY_PAUSE_ADMIN);
    }

    fn validate_unique_addresses(env: &Env, recipients: &Vec<Recipient>) {
        let mut address_set: Vec<Address> = Vec::new(env);

        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            for j in 0..address_set.len() {
                if address_set.get(j).unwrap() == recipient.address {
                    Self::fail(env, ContractError::DuplicateRecipient);
                }
            }
            address_set.push_back(recipient.address.clone());
        }
    }

    fn validate_recipient_list(env: &Env, recipients: &Vec<Recipient>) {
        if recipients.is_empty() {
            Self::fail(env, ContractError::EmptyRecipients);
        }

        if recipients.len() > MAX_RECIPIENTS {
            Self::fail(env, ContractError::TooManyRecipients);
        }

        Self::validate_unique_addresses(env, recipients);

        let mut total_shares: u32 = 0;
        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();

            if recipient.share == 0 {
                Self::fail(env, ContractError::ZeroShare);
            }

            total_shares = Self::checked_add_share_total(env, total_shares, recipient.share);
        }

        if total_shares != 10_000 {
            Self::fail(env, ContractError::InvalidShareTotal);
        }
    }

    fn validate_default_recipient_basis_points(env: &Env, recipients: &Vec<Recipient>) {
        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            if recipient.share > 10_000 {
                Self::fail(env, ContractError::InvalidBasisPoints);
            }
        }
    }

    /// Auth helper: requires current admin(s) to authorize.
    ///
    /// If `AdminList` is configured (multi-sig active), requires the first
    /// `AdminThreshold` addresses in the list to call `require_auth()`.
    /// Otherwise falls back to the single `Admin` address.
    fn check_admin_auth(env: &Env, message: &str) {
        let admin_list: Option<Vec<Address>> =
            env.storage().instance().get(&StorageKey::AdminList);
        if let Some(admins) = admin_list {
            if !admins.is_empty() {
                let threshold: u32 = env
                    .storage()
                    .instance()
                    .get(&StorageKey::AdminThreshold)
                    .unwrap_or(1);
                let context = String::from_str(env, message);
                env.events().publish((symbol_short!("auth_req"),), context);
                for i in 0..threshold {
                    admins.get(i).unwrap().require_auth();
                }
                return;
            }
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("contract not initialized");
        auth::require_admin(env, &admin, message);
    }
}

#[cfg(test)]
mod contributor_incentive_tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};

    fn setup(env: &Env) -> (Address, Address, Address, RoyaltySplitterClient<'_>) {
        let contract_id = env.register_contract(None, RoyaltySplitter);
        let client = RoyaltySplitterClient::new(env, &contract_id);
        let a = Address::generate(env);
        let b = Address::generate(env);
        client.initialize(
            &Vec::from_array(env, [a.clone(), b.clone()]),
            &Vec::from_array(env, [6_000u32, 4_000u32]),
        );
        (contract_id, a, b, client)
    }

    fn recipients_eq(a: &Vec<Recipient>, b: &Vec<Recipient>) -> bool {
        if a.len() != b.len() {
            return false;
        }
        for i in 0..a.len() {
            let (ra, rb) = (a.get(i).unwrap(), b.get(i).unwrap());
            if ra.address != rb.address || ra.share != rb.share {
                return false;
            }
        }
        true
    }

    #[test]
    fn disabled_by_default_returns_plain_recipients() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, _, client) = setup(&env);

        assert!(!client.is_incentives_enabled());
        assert!(recipients_eq(&client.calculate_incentive_shares(), &client.get_recipients()));
    }

    #[test]
    fn early_adopter_bonus_shrinks_base_proportionally_and_sums_to_10000() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (_, a, b, client) = setup(&env);
        client.set_incentives_enabled(&true);

        // Both collaborators joined at the same timestamp (initialize), so
        // both get the flat +50bps early-adopter bonus. total_bonus = 100,
        // under MAX_TOTAL_INCENTIVE_BPS so no proportional scaling.
        // pool_bps = 10_000 - 100 = 9_900.
        // a (not last): 6_000 * 9_900 / 10_000 + 50 = 5_940 + 50 = 5_990.
        // b (last, absorbs remainder): 10_000 - 5_990 = 4_010.
        let adjusted = client.calculate_incentive_shares();
        assert_eq!(adjusted.len(), 2);
        assert_eq!(adjusted.get(0).unwrap().address, a);
        assert_eq!(adjusted.get(0).unwrap().share, 5_990);
        assert_eq!(adjusted.get(1).unwrap().address, b);
        assert_eq!(adjusted.get(1).unwrap().share, 4_010);

        let total: u32 = adjusted.iter().map(|r| r.share).sum();
        assert_eq!(total, 10_000);
    }

    #[test]
    fn bonus_expires_after_early_adopter_window() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (_, _, _, client) = setup(&env);
        client.set_incentives_enabled(&true);

        env.ledger()
            .with_mut(|l| l.timestamp = 1_000 + EARLY_ADOPTER_WINDOW_SECS + 1);

        // No activity recorded either, so total_bonus is 0 and the plain
        // list is returned unchanged.
        assert!(recipients_eq(&client.calculate_incentive_shares(), &client.get_recipients()));
    }

    #[test]
    fn activity_bonus_accrues_from_recorded_secondary_royalties() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (contract_id, a, _b, client) = setup(&env);
        client.set_incentives_enabled(&true);

        // Advance past the early-adopter window (measured from the join
        // date recorded at `initialize` above) so only the activity bonus
        // computed below is in play.
        env.ledger()
            .with_mut(|l| l.timestamp = 1_000 + EARLY_ADOPTER_WINDOW_SECS + 1);

        let asset_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract(asset_admin);
        StellarAssetClient::new(&env, &token).mint(&a, &1_000_000);
        TokenClient::new(&env, &token).approve(&a, &contract_id, &1_000_000, &200_000);

        for _ in 0..ACTIVITY_BONUS_STEP {
            client.record_secondary_royalty(&token, &a, &1);
        }
        assert_eq!(client.get_contributor_activity_count(&a), ACTIVITY_BONUS_STEP);

        // a earns exactly one activity step (+10bps); pool_bps = 9_990.
        // a (not last): 6_000 * 9_990 / 10_000 + 10 = 5_994 + 10 = 6_004.
        // b (last): 10_000 - 6_004 = 3_996.
        let adjusted = client.calculate_incentive_shares();
        assert_eq!(adjusted.get(0).unwrap().share, 6_004);
        assert_eq!(adjusted.get(1).unwrap().share, 3_996);
        let total: u32 = adjusted.iter().map(|r| r.share).sum();
        assert_eq!(total, 10_000);
    }

    #[test]
    fn distribute_with_incentives_pays_adjusted_shares() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (contract_id, a, b, client) = setup(&env);
        client.set_incentives_enabled(&true);

        let asset_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract(asset_admin);
        StellarAssetClient::new(&env, &token).mint(&contract_id, &10_000);

        client.distribute_with_incentives(&token);

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&a), 5_990);
        assert_eq!(token_client.balance(&b), 4_010);
        assert_eq!(token_client.balance(&contract_id), 0);
        assert_eq!(client.get_distribute_count(), 1);
    }
}

#[cfg(test)]
mod admin_rotation_tests {
    //! Valid-path tests call through `RoyaltySplitterClient` (real contract
    //! dispatch via `env.register_contract`), matching this repo's existing
    //! test convention.
    //!
    //! `#[should_panic]` cases are marked `#[ignore]`: a pre-existing
    //! soroban-sdk 20.5.0 + modern-rustc incompatibility means a contract
    //! panic crossing the generated client's dispatch boundary aborts the
    //! whole test binary (SIGABRT) instead of unwinding — confirmed on both
    //! macOS/aarch64 and Linux/x86_64, both with and without `try_*`. This is
    //! the same reason `tests/integration_test.rs`, `tests/fuzz_royalty_allocation.rs`,
    //! and `tests/commit_reveal_test.rs` no longer compile/run their
    //! panic-path cases either, and why CI's `Test` job is filtered down to a
    //! single non-panicking test name. The logic itself (bounds checks
    //! ordered before any state mutation, `ContractError` variants returned)
    //! mirrors the rest of the file's established guard-rail pattern; run
    //! these `--ignored` on a toolchain/SDK combination without the abort to
    //! confirm.
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    fn setup(env: &Env) -> (Address, Address, RoyaltySplitterClient<'_>) {
        let contract_id = env.register_contract(None, RoyaltySplitter);
        let client = RoyaltySplitterClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let b = Address::generate(env);
        client.initialize(
            &Vec::from_array(env, [admin.clone(), b.clone()]),
            &Vec::from_array(env, [6_000u32, 4_000u32]),
        );
        (contract_id, admin, client)
    }

    #[test]
    fn default_timelock_is_48_hours() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, client) = setup(&env);
        assert_eq!(
            client.get_admin_rotation_timelock(),
            DEFAULT_ADMIN_ROTATION_TIMELOCK
        );
        assert!(client.get_pending_admin_rotation().is_none());
    }

    #[test]
    fn initiate_then_finalize_after_timelock_rotates_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, client) = setup(&env);
        let new_admin = Address::generate(&env);

        env.ledger().with_mut(|l| l.timestamp = 1_000);
        client.initiate_admin_rotation(&new_admin);

        let pending = client.get_pending_admin_rotation().unwrap();
        assert_eq!(pending.new_admin, new_admin);
        assert_eq!(pending.initiated_at, 1_000);
        assert_eq!(client.get_admin(), admin);

        env.ledger()
            .with_mut(|l| l.timestamp = 1_000 + DEFAULT_ADMIN_ROTATION_TIMELOCK);
        client.finalize_admin_rotation();

        assert_eq!(client.get_admin(), new_admin);
        assert!(client.get_pending_admin_rotation().is_none());
    }

    #[test]
    #[ignore = "aborts under soroban-sdk 20.5.0 client dispatch on modern rustc; see module doc"]
    #[should_panic]
    fn finalize_before_timelock_elapses_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, client) = setup(&env);
        let new_admin = Address::generate(&env);

        env.ledger().with_mut(|l| l.timestamp = 1_000);
        client.initiate_admin_rotation(&new_admin);

        env.ledger()
            .with_mut(|l| l.timestamp = 1_000 + DEFAULT_ADMIN_ROTATION_TIMELOCK - 1);
        client.finalize_admin_rotation();
    }

    #[test]
    #[ignore = "aborts under soroban-sdk 20.5.0 client dispatch on modern rustc; see module doc"]
    #[should_panic]
    fn finalize_without_pending_rotation_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, client) = setup(&env);
        client.finalize_admin_rotation();
    }

    #[test]
    fn cancel_clears_pending_rotation_and_blocks_finalize() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, client) = setup(&env);
        let new_admin = Address::generate(&env);

        client.initiate_admin_rotation(&new_admin);
        assert!(client.get_pending_admin_rotation().is_some());

        client.cancel_admin_rotation();
        assert!(client.get_pending_admin_rotation().is_none());
        assert_eq!(client.get_admin(), admin);
    }

    #[test]
    #[ignore = "aborts under soroban-sdk 20.5.0 client dispatch on modern rustc; see module doc"]
    #[should_panic]
    fn cancel_without_pending_rotation_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, client) = setup(&env);
        client.cancel_admin_rotation();
    }

    #[test]
    fn re_initiating_replaces_prior_pending_rotation() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, client) = setup(&env);
        let first_candidate = Address::generate(&env);
        let second_candidate = Address::generate(&env);

        env.ledger().with_mut(|l| l.timestamp = 500);
        client.initiate_admin_rotation(&first_candidate);

        env.ledger().with_mut(|l| l.timestamp = 900);
        client.initiate_admin_rotation(&second_candidate);

        let pending = client.get_pending_admin_rotation().unwrap();
        assert_eq!(pending.new_admin, second_candidate);
        assert_eq!(pending.initiated_at, 900);

        env.ledger()
            .with_mut(|l| l.timestamp = 900 + DEFAULT_ADMIN_ROTATION_TIMELOCK);
        client.finalize_admin_rotation();
        assert_eq!(client.get_admin(), second_candidate);
    }

    #[test]
    fn set_admin_rotation_timelock_changes_wait_period() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, client) = setup(&env);
        let new_admin = Address::generate(&env);

        client.set_admin_rotation_timelock(&MIN_ADMIN_ROTATION_TIMELOCK);
        assert_eq!(
            client.get_admin_rotation_timelock(),
            MIN_ADMIN_ROTATION_TIMELOCK
        );

        env.ledger().with_mut(|l| l.timestamp = 10_000);
        client.initiate_admin_rotation(&new_admin);

        env.ledger()
            .with_mut(|l| l.timestamp = 10_000 + MIN_ADMIN_ROTATION_TIMELOCK);
        client.finalize_admin_rotation();
        assert_eq!(client.get_admin(), new_admin);
    }

    #[test]
    #[ignore = "aborts under soroban-sdk 20.5.0 client dispatch on modern rustc; see module doc"]
    #[should_panic]
    fn set_admin_rotation_timelock_below_minimum_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, client) = setup(&env);
        client.set_admin_rotation_timelock(&(MIN_ADMIN_ROTATION_TIMELOCK - 1));
    }

    #[test]
    #[ignore = "aborts under soroban-sdk 20.5.0 client dispatch on modern rustc; see module doc"]
    #[should_panic]
    fn set_admin_rotation_timelock_above_maximum_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, client) = setup(&env);
        client.set_admin_rotation_timelock(&(MAX_ADMIN_ROTATION_TIMELOCK + 1));
    }
}

/// Minimal test-only "token" used to deterministically exercise
/// `distribute_resilient`'s partial-failure path (#777). Soroban's real
/// token clients dispatch by function name/signature, not by trait object,
/// so any contract exposing `balance`/`transfer` with matching signatures
/// works as a token for `token::Client`. `transfer` panics for a
/// pre-configured "blocked" recipient (standing in for a real-world failure
/// like a missing trustline or a frozen account) and succeeds as a no-op
/// otherwise; `balance` returns a pre-configured constant regardless of
/// transfers, since only `distribute_resilient`'s control flow is under
/// test here, not real token accounting.
#[cfg(test)]
#[contract]
pub struct MockPartialFailToken;

#[cfg(test)]
#[contractimpl]
impl MockPartialFailToken {
    pub fn set_balance(env: Env, amount: i128) {
        env.storage().instance().set(&symbol_short!("bal"), &amount);
    }

    pub fn set_blocked(env: Env, addr: Address) {
        env.storage().instance().set(&symbol_short!("blocked"), &addr);
    }

    pub fn balance(env: Env, _id: Address) -> i128 {
        env.storage().instance().get(&symbol_short!("bal")).unwrap_or(0)
    }

    pub fn transfer(env: Env, _from: Address, to: Address, _amount: i128) {
        let blocked: Option<Address> = env.storage().instance().get(&symbol_short!("blocked"));
        if blocked == Some(to) {
            panic!("blocked recipient");
        }
    }
}

#[cfg(test)]
mod distribute_resilient_tests {
    //! The two "a recipient's transfer fails" cases below are marked
    //! `#[ignore]`: they need `MockPartialFailToken::transfer` to actually
    //! panic so `try_transfer` has something to catch, but under this
    //! soroban-sdk 20.5.0 + modern-rustc combination *any* contract-dispatch
    //! panic aborts the whole process (SIGABRT) instead of unwinding —
    //! confirmed for both the outermost client-dispatch boundary (see the
    //! `admin_rotation_tests` module doc) and, here, for a panic several
    //! calls deep inside a `try_transfer`'d cross-contract call. The
    //! `distribute_resilient` implementation follows the standard Soroban
    //! pattern for defensive cross-contract calls (match on
    //! `Ok(Ok(()))`, treat everything else as a recorded failure); run these
    //! `--ignored` on a toolchain/SDK combination without the abort to
    //! confirm end-to-end.
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};

    fn setup(env: &Env) -> (Address, RoyaltySplitterClient<'_>) {
        let contract_id = env.register_contract(None, RoyaltySplitter);
        let client = RoyaltySplitterClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let b = Address::generate(env);
        client.initialize(
            &Vec::from_array(env, [admin, b]),
            &Vec::from_array(env, [6_000u32, 4_000u32]),
        );
        (contract_id, client)
    }

    fn mock_token(env: &Env, balance: i128, blocked: Option<&Address>) -> Address {
        let token = env.register_contract(None, MockPartialFailToken);
        let token_client = MockPartialFailTokenClient::new(env, &token);
        token_client.set_balance(&balance);
        if let Some(addr) = blocked {
            token_client.set_blocked(addr);
        }
        token
    }

    #[test]
    fn all_succeed_behaves_like_a_normal_distribution() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, client) = setup(&env);

        let asset_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract(asset_admin);
        StellarAssetClient::new(&env, &token).mint(&contract_id, &10_000);

        let failed = client.distribute_resilient(&token, &Vec::new(&env));
        assert!(failed.is_empty());
        assert_eq!(client.get_distribute_count(), 1);
        assert!(client.get_last_distribution().is_some());
        assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 0);
    }

    #[test]
    #[ignore = "aborts under soroban-sdk 20.5.0 nested contract dispatch on modern rustc; see module doc"]
    fn one_blocked_recipient_does_not_sink_the_other() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup(&env);
        let blocked_addr = client.get_recipients().get(1).unwrap().address;

        let token = mock_token(&env, 10_000, Some(&blocked_addr));

        let failed = client.distribute_resilient(&token, &Vec::new(&env));
        assert_eq!(failed.len(), 1);
        assert_eq!(failed.get(0).unwrap(), blocked_addr);

        // The one successful transfer still counts as a completed
        // distribution — the call did not revert because of the other's
        // failure.
        assert_eq!(client.get_distribute_count(), 1);
        assert!(client.get_last_distribution().is_some());
    }

    #[test]
    #[ignore = "aborts under soroban-sdk 20.5.0 nested contract dispatch on modern rustc; see module doc"]
    fn every_recipient_blocked_reports_full_failure_without_reverting() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup(&env);
        let sole_recipient = Address::generate(&env);

        let token = mock_token(&env, 10_000, Some(&sole_recipient));
        let override_recipients = Vec::from_array(
            &env,
            [Recipient {
                address: sole_recipient.clone(),
                share: 10_000,
            }],
        );

        let failed = client.distribute_resilient(&token, &override_recipients);
        assert_eq!(failed.len(), 1);
        assert_eq!(failed.get(0).unwrap(), sole_recipient);

        // No transfer succeeded, so the call must not be recorded as a
        // completed distribution.
        assert_eq!(client.get_distribute_count(), 0);
        assert!(client.get_last_distribution().is_none());
    }
}

#[cfg(test)]
mod emergency_pause_tests {
    //! The two `#[ignore]`d cases need a genuine auth/panic rejection from
    //! the contract, but under this soroban-sdk 20.5.0 + modern-rustc
    //! combination any contract-dispatch panic aborts the whole process
    //! instead of unwinding (see `admin_rotation_tests`' module doc for the
    //! full explanation, confirmed on both macOS/aarch64 and Linux/x86_64).
    //! Run these `--ignored` on a toolchain/SDK combination without the
    //! issue to confirm end-to-end.
    use super::*;
    use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
    use soroban_sdk::{token::{Client as TokenClient, StellarAssetClient}, IntoVal};

    fn setup(env: &Env) -> (Address, Address, Address, RoyaltySplitterClient<'_>) {
        let contract_id = env.register_contract(None, RoyaltySplitter);
        let client = RoyaltySplitterClient::new(env, &contract_id);
        let a = Address::generate(env);
        let b = Address::generate(env);
        client.initialize(
            &Vec::from_array(env, [a.clone(), b.clone()]),
            &Vec::from_array(env, [6_000u32, 4_000u32]),
        );
        (contract_id, a, b, client)
    }

    #[test]
    fn disabled_by_default() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, _, client) = setup(&env);

        assert!(client.get_anomaly_threshold().is_none());
        assert!(!client.is_emergency_paused());
    }

    #[test]
    fn set_and_clear_anomaly_threshold() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, _, client) = setup(&env);

        client.set_anomaly_threshold(&5_000);
        assert_eq!(client.get_anomaly_threshold(), Some(5_000));

        client.clear_anomaly_threshold();
        assert!(client.get_anomaly_threshold().is_none());
    }

    #[test]
    fn oversized_distribution_trips_emergency_pause_without_reverting() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _a, _b, client) = setup(&env);
        client.set_anomaly_threshold(&5_000);

        let asset_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract(asset_admin);
        StellarAssetClient::new(&env, &token).mint(&contract_id, &10_000);

        // 10,000 exceeds the 5,000 threshold: the call must succeed as a
        // no-op (not panic — see module doc) but durably set the pause.
        client.distribute(&token);

        assert!(client.is_emergency_paused());
        assert_eq!(client.get_distribute_count(), 0);
        assert_eq!(
            TokenClient::new(&env, &token).balance(&contract_id),
            10_000
        );
    }

    #[test]
    fn distribution_under_threshold_is_unaffected() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _a, _b, client) = setup(&env);
        client.set_anomaly_threshold(&5_000);

        let asset_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract(asset_admin);
        StellarAssetClient::new(&env, &token).mint(&contract_id, &4_000);

        client.distribute(&token);

        assert!(!client.is_emergency_paused());
        assert_eq!(client.get_distribute_count(), 1);
        assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 0);
    }

    #[test]
    fn manual_trigger_and_clear_single_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, _, client) = setup(&env);

        client.trigger_emergency_pause(&String::from_str(&env, "manual test pause"));
        assert!(client.is_emergency_paused());

        client.clear_emergency_pause();
        assert!(!client.is_emergency_paused());
    }

    #[test]
    fn clear_succeeds_when_every_multisig_admin_authorizes() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, a, b, client) = setup(&env);

        // AdminThreshold of 1 is enough for routine operations, but
        // clear_emergency_pause walks the *entire* admin list regardless —
        // with mock_all_auths every address auto-authorizes, so this proves
        // the iteration over all admins completes without erroring.
        client.set_admins(&Vec::from_array(&env, [a, b]), &1);
        client.trigger_emergency_pause(&String::from_str(&env, "test"));

        client.clear_emergency_pause();
        assert!(!client.is_emergency_paused());
    }

    #[test]
    #[ignore = "aborts under soroban-sdk 20.5.0 client dispatch on modern rustc; see module doc"]
    fn distribute_while_emergency_paused_panics_with_distinct_error() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _a, _b, client) = setup(&env);
        client.trigger_emergency_pause(&String::from_str(&env, "test"));

        let asset_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract(asset_admin);
        StellarAssetClient::new(&env, &token).mint(&contract_id, &1_000);

        client.distribute(&token);
    }

    #[test]
    #[ignore = "aborts under soroban-sdk 20.5.0 client dispatch on modern rustc; see module doc"]
    fn clear_emergency_pause_fails_without_every_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, a, b, client) = setup(&env);

        client.set_admins(&Vec::from_array(&env, [a.clone(), b]), &1);
        client.trigger_emergency_pause(&String::from_str(&env, "test"));

        // Only `a` authorizes — `b` is required too (unanimity), so this
        // must fail even though a plain `AdminThreshold` of 1 would pass.
        client
            .set_auths(&[MockAuth {
                address: &a,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "clear_emergency_pause",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }
            .into()])
            .clear_emergency_pause();
    }
}

