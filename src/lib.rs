use soroban_sdk::unwrap::UnwrapOptimized;
pub mod auth;
mod storage;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token,
    xdr::ToXdr, Address, Bytes, BytesN, Env, Map, String, Vec,
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

/// Lifecycle state of a dispute (#841).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DisputeStatus {
    Open,
    Resolved,
    ClawedBack,
}

/// An admin-recorded dispute against a past distribution (#841). Stored as an
/// on-chain audit trail; `resolve_dispute` / `clawback` transition it out of
/// `Open`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    /// Off-chain transaction / distribution identifier the dispute concerns.
    pub transaction_id: u64,
    pub reason: String,
    /// Disputed amount, in the token's smallest unit.
    pub amount: i128,
    pub status: DisputeStatus,
    pub opened_by: Address,
    pub opened_at: u64,
    pub resolved_at: u64,
}

/// What a governance proposal changes (#842). Extensible — only rate changes
/// are wired to auto-execution for now.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposalKind {
    RoyaltyRateChange,
}

/// A governance proposal (#842). Votes are weighted by the collaborator's
/// share (basis points), so approval means `yes_weight` is a strict majority
/// of the total share weight *and* the voting window is still open.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub kind: ProposalKind,
    /// Proposed new royalty rate (basis points) for `RoyaltyRateChange`.
    pub new_rate: u32,
    pub proposer: Address,
    pub created_at: u64,
    pub deadline: u64,
    pub yes_weight: u32,
    pub no_weight: u32,
    pub executed: bool,
    pub rejected: bool,
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
    ProposalCount,
    // Persistent storage
    ApprovedTokens,
    Disputes,
    DisputeCount,
    Proposals,
    ProposalVotes,
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
pub const MAX_BATCH_TOKENS: u32 = 50;

/// Maximum number of tokens in the approved-token whitelist (#840).
pub const MAX_APPROVED_TOKENS: u32 = 25;

/// Minimum governance proposal voting window, seconds (#842). 1 hour.
pub const MIN_PROPOSAL_DURATION: u64 = 3_600;

/// Maximum governance proposal voting window, seconds (#842). 14 days.
pub const MAX_PROPOSAL_DURATION: u64 = 1_209_600;

/// Total collaborator share weight — proposals need a strict majority of this.
pub const TOTAL_SHARE_WEIGHT: u32 = 10_000;

/// Backward-compatible alias for integration tests and external references.
pub type DataKey = StorageKey;

pub use storage::MIN_TTL;

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
    InitRevealTooEarly = 30,
    InitCommitmentMismatch = 31,
    TooManyBatchTokens = 32,
    RoyaltyAmountNotPositive = 33,
    NoPendingAdminRotation = 34,
    AdminRotationTimelockNotElapsed = 35,
    InvalidTimelockDuration = 36,
    EmergencyContractPaused = 37,
    InvalidAnomalyThreshold = 38,
    TokenNotApproved = 39,
    DisputeNotFound = 40,
    DisputeAlreadyResolved = 41,
    ProposalNotFound = 42,
    ProposalVotingClosed = 43,
    ProposalStillOpen = 44,
    ProposalAlreadyExecuted = 45,
    AlreadyVoted = 46,
    InvalidProposalDuration = 47,
}

#[contract]
pub struct RoyaltySplitter;

#[contractimpl]
impl RoyaltySplitter {
    fn require_admin_address(env: &Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&StorageKey::Admin)
            .ok_or(ContractError::NotInitialized)
    }

    fn require_collaborators(env: &Env) -> Result<Vec<Address>, ContractError> {
        env.storage()
            .instance()
            .get(&StorageKey::Collaborators)
            .ok_or(ContractError::NoCollaborators)
    }

    fn require_share_map(env: &Env) -> Result<Map<Address, u32>, ContractError> {
        env.storage()
            .instance()
            .get(&StorageKey::ShareMap)
            .ok_or(ContractError::NoShareMap)
    }

    fn checked_add_share_total(env: &Env, total: u32, share: u32) -> Result<u32, ContractError> {
        total
            .checked_add(share)
            .ok_or(ContractError::ArithmeticOverflow)
    }

    fn checked_bps_amount(env: &Env, amount: i128, bps: u32) -> Result<i128, ContractError> {
        if amount < 0 {
            return Err(ContractError::ArithmeticOverflow);
        }

        let numerator = (amount as u128)
            .checked_mul(bps as u128)
            .ok_or(ContractError::ArithmeticOverflow)?;
        let result = numerator / 10_000;
        if result > i128::MAX as u128 {
            return Err(ContractError::ArithmeticOverflow);
        }
        Ok(result as i128)
    }

    fn initialize_validated(
        env: &Env,
        collaborators: Vec<Address>,
        shares: Vec<u32>,
    ) -> Result<(), ContractError> {
        if collaborators.is_empty() {
            return Err(ContractError::EmptyCollaborators);
        }

        if collaborators.len() > MAX_COLLABORATORS {
            return Err(ContractError::TooManyRecipients);
        }

        if collaborators.len() != shares.len() {
            return Err(ContractError::LengthMismatch);
        }

        let mut total: u32 = 0;
        for share in shares.iter() {
            total = Self::checked_add_share_total(env, total, share)?;
        }

        if total != 10_000 {
            return Err(ContractError::InvalidShareTotal);
        }

        let mut share_map: Map<Address, u32> = Map::new(env);

        for i in 0..collaborators.len() {
            let addr = collaborators.get(i).unwrap_optimized();
            let share = shares.get(i).unwrap();

            if share == 0 {
                return Err(ContractError::ZeroShare);
            }

            if share_map.contains_key(addr.clone()) {
                return Err(ContractError::DuplicateRecipient);
            }

            share_map.set(addr, share);
        }

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
        Ok(())
    }

    pub fn initialize(env: Env, collaborators: Vec<Address>, shares: Vec<u32>) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        if env.storage().instance().has(&StorageKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }

        if collaborators.is_empty() {
            return Err(ContractError::EmptyCollaborators);
        }

        if collaborators.len() > MAX_COLLABORATORS {
            return Err(ContractError::TooManyRecipients);
        }

        auth::require_admin(
            &env,
            &collaborators.get(0).unwrap(),
            auth::msg::INITIALIZE_ADMIN,
        );

        Self::initialize_validated(&env, collaborators, shares)?;
        Ok(())
    }

    pub fn commit_initialize(env: Env, collaborators_hash: BytesN<32>, shares_hash: BytesN<32>) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        if env.storage().instance().has(&StorageKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }

        let nonce: u32 = env.storage().instance().get(&StorageKey::InitializeNonce).unwrap_or(0);
        let nonce = nonce.checked_add(1).ok_or(ContractError::ArithmeticOverflow)?;

        storage::instance_set(&env, &StorageKey::InitializeCollaboratorsHash, &collaborators_hash);
        storage::instance_set(&env, &StorageKey::InitializeSharesHash, &shares_hash);
        storage::instance_set(&env, &StorageKey::InitializeCommitLedger, &env.ledger().sequence());
        storage::instance_set(&env, &StorageKey::InitializeNonce, &nonce);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("init_comt")),
            (collaborators_hash, shares_hash, nonce),
        );
        Ok(())
    }

    pub fn reveal_initialize(env: Env, collaborators: Vec<Address>, shares: Vec<u32>) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        if env.storage().instance().has(&StorageKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }

        let committed_collaborators: BytesN<32> = match env
            .storage()
            .instance()
            .get(&StorageKey::InitializeCollaboratorsHash) {
                Some(val) => val,
                None => return Err(ContractError::NoInitializationCommitment),
            };
        let committed_shares: BytesN<32> = match env
            .storage()
            .instance()
            .get(&StorageKey::InitializeSharesHash) {
                Some(val) => val,
                None => return Err(ContractError::NoInitializationCommitment),
            };
        let commit_ledger: u32 = match env
            .storage()
            .instance()
            .get(&StorageKey::InitializeCommitLedger) {
                Some(val) => val,
                None => return Err(ContractError::NoInitializationCommitment),
            };

        if env.ledger().sequence() <= commit_ledger {
            return Err(ContractError::InitRevealTooEarly);
        }

        let collaborators_hash = env.crypto().sha256(&collaborators.clone().to_xdr(&env));
        let shares_hash = env.crypto().sha256(&shares.clone().to_xdr(&env));
        if collaborators_hash != committed_collaborators || shares_hash != committed_shares {
            return Err(ContractError::InitCommitmentMismatch);
        }

        let admin = collaborators.get(0).ok_or(ContractError::EmptyCollaborators)?;
        auth::require_admin(&env, &admin, auth::msg::INITIALIZE_ADMIN);
        Self::initialize_validated(&env, collaborators, shares)?;

        env.storage().instance().remove(&StorageKey::InitializeCollaboratorsHash);
        env.storage().instance().remove(&StorageKey::InitializeSharesHash);
        env.storage().instance().remove(&StorageKey::InitializeCommitLedger);
        Ok(())
    }

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
            note: String::from_str(&env, "recorded additive migration"),
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

    pub fn set_royalty_rate(env: Env, new_rate: u32) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_ROYALTY_RATE_ADMIN);

        if new_rate == 0 {
            return Err(ContractError::RoyaltyRateZero);
        }

        if new_rate > 10_000 {
            return Err(ContractError::RoyaltyRateTooHigh);
        }

        let old_rate: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::RoyaltyRate)
            .unwrap_or(0);

        storage::instance_set(&env, &StorageKey::RoyaltyRate, &new_rate);

        let caller: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("not initialized");

        let mut history: Vec<RoyaltyRateChange> =
            storage::persistent_get::<Vec<RoyaltyRateChange>>(&env, &StorageKey::RoyaltyRateHistory)
                .unwrap_or(Vec::new(&env));

        if history.len() >= RATE_HISTORY_CAP {
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
        Ok(())
    }

    pub fn get_royalty_rate_history(env: Env) -> Vec<RoyaltyRateChange> {
        storage::extend_instance_ttl(&env);
        storage::persistent_get::<Vec<RoyaltyRateChange>>(&env, &StorageKey::RoyaltyRateHistory)
            .unwrap_or(Vec::new(&env))
    }

    pub fn pause(env: Env) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::PAUSE_ADMIN);
        storage::instance_set(&env, &StorageKey::Paused, &true);
        let admin = Self::require_admin_address(&env)?;
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("paused")),
            admin,
        );
        Ok(())
    }

    pub fn admin_transfer(env: Env, new_admin: Address) {
        storage::extend_instance_ttl(&env);

        if env.storage().instance().has(&StorageKey::AdminList) {
            panic!("use propose_admin_xfr multisig");
        }

        let admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("not initialized");

        auth::require_admin(&env, &admin, auth::msg::ADMIN_TRANSFER_ADMIN);

        let previous_admin = admin.clone();
        storage::instance_set(&env, &StorageKey::Admin, &new_admin);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("admin_xfr")),
            (previous_admin, new_admin),
        );
    }

    pub fn propose_admin_transfer(env: Env, new_admin: Address) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::PROPOSE_ADMIN_ADMIN);
        storage::instance_set(&env, &StorageKey::PendingAdmin, &new_admin);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("adm_prop")),
            new_admin,
        );
    }

    pub fn accept_admin(env: Env) {
        storage::extend_instance_ttl(&env);

        let pending: Address = env
            .storage()
            .instance()
            .get(&StorageKey::PendingAdmin)
            .expect("no pending admin transfer");

        let context = String::from_str(&env, auth::msg::ACCEPT_ADMIN_PENDING);
        env.events().publish((symbol_short!("auth_req"),), context);
        pending.require_auth();

        let previous_admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("not initialized");

        storage::instance_set(&env, &StorageKey::Admin, &pending);
        env.storage().instance().remove(&StorageKey::PendingAdmin);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("adm_acc")),
            (previous_admin, pending),
        );
    }

    pub fn unpause(env: Env) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::UNPAUSE_ADMIN);
        storage::instance_set(&env, &StorageKey::Paused, &false);
        let admin = Self::require_admin_address(&env)?;
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("unpaused")),
            admin,
        );
        Ok(())
    }

    pub fn update_wasm(env: Env, wasm_hash: BytesN<32>) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::UPDATE_WASM_ADMIN);

        env.deployer().update_current_contract_wasm(wasm_hash);
    }

    pub fn is_paused(env: Env) -> bool {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::Paused)
            .unwrap_or(false)
    }

    pub fn pause_operation(env: Env, operation: OperationType) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::PAUSE_OPERATION_ADMIN);

        let key = Self::operation_pause_key(operation);
        storage::instance_set(&env, &key, &true);

        let admin = Self::require_admin_address(&env)?;
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("op_pause")),
            (admin, Self::operation_event_tag(operation)),
        );
        Ok(())
    }

    pub fn unpause_operation(env: Env, operation: OperationType) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::UNPAUSE_OPERATION_ADMIN);

        let key = Self::operation_pause_key(operation);
        storage::instance_set(&env, &key, &false);

        let admin = Self::require_admin_address(&env)?;
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("op_unpaus")),
            (admin, Self::operation_event_tag(operation)),
        );
        Ok(())
    }

    pub fn is_operation_paused(env: Env, operation: OperationType) -> bool {
        storage::extend_instance_ttl(&env);
        let key = Self::operation_pause_key(operation);
        env.storage().instance().get(&key).unwrap_or(false)
    }

    fn operation_pause_key(operation: OperationType) -> StorageKey {
        match operation {
            OperationType::PrimaryDistribution => StorageKey::PausedPrimary,
            OperationType::SecondaryDistribution => StorageKey::PausedSecondary,
        }
    }

    fn operation_event_tag(operation: OperationType) -> soroban_sdk::Symbol {
        match operation {
            OperationType::PrimaryDistribution => symbol_short!("primary"),
            OperationType::SecondaryDistribution => symbol_short!("secondry"),
        }
    }

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

    fn is_emergency_paused_flag(env: &Env) -> bool {
        env.storage()
            .instance()
            .get::<StorageKey, bool>(&StorageKey::EmergencyPaused)
            .unwrap_or(false)
    }

    pub fn is_initialized(env: Env) -> bool {
        storage::extend_instance_ttl(&env);
        env.storage().instance().has(&StorageKey::Admin)
    }

    pub fn get_admin(env: Env) -> Result<Address, ContractError> {
        storage::extend_instance_ttl(&env);
        Self::require_admin_address(&env)
    }

    pub fn get_balance(env: Env, token: Address) -> i128 {
        storage::extend_instance_ttl(&env);
        token::Client::new(&env, &token).balance(&env.current_contract_address())
    }

    pub fn set_default_recipients(env: Env, recipients: Vec<Recipient>) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_DEFAULT_RECIPIENTS_ADMIN);
        Self::validate_default_rcpt_bps(&env, &recipients)?;
        Self::validate_recipient_list(&env, &recipients)?;

        storage::persistent_set(&env, &StorageKey::DefaultRecipients, &recipients);

        env.events().publish(
            (symbol_short!("default"), symbol_short!("rcpt_set")),
            recipients.len(),
        );
        Ok(())
    }

    pub fn set_recipients(env: Env, recipients: Vec<Recipient>) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_RECIPIENTS_ADMIN);
        Self::validate_recipient_list(&env, &recipients)?;

        let mut collaborators: Vec<Address> = Vec::new(&env);
        let mut share_map: Map<Address, u32> = Map::new(&env);

        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            collaborators.push_back(recipient.address.clone());
            share_map.set(recipient.address.clone(), recipient.share);
        }

        storage::persistent_set(&env, &StorageKey::Collaborators, &collaborators);
        storage::persistent_set(&env, &StorageKey::ShareMap, &share_map);

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
        Ok(())
    }

    pub fn withdraw(env: Env, token: Address, amount: i128) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        let admin = Self::require_admin_address(&env)?;

        Self::check_admin_auth(&env, auth::msg::WITHDRAW_ADMIN);

        if amount <= 0 {
            return Err(ContractError::AmountNotPositive);
        }

        let token_client = token::Client::new(&env, &token);
        let balance = token_client.balance(&env.current_contract_address());
        if amount > balance {
            return Err(ContractError::InsufficientBalance);
        }

        token_client.transfer(&env.current_contract_address(), &admin, &amount);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("withdraw")),
            (token, amount),
        );
        Ok(())
    }

    pub fn get_default_recipients(env: Env) -> Vec<Recipient> {
        storage::extend_instance_ttl(&env);
        storage::persistent_get::<Vec<Recipient>>(&env, &StorageKey::DefaultRecipients)
            .unwrap_or(Vec::new(&env))
    }

    pub fn distribute_with_override(env: Env, token: Address, override_recipients: Vec<Recipient>) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::DISTRIBUTE_OVERRIDE_ADMIN);

        if Self::is_emergency_paused_flag(&env) {
            return Err(ContractError::EmergencyContractPaused);
        }
        if Self::is_blocked(&env, OperationType::PrimaryDistribution) {
            return Err(ContractError::ContractPaused);
        }
        Self::require_approved_token(&env, &token)?; // #840

        let token_client = token::Client::new(&env, &token);
        let amount = token_client.balance(&env.current_contract_address());
        if amount == 0 {
            return Err(ContractError::Underfunded);
        }

        if Self::trip_anomaly_pause_if_exceeded(&env, &token, amount) {
            return Ok(());
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

        Self::validate_recipient_list(&env, &recipients_to_use)?;

        let n = recipients_to_use.len();

        if amount < n as i128 {
            return Err(ContractError::AmountTooSmall);
        }
        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;

        for i in 0..(n - 1) {
            let recipient = recipients_to_use.get(i).unwrap();
            let payout = Self::checked_bps_amount(&env, amount, recipient.share)?;
            payouts.push_back((recipient.address.clone(), payout));
            total_calculated = total_calculated
                .checked_add(payout)
                .ok_or(ContractError::ArithmeticOverflow)?;
        }

        let last = recipients_to_use.get(n - 1).unwrap();
        payouts.push_back((
            last.address.clone(),
            amount
                .checked_sub(total_calculated)
                .ok_or(ContractError::ArithmeticOverflow)?,
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

        let new_count = current_count.saturating_add(1);
        storage::instance_set(&env, &StorageKey::DistributeHistory, &new_count);
        Ok(())
    }

    pub fn distribute_resilient(
        env: Env,
        token: Address,
        override_recipients: Vec<Recipient>,
    ) -> Result<Vec<Address>, ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::DISTRIBUTE_RESILIENT_ADMIN);

        if Self::is_blocked(&env, OperationType::PrimaryDistribution) {
            return Err(ContractError::ContractPaused);
        }

        let token_client = token::Client::new(&env, &token);
        let amount = token_client.balance(&env.current_contract_address());
        if amount == 0 {
            return Err(ContractError::Underfunded);
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

        Self::validate_recipient_list(&env, &recipients_to_use)?;

        let n = recipients_to_use.len();
        if amount < n as i128 {
            return Err(ContractError::AmountTooSmall);
        }

        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;
        for i in 0..(n - 1) {
            let recipient = recipients_to_use.get(i).unwrap();
            let payout = Self::checked_bps_amount(&env, amount, recipient.share)?;
            payouts.push_back((recipient.address.clone(), payout));
            total_calculated = total_calculated
                .checked_add(payout)
                .ok_or(ContractError::ArithmeticOverflow)?;
        }
        let last = recipients_to_use.get(n - 1).unwrap();
        payouts.push_back((
            last.address.clone(),
            amount
                .checked_sub(total_calculated)
                .ok_or(ContractError::ArithmeticOverflow)?,
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
                        .ok_or(ContractError::ArithmeticOverflow)?;
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

        Ok(failed)
    }

    pub fn get_distribute_count(env: Env) -> u64 {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::DistributeHistory)
            .unwrap_or(0)
    }

    pub fn distribute(env: Env, token: Address) -> Result<(), ContractError> {
        Self::distribute_with_override(env.clone(), token, Vec::new(&env))?;
        Ok(())
    }

    pub fn batch_distribute(env: Env, tokens: Vec<Address>) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::BATCH_DISTRIBUTE_ADMIN);

        if tokens.len() > MAX_BATCH_TOKENS {
            return Err(ContractError::TooManyBatchTokens);
        }
        for t in tokens.iter() {
            Self::require_approved_token(&env, &t)?; // #840
        }

        if Self::is_emergency_paused_flag(&env) {
            return Err(ContractError::EmergencyContractPaused);
        }

        if env
            .storage()
            .instance()
            .get::<StorageKey, bool>(&StorageKey::Paused)
            .unwrap_or(false)
        {
            return Err(ContractError::ContractPaused);
        }

        let recipients_to_use: Vec<Recipient> = {
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

        if recipients_to_use.is_empty() {
            return Err(ContractError::EmptyRecipients);
        }

        let mut total_shares: u32 = 0;
        for i in 0..recipients_to_use.len() {
            total_shares = Self::checked_add_share_total(&env, total_shares, recipients_to_use.get(i).unwrap().share)?;
        }
        if total_shares != 10_000 {
            return Err(ContractError::InvalidShareTotal);
        }

        let n = recipients_to_use.len();

        for token in tokens.iter() {
            let token_client = token::Client::new(&env, &token);
            let amount = token_client.balance(&env.current_contract_address());

            if Self::trip_anomaly_pause_if_exceeded(&env, &token, amount) {
                return Ok(());
            }

            if amount == 0 {
                return Err(ContractError::NoBalance);
            }

            if amount < n as i128 {
                return Err(ContractError::AmountTooSmall);
            }

            let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
            let mut total_calculated: i128 = 0;

            for i in 0..(n - 1) {
                let recipient = recipients_to_use.get(i).unwrap();
                let payout = Self::checked_bps_amount(&env, amount, recipient.share)?;
                payouts.push_back((recipient.address.clone(), payout));
                total_calculated = total_calculated
                    .checked_add(payout)
                    .ok_or(ContractError::ArithmeticOverflow)?;
            }

            let last = recipients_to_use.get(n - 1).unwrap();
            payouts.push_back((
                last.address.clone(),
                amount
                    .checked_sub(total_calculated)
                    .ok_or(ContractError::ArithmeticOverflow)?,
            ));

            for (addr, payout) in payouts.iter() {
                token_client.transfer(&env.current_contract_address(), &addr, &payout);
                env.events().publish(
                    (symbol_short!("royalty"), symbol_short!("dist")),
                    (addr, payout, token.clone(), symbol_short!("batch")),
                );
            }

            env.events().publish(
                (symbol_short!("royalty"), symbol_short!("dist_all")),
                (token.clone(), amount),
            );
        }

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

        let new_count = current_count.saturating_add(tokens.len() as u64);
        storage::instance_set(&env, &StorageKey::DistributeHistory, &new_count);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("batch")),
            tokens.len(),
        );
        Ok(())
    }

    pub fn record_secondary_royalty(env: Env, token: Address, from: Address, royalty_amount: i128) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);
        auth::require_payer(&env, &from, auth::msg::RECORD_SECONDARY_PAYER);

        if royalty_amount <= 0 {
            return Err(ContractError::RoyaltyAmountNotPositive);
        }
        Self::require_approved_token(&env, &token)?; // #840

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
            .ok_or(ContractError::ArithmeticOverflow)?;

        storage::instance_set(&env, &StorageKey::SecondaryPool, &new_pool);
        storage::instance_set(&env, &StorageKey::SecondaryToken, &token);

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
        Ok(())
    }

    pub fn distribute_secondary(env: Env) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::DISTRIBUTE_SECONDARY_ADMIN);

        if Self::is_emergency_paused_flag(&env) {
            return Err(ContractError::EmergencyContractPaused);
        }
        if Self::is_blocked(&env, OperationType::SecondaryDistribution) {
            return Err(ContractError::ContractPaused);
        }

        if Self::get_total_shares(env.clone())? != 10_000 {
            return Err(ContractError::InvalidShareTotal);
        }

        let pool: i128 = env
            .storage()
            .instance()
            .get(&StorageKey::SecondaryPool)
            .unwrap_or(0);

        if pool == 0 {
            return Err(ContractError::NoSecondaryRoyalties);
        }

        let token: Address = env
            .storage()
            .instance()
            .get(&StorageKey::SecondaryToken)
            .ok_or(ContractError::NoSecondaryToken)?;

        if Self::trip_anomaly_pause_if_exceeded(&env, &token, pool) {
            return Ok(());
        }

        let token_client = token::Client::new(&env, &token);
        let balance = token_client.balance(&env.current_contract_address());

        if pool > balance {
            return Err(ContractError::PoolExceedsBalance);
        }

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
            let addr = collaborators.get(i).unwrap_optimized();
            let share = share_map.get(addr.clone()).unwrap_or(0);
            let payout = Self::checked_bps_amount(&env, pool, share)?;
            payouts.push_back((addr, payout));
            total_calculated = total_calculated
                .checked_add(payout)
                .ok_or(ContractError::ArithmeticOverflow)?;
        }

        let last = collaborators.get(n - 1).unwrap();
        payouts.push_back((
            last,
            pool.checked_sub(total_calculated)
                .ok_or(ContractError::ArithmeticOverflow)?,
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
        Ok(())
    }

    pub fn record_secondary_sale(env: Env, sale_price: i128) -> Result<i128, ContractError> {
        storage::extend_instance_ttl(&env);

        if sale_price <= 0 {
            return Err(ContractError::SalePriceNotPositive);
        }

        let rate: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::RoyaltyRate)
            .unwrap_or(0);

        Self::checked_bps_amount(&env, sale_price, rate)
    }

    pub fn get_royalty_rate(env: Env) -> u32 {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::RoyaltyRate)
            .unwrap_or(0)
    }

    pub fn get_recipients(env: Env) -> Vec<Recipient> {
        storage::extend_instance_ttl(&env);

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

    pub fn get_version(env: Env) -> Result<String, ContractError> {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::ContractVersion)
            .ok_or(ContractError::NotInitialized)
    }

    pub fn get_share(env: Env, collaborator: Address) -> Result<u32, ContractError> {
        storage::extend_instance_ttl(&env);
        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .expect("not initialized");

        share_map
            .get(collaborator)
            .ok_or(ContractError::CollaboratorNotFound)
    }

    pub fn update_share(env: Env, collaborator: Address, new_share: u32) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::UPDATE_SHARE_ADMIN);

        let mut share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .expect("not initialized");

        if !share_map.contains_key(collaborator.clone()) {
            return Err(ContractError::CollaboratorNotFound);
        }

        let old_share = share_map.get(collaborator.clone()).unwrap();
        let current_total = Self::get_total_shares(env.clone());
        let new_total = current_total?
            .checked_sub(old_share)
            .and_then(|remaining| remaining.checked_add(new_share))
            .ok_or(ContractError::ArithmeticOverflow)?;

        if new_total != 10_000 {
            return Err(ContractError::InvalidUpdatedShareTotal);
        }

        if new_share == 0 {
            return Err(ContractError::ZeroShare);
        }

        share_map.set(collaborator.clone(), new_share);
        storage::persistent_set(&env, &StorageKey::ShareMap, &share_map);

        env.events().publish(
            (symbol_short!("share"), symbol_short!("updated")),
            (collaborator, new_share),
        );
        Ok(())
    }

    pub fn is_collaborator(env: Env, addr: Address) -> bool {
        storage::extend_instance_ttl(&env);
        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .unwrap_or(Map::new(&env));

        share_map.contains_key(addr)
    }

    pub fn collaborator_count(env: Env) -> u32 {
        storage::extend_instance_ttl(&env);
        let collaborators: Vec<Address> =
            storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
                .unwrap_or(Vec::new(&env));
        collaborators.len()
    }

    pub fn get_collaborators(env: Env) -> Vec<Address> {
        storage::extend_instance_ttl(&env);
        storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_all_shares(env: Env) -> Map<Address, u32> {
        storage::extend_instance_ttl(&env);
        storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
            .unwrap_or(Map::new(&env))
    }

    pub fn get_secondary_pool(env: Env) -> i128 {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::SecondaryPool)
            .unwrap_or(0)
    }

    pub fn get_last_distribution(env: Env) -> Option<u64> {
        storage::extend_instance_ttl(&env);
        env.storage().instance().get(&StorageKey::LastDistribution)
    }

    pub fn get_last_secondary_dist(env: Env) -> Option<u64> {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::LastSecondaryDistribution)
    }

    pub fn get_total_shares(env: Env) -> Result<u32, ContractError> {
        storage::extend_instance_ttl(&env);
        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .expect("not initialized");

        let mut total = 0;
        for item in share_map.iter() {
            total = Self::checked_add_share_total(&env, total, item.1)?;
        }
        Ok(total)
    }

    pub fn set_admins(env: Env, admins: Vec<Address>, threshold: u32) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_ADMINS_ADMIN);

        if admins.is_empty() {
            panic!("admin list cannot be empty");
        }
        if admins.len() > MAX_ADMIN_LIST {
            return Err(ContractError::InputTooLarge);
        }
        if threshold < 1 {
            panic!("threshold must be at least 1");
        }
        if threshold > admins.len() as u32 {
            panic!("threshold > admin count");
        }

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
        Ok(())
    }

    pub fn get_admins(env: Env) -> Vec<Address> {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::AdminList)
            .unwrap_or(Vec::new(&env))
    }

    pub fn set_incentives_enabled(env: Env, enabled: bool) {
        storage::extend_instance_ttl(&env);
        Self::check_admin_auth(&env, auth::msg::SET_INCENTIVES_ENABLED_ADMIN);
        storage::instance_set(&env, &StorageKey::IncentivesEnabled, &enabled);
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("incn_set")),
            enabled,
        );
    }

    pub fn is_incentives_enabled(env: Env) -> bool {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::IncentivesEnabled)
            .unwrap_or(false)
    }

    pub fn get_contributor_join_date(env: Env, collaborator: Address) -> Option<u64> {
        storage::extend_instance_ttl(&env);
        let join_dates: Map<Address, u64> =
            storage::persistent_get::<Map<Address, u64>>(&env, &StorageKey::ContributorJoinDate)
                .unwrap_or(Map::new(&env));
        join_dates.get(collaborator)
    }

    pub fn get_contributor_activity_count(env: Env, collaborator: Address) -> u32 {
        storage::extend_instance_ttl(&env);
        let activity: Map<Address, u32> = storage::persistent_get::<Map<Address, u32>>(
            &env,
            &StorageKey::ContributorActivityCount,
        )
        .unwrap_or(Map::new(&env));
        activity.get(collaborator).unwrap_or(0)
    }

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

        let last = base.get(n - 1).unwrap();
        let last_share = 10_000u32
            .checked_sub(assigned_total)
            .expect("arithmetic overflow in incentive adjustment");
        adjusted.push_back(Recipient {
            address: last.address,
            share: last_share,
        });

        adjusted
    }

    pub fn distribute_with_incentives(env: Env, token: Address) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::DISTRIBUTE_INCENTIVES_ADMIN);

        let recipients = Self::calculate_incentive_shares(env.clone());
        Self::execute_distribution(env, token, recipients)?;
        Ok(())
    }

    fn execute_distribution(env: Env, token: Address, recipients: Vec<Recipient>) -> Result<(), ContractError> {
        if Self::is_blocked(&env, OperationType::PrimaryDistribution) {
            return Err(ContractError::ContractPaused);
        }

        let token_client = token::Client::new(&env, &token);
        let amount = token_client.balance(&env.current_contract_address());
        if amount == 0 {
            return Err(ContractError::Underfunded);
        }

        Self::validate_recipient_list(&env, &recipients)?;

        let n = recipients.len();
        if amount < n as i128 {
            return Err(ContractError::AmountTooSmall);
        }

        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;
        for i in 0..(n - 1) {
            let recipient = recipients.get(i).unwrap();
            let payout = Self::checked_bps_amount(&env, amount, recipient.share)?;
            payouts.push_back((recipient.address.clone(), payout));
            total_calculated = total_calculated
                .checked_add(payout)
                .ok_or(ContractError::ArithmeticOverflow)?;
        }
        let last = recipients.get(n - 1).unwrap();
        payouts.push_back((
            last.address.clone(),
            amount
                .checked_sub(total_calculated)
                .ok_or(ContractError::ArithmeticOverflow)?,
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
        Ok(())
    }

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

    pub fn cancel_admin_rotation(env: Env) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::CANCEL_ADMIN_ROTATION_ADMIN);

        let rotation: AdminRotation = env
            .storage()
            .instance()
            .get(&StorageKey::PendingAdminRotation)
            .expect("no pending admin rotation");

        env.storage()
            .instance()
            .remove(&StorageKey::PendingAdminRotation);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("rot_cncl")),
            rotation.new_admin,
        );
    }

    pub fn finalize_admin_rotation(env: Env) {
        storage::extend_instance_ttl(&env);

        let rotation: AdminRotation = env
            .storage()
            .instance()
            .get(&StorageKey::PendingAdminRotation)
            .expect("no pending admin rotation");

        let timelock = Self::admin_rotation_timelock(&env);
        let ready_at = rotation
            .initiated_at
            .checked_add(timelock)
            .expect("arithmetic overflow");

        if env.ledger().timestamp() < ready_at {
            panic!("admin rotation timelock not elapsed");
        }

        let previous_admin = Self::require_admin_address(&env).expect("not initialized");
        storage::instance_set(&env, &StorageKey::Admin, &rotation.new_admin);
        env.storage()
            .instance()
            .remove(&StorageKey::PendingAdminRotation);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("rot_fin")),
            (previous_admin, rotation.new_admin),
        );
    }

    pub fn get_pending_admin_rotation(env: Env) -> Option<AdminRotation> {
        storage::extend_instance_ttl(&env);
        env.storage().instance().get(&StorageKey::PendingAdminRotation)
    }

    pub fn set_admin_rotation_timelock(env: Env, seconds: u64) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_ADMIN_ROTATION_TIMELOCK_ADMIN);

        if seconds < MIN_ADMIN_ROTATION_TIMELOCK || seconds > MAX_ADMIN_ROTATION_TIMELOCK {
            panic!("invalid timelock duration");
        }

        storage::instance_set(&env, &StorageKey::AdminRotationTimelock, &seconds);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("rot_tlck")),
            seconds,
        );
    }

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

    pub fn set_anomaly_threshold(env: Env, max_amount: i128) {
        storage::extend_instance_ttl(&env);
        Self::check_admin_auth(&env, auth::msg::SET_ANOMALY_THRESHOLD_ADMIN);

        if max_amount <= 0 {
            panic!("invalid anomaly threshold");
        }

        storage::instance_set(&env, &StorageKey::AnomalyThreshold, &max_amount);
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("anom_set")),
            max_amount,
        );
    }

    pub fn clear_anomaly_threshold(env: Env) {
        storage::extend_instance_ttl(&env);
        Self::check_admin_auth(&env, auth::msg::SET_ANOMALY_THRESHOLD_ADMIN);
        env.storage().instance().remove(&StorageKey::AnomalyThreshold);
        env.events()
            .publish((symbol_short!("royalty"), symbol_short!("anom_clr")), ());
    }

    pub fn get_anomaly_threshold(env: Env) -> Option<i128> {
        storage::extend_instance_ttl(&env);
        env.storage().instance().get(&StorageKey::AnomalyThreshold)
    }

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

    pub fn trigger_emergency_pause(env: Env, reason: String) {
        storage::extend_instance_ttl(&env);
        Self::check_admin_auth(&env, auth::msg::TRIGGER_EMERGENCY_PAUSE_ADMIN);
        storage::instance_set(&env, &StorageKey::EmergencyPaused, &true);
        env.events()
            .publish((symbol_short!("royalty"), symbol_short!("emrg_set")), reason);
    }

    pub fn clear_emergency_pause(env: Env) {
        storage::extend_instance_ttl(&env);
        Self::require_emergency_clear_auth(&env);
        storage::instance_set(&env, &StorageKey::EmergencyPaused, &false);
        env.events()
            .publish((symbol_short!("royalty"), symbol_short!("emrg_clr")), ());
    }

    pub fn is_emergency_paused(env: Env) -> bool {
        storage::extend_instance_ttl(&env);
        Self::is_emergency_paused_flag(&env)
    }

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

    fn validate_unique_addresses(env: &Env, recipients: &Vec<Recipient>) -> Result<(), ContractError> {
        let mut address_set: Vec<Address> = Vec::new(env);

        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            for j in 0..address_set.len() {
                if address_set.get(j).unwrap() == recipient.address {
                    return Err(ContractError::DuplicateRecipient);
                }
            }
            address_set.push_back(recipient.address.clone());
        }
        Ok(())
    }

    fn validate_recipient_list(env: &Env, recipients: &Vec<Recipient>) -> Result<(), ContractError> {
        if recipients.is_empty() {
            return Err(ContractError::EmptyRecipients);
        }

        if recipients.len() > MAX_RECIPIENTS {
            return Err(ContractError::TooManyRecipients);
        }

        Self::validate_unique_addresses(env, recipients)?;

        let mut total_shares: u32 = 0;
        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();

            if recipient.share == 0 {
                return Err(ContractError::ZeroShare);
            }

            total_shares = Self::checked_add_share_total(env, total_shares, recipient.share)?;
        }

        if total_shares != 10_000 {
            return Err(ContractError::InvalidShareTotal);
        }
        Ok(())
    }

    fn validate_default_rcpt_bps(env: &Env, recipients: &Vec<Recipient>) -> Result<(), ContractError> {
        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            if recipient.share > 10_000 {
                return Err(ContractError::InvalidBasisPoints);
            }
        }
        Ok(())
    }

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
            .expect("not initialized");
        auth::require_admin(env, &admin, message);
    }

    // ─────────────────────────────────────────────────────────────────────
    // #840 — Token whitelist
    //
    // Whitelist (not blacklist): the contract's threat model is "accept only
    // tokens the admin has vetted", so an allow-list fails closed for unknown
    // tokens. An empty list means "no restriction" so the feature is opt-in
    // and existing deployments/tests are unaffected until an admin calls
    // `set_approved_tokens`.
    // ─────────────────────────────────────────────────────────────────────

    /// Admin: replace the approved-token whitelist. An empty `tokens` list
    /// disables the restriction (all tokens accepted).
    pub fn set_approved_tokens(env: Env, tokens: Vec<Address>) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);
        Self::check_admin_auth(&env, auth::msg::SET_APPROVED_TOKENS_ADMIN);

        if tokens.len() > MAX_APPROVED_TOKENS {
            return Err(ContractError::InputTooLarge);
        }
        // Reject duplicates so `is_token_approved` stays O(n) and small.
        let mut seen: Map<Address, bool> = Map::new(&env);
        for t in tokens.iter() {
            if seen.contains_key(t.clone()) {
                return Err(ContractError::DuplicateRecipient);
            }
            seen.set(t, true);
        }

        storage::persistent_set(&env, &StorageKey::ApprovedTokens, &tokens);
        env.events().publish(
            (symbol_short!("token"), symbol_short!("approved")),
            tokens.len(),
        );
        Ok(())
    }

    /// The current approved-token whitelist (empty = no restriction).
    pub fn get_approved_tokens(env: Env) -> Vec<Address> {
        storage::extend_instance_ttl(&env);
        storage::persistent_get::<Vec<Address>>(&env, &StorageKey::ApprovedTokens)
            .unwrap_or(Vec::new(&env))
    }

    /// Whether `token` may be used with the contract. `true` when the
    /// whitelist is empty (unset) or contains `token`.
    pub fn is_token_approved(env: Env, token: Address) -> bool {
        Self::token_is_approved(&env, &token)
    }

    fn token_is_approved(env: &Env, token: &Address) -> bool {
        let list: Vec<Address> =
            storage::persistent_get::<Vec<Address>>(env, &StorageKey::ApprovedTokens)
                .unwrap_or(Vec::new(env));
        if list.is_empty() {
            return true;
        }
        for t in list.iter() {
            if &t == token {
                return true;
            }
        }
        false
    }

    fn require_approved_token(env: &Env, token: &Address) -> Result<(), ContractError> {
        if Self::token_is_approved(env, token) {
            Ok(())
        } else {
            Err(ContractError::TokenNotApproved)
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // #841 — Dispute resolution & clawback
    //
    // A true on-chain "reverse the transfer" is impossible without the
    // recipient's authorization — the contract cannot pull tokens from an
    // arbitrary address. `clawback` therefore requires each `from` address to
    // sign; it is the enforcement mechanism for an off-chain
    // legal/compliance resolution, and `record_dispute` is the auditable
    // on-chain trail that a dispute was opened. Where a recipient will not
    // cooperate, the dispute stays `Resolved` (not `ClawedBack`) and recovery
    // is an off-chain matter.
    // ─────────────────────────────────────────────────────────────────────

    /// Admin: open a dispute against a past distribution. Returns the new id.
    pub fn record_dispute(
        env: Env,
        transaction_id: u64,
        reason: String,
        amount: i128,
    ) -> Result<u64, ContractError> {
        storage::extend_instance_ttl(&env);
        Self::check_admin_auth(&env, auth::msg::RECORD_DISPUTE_ADMIN);

        if amount <= 0 {
            return Err(ContractError::AmountNotPositive);
        }

        let opener: Address = Self::require_admin_address(&env)?;
        let now = env.ledger().timestamp();

        let mut disputes: Map<u64, Dispute> =
            storage::persistent_get::<Map<u64, Dispute>>(&env, &StorageKey::Disputes)
                .unwrap_or(Map::new(&env));
        let next_id: u64 = storage::persistent_get::<u64>(&env, &StorageKey::DisputeCount)
            .unwrap_or(0)
            + 1;

        let dispute = Dispute {
            transaction_id,
            reason,
            amount,
            status: DisputeStatus::Open,
            opened_by: opener,
            opened_at: now,
            resolved_at: 0,
        };
        disputes.set(next_id, dispute);
        storage::persistent_set(&env, &StorageKey::Disputes, &disputes);
        storage::persistent_set(&env, &StorageKey::DisputeCount, &next_id);

        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("opened")),
            (next_id, transaction_id, amount),
        );
        Ok(next_id)
    }

    /// All disputes recorded on the contract.
    pub fn get_disputes(env: Env) -> Vec<Dispute> {
        storage::extend_instance_ttl(&env);
        let disputes: Map<u64, Dispute> =
            storage::persistent_get::<Map<u64, Dispute>>(&env, &StorageKey::Disputes)
                .unwrap_or(Map::new(&env));
        let mut out: Vec<Dispute> = Vec::new(&env);
        for (_, d) in disputes.iter() {
            out.push_back(d);
        }
        out
    }

    /// Admin: close a dispute without moving funds (off-chain resolution).
    pub fn resolve_dispute(env: Env, dispute_id: u64) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);
        Self::check_admin_auth(&env, auth::msg::RESOLVE_DISPUTE_ADMIN);
        Self::close_dispute(&env, dispute_id, DisputeStatus::Resolved)
    }

    /// Admin: reverse a distribution by pulling `amounts[i]` of `token` back
    /// from `from[i]` into the contract. Each `from[i]` must authorize the
    /// transfer (Soroban cannot force a pull). Marks the dispute `ClawedBack`.
    pub fn clawback(
        env: Env,
        dispute_id: u64,
        token: Address,
        from: Vec<Address>,
        amounts: Vec<i128>,
    ) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);
        Self::check_admin_auth(&env, auth::msg::CLAWBACK_ADMIN);

        if from.len() != amounts.len() {
            return Err(ContractError::LengthMismatch);
        }
        if from.len() > MAX_RECIPIENTS {
            return Err(ContractError::TooManyRecipients);
        }

        let contract = env.current_contract_address();
        let token_client = token::Client::new(&env, &token);
        for i in 0..from.len() {
            let addr = from.get(i).unwrap_optimized();
            let amount = amounts.get(i).unwrap_optimized();
            if amount <= 0 {
                return Err(ContractError::AmountNotPositive);
            }
            addr.require_auth();
            token_client.transfer(&addr, &contract, &amount);
        }

        Self::close_dispute(&env, dispute_id, DisputeStatus::ClawedBack)?;
        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("clawback")),
            (dispute_id, token),
        );
        Ok(())
    }

    fn close_dispute(
        env: &Env,
        dispute_id: u64,
        status: DisputeStatus,
    ) -> Result<(), ContractError> {
        let mut disputes: Map<u64, Dispute> =
            storage::persistent_get::<Map<u64, Dispute>>(env, &StorageKey::Disputes)
                .ok_or(ContractError::DisputeNotFound)?;
        let mut d = disputes
            .get(dispute_id)
            .ok_or(ContractError::DisputeNotFound)?;
        if d.status != DisputeStatus::Open {
            return Err(ContractError::DisputeAlreadyResolved);
        }
        d.status = status;
        d.resolved_at = env.ledger().timestamp();
        disputes.set(dispute_id, d);
        storage::persistent_set(env, &StorageKey::Disputes, &disputes);
        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("resolved")),
            dispute_id,
        );
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────
    // #842 — Governance: propose / vote / execute royalty-rate changes
    //
    // Votes are weighted by the collaborator's share (basis points). A
    // proposal passes when `yes_weight` exceeds half of TOTAL_SHARE_WEIGHT
    // (a strict majority of *all* share, so abstentions count against) and
    // the deadline has passed; it fails otherwise. Execution is
    // permissionless (`execute_proposal`) and applies the same validation
    // `set_royalty_rate` does.
    // ─────────────────────────────────────────────────────────────────────

    /// A collaborator proposes a new royalty rate. `duration` is the voting
    /// window in seconds. Returns the proposal id.
    pub fn propose_rate_change(
        env: Env,
        proposer: Address,
        new_rate: u32,
        duration: u64,
    ) -> Result<u64, ContractError> {
        storage::extend_instance_ttl(&env);
        proposer.require_auth();

        let share_map: Map<Address, u32> = storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap).ok_or(ContractError::NoShareMap)?;
        if !share_map.contains_key(proposer.clone()) {
            return Err(ContractError::CollaboratorNotFound);
        }
        if new_rate == 0 {
            return Err(ContractError::RoyaltyRateZero);
        }
        if new_rate > 10_000 {
            return Err(ContractError::RoyaltyRateTooHigh);
        }
        if duration < MIN_PROPOSAL_DURATION || duration > MAX_PROPOSAL_DURATION {
            return Err(ContractError::InvalidProposalDuration);
        }

        let now = env.ledger().timestamp();
        let id: u64 = storage::instance_get::<u64>(&env, &StorageKey::ProposalCount)
            .unwrap_or(0)
            + 1;

        let proposal = Proposal {
            id,
            kind: ProposalKind::RoyaltyRateChange,
            new_rate,
            proposer: proposer.clone(),
            created_at: now,
            deadline: now.saturating_add(duration),
            yes_weight: 0,
            no_weight: 0,
            executed: false,
            rejected: false,
        };

        let mut proposals: Map<u64, Proposal> =
            storage::persistent_get::<Map<u64, Proposal>>(&env, &StorageKey::Proposals)
                .unwrap_or(Map::new(&env));
        proposals.set(id, proposal);
        storage::persistent_set(&env, &StorageKey::Proposals, &proposals);
        storage::instance_set(&env, &StorageKey::ProposalCount, &id);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("proposed")),
            (id, new_rate, now.saturating_add(duration)),
        );
        Ok(id)
    }

    /// A collaborator casts a share-weighted vote. One vote per collaborator
    /// per proposal.
    pub fn vote(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: bool,
    ) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);
        voter.require_auth();

        let share_map: Map<Address, u32> = storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap).ok_or(ContractError::NoShareMap)?;
        let weight = share_map
            .get(voter.clone())
            .ok_or(ContractError::CollaboratorNotFound)?;

        let mut proposals: Map<u64, Proposal> =
            storage::persistent_get::<Map<u64, Proposal>>(&env, &StorageKey::Proposals)
                .ok_or(ContractError::ProposalNotFound)?;
        let mut proposal = proposals
            .get(proposal_id)
            .ok_or(ContractError::ProposalNotFound)?;

        if proposal.executed || proposal.rejected {
            return Err(ContractError::ProposalAlreadyExecuted);
        }
        if env.ledger().timestamp() >= proposal.deadline {
            return Err(ContractError::ProposalVotingClosed);
        }

        let mut votes: Map<u64, Map<Address, bool>> =
            storage::persistent_get::<Map<u64, Map<Address, bool>>>(
                &env,
                &StorageKey::ProposalVotes,
            )
            .unwrap_or(Map::new(&env));
        let mut proposal_votes: Map<Address, bool> =
            votes.get(proposal_id).unwrap_or(Map::new(&env));
        if proposal_votes.contains_key(voter.clone()) {
            return Err(ContractError::AlreadyVoted);
        }
        proposal_votes.set(voter.clone(), support);
        votes.set(proposal_id, proposal_votes);
        storage::persistent_set(&env, &StorageKey::ProposalVotes, &votes);

        if support {
            proposal.yes_weight = proposal.yes_weight.saturating_add(weight);
        } else {
            proposal.no_weight = proposal.no_weight.saturating_add(weight);
        }
        proposals.set(proposal_id, proposal.clone());
        storage::persistent_set(&env, &StorageKey::Proposals, &proposals);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("voted")),
            (proposal_id, voter, support, weight),
        );
        Ok(())
    }

    /// Permissionless: finalize a proposal once its deadline has passed.
    /// Applies the rate change on a majority-yes, otherwise marks it rejected.
    pub fn execute_proposal(env: Env, proposal_id: u64) -> Result<(), ContractError> {
        storage::extend_instance_ttl(&env);

        let mut proposals: Map<u64, Proposal> =
            storage::persistent_get::<Map<u64, Proposal>>(&env, &StorageKey::Proposals)
                .ok_or(ContractError::ProposalNotFound)?;
        let mut proposal = proposals
            .get(proposal_id)
            .ok_or(ContractError::ProposalNotFound)?;

        if proposal.executed || proposal.rejected {
            return Err(ContractError::ProposalAlreadyExecuted);
        }
        if env.ledger().timestamp() < proposal.deadline {
            return Err(ContractError::ProposalStillOpen);
        }

        // Strict majority of the *whole* collaborator share weight.
        let passed = proposal.yes_weight > TOTAL_SHARE_WEIGHT / 2
            && proposal.yes_weight > proposal.no_weight;

        if !passed {
            // Rejection is a persisted terminal outcome, not an error — an
            // `Err` return would roll back this write.
            proposal.rejected = true;
            proposals.set(proposal_id, proposal.clone());
            storage::persistent_set(&env, &StorageKey::Proposals, &proposals);
            env.events().publish(
                (symbol_short!("gov"), symbol_short!("rejected")),
                proposal_id,
            );
            return Ok(());
        }

        // Apply — mirrors set_royalty_rate's storage + history.
        let old_rate: u32 = storage::instance_get::<u32>(&env, &StorageKey::RoyaltyRate).unwrap_or(0);
        storage::instance_set(&env, &StorageKey::RoyaltyRate, &proposal.new_rate);

        let mut history: Vec<RoyaltyRateChange> =
            storage::persistent_get::<Vec<RoyaltyRateChange>>(&env, &StorageKey::RoyaltyRateHistory)
                .unwrap_or(Vec::new(&env));
        if history.len() >= RATE_HISTORY_CAP {
            let mut trimmed: Vec<RoyaltyRateChange> = Vec::new(&env);
            for i in 1..history.len() {
                trimmed.push_back(history.get(i).unwrap());
            }
            history = trimmed;
        }
        history.push_back(RoyaltyRateChange {
            old_rate,
            new_rate: proposal.new_rate,
            timestamp: env.ledger().timestamp(),
            caller: proposal.proposer.clone(),
        });
        storage::persistent_set(&env, &StorageKey::RoyaltyRateHistory, &history);

        proposal.executed = true;
        proposals.set(proposal_id, proposal.clone());
        storage::persistent_set(&env, &StorageKey::Proposals, &proposals);

        env.events().publish(
            (symbol_short!("gov"), symbol_short!("executed")),
            (proposal_id, proposal.new_rate),
        );
        Ok(())
    }

    /// A single proposal by id.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, ContractError> {
        storage::extend_instance_ttl(&env);
        storage::persistent_get::<Map<u64, Proposal>>(&env, &StorageKey::Proposals)
            .ok_or(ContractError::ProposalNotFound)?
            .get(proposal_id)
            .ok_or(ContractError::ProposalNotFound)
    }

    // ─────────────────────────────────────────────────────────────────────
    // #844 — M-of-N multi-sig for critical admin functions
    //
    // Already enforced by `check_admin_auth`: when `AdminList` is non-empty
    // it calls `require_auth()` on the first `AdminThreshold` entries, so
    // every admin-gated function (pause, admin_transfer, set_royalty_rate,
    // withdraw, distribute*, …) needs M signatures in the transaction's auth.
    // Soroban's host aggregates the M authorizations; there is no partial
    // on-chain signature accumulation to store or replay-protect. This view
    // exposes the active configuration.
    // ─────────────────────────────────────────────────────────────────────

    /// `(signers, threshold)` for the M-of-N admin policy. `signers` is empty
    /// when the contract is still on the single-key admin.
    pub fn get_admin_config(env: Env) -> (Vec<Address>, u32) {
        storage::extend_instance_ttl(&env);
        let signers: Vec<Address> = storage::instance_get::<Vec<Address>>(&env, &StorageKey::AdminList)
            .unwrap_or(Vec::new(&env));
        let threshold: u32 = if signers.is_empty() {
            1
        } else {
            storage::instance_get::<u32>(&env, &StorageKey::AdminThreshold).unwrap_or(1)
        };
        (signers, threshold)
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

        assert!(recipients_eq(&client.calculate_incentive_shares(), &client.get_recipients()));
    }

    #[test]
    fn activity_bonus_accrues_from_recorded_secondary_royalties() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (contract_id, a, _b, client) = setup(&env);
        client.set_incentives_enabled(&true);

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
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    fn setup(env: &Env) -> (Address, Address, RoyaltySplitterClient<'_>) {
        let contract_id = env.register_contract(None, RoyaltySplitter);
        let client = RoyaltySplitterClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let b = Address::generate(env);
        client.initialize(
            &Vec::from_array(env, [admin.clone(), b]),
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
}

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
}

#[cfg(test)]
mod emergency_pause_tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
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

        client.set_admins(&Vec::from_array(&env, [a, b]), &1);
        client.trigger_emergency_pause(&String::from_str(&env, "test"));

        client.clear_emergency_pause();
        assert!(!client.is_emergency_paused());
    }
}

// ─────────────────────────────────────────────────────────────────────────
// #840 — Token whitelist
// ─────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod approved_token_tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::token::StellarAssetClient;

    fn setup(env: &Env) -> (Address, RoyaltySplitterClient<'_>) {
        let contract_id = env.register_contract(None, RoyaltySplitter);
        let client = RoyaltySplitterClient::new(env, &contract_id);
        let a = Address::generate(env);
        let b = Address::generate(env);
        client.initialize(
            &Vec::from_array(env, [a, b]),
            &Vec::from_array(env, [6_000u32, 4_000u32]),
        );
        (contract_id, client)
    }

    fn asset(env: &Env, to: &Address, amount: i128) -> Address {
        let token = env.register_stellar_asset_contract(Address::generate(env));
        StellarAssetClient::new(env, &token).mint(to, &amount);
        token
    }

    #[test]
    fn empty_whitelist_means_no_restriction() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, client) = setup(&env);
        let token = asset(&env, &contract_id, 10_000);

        assert!(client.get_approved_tokens().is_empty());
        assert!(client.is_token_approved(&token));
        client.distribute(&token); // unaffected
        assert_eq!(client.get_distribute_count(), 1);
    }

    #[test]
    fn distribute_rejects_unapproved_token_once_whitelist_is_set() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, client) = setup(&env);
        let approved = asset(&env, &contract_id, 10_000);
        let other = asset(&env, &contract_id, 10_000);

        client.set_approved_tokens(&Vec::from_array(&env, [approved.clone()]));
        assert!(client.is_token_approved(&approved));
        assert!(!client.is_token_approved(&other));

        assert_eq!(
            client.try_distribute(&other),
            Err(Ok(ContractError::TokenNotApproved))
        );
        client.distribute(&approved); // approved one still works
    }

    #[test]
    fn whitelist_rejects_duplicates_and_oversized_lists() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup(&env);
        let t = Address::generate(&env);
        assert_eq!(
            client.try_set_approved_tokens(&Vec::from_array(&env, [t.clone(), t])),
            Err(Ok(ContractError::DuplicateRecipient))
        );
    }

    #[test]
    fn whitelist_can_be_cleared() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, client) = setup(&env);
        let token = asset(&env, &contract_id, 10_000);
        client.set_approved_tokens(&Vec::from_array(&env, [Address::generate(&env)]));
        assert!(!client.is_token_approved(&token));
        client.set_approved_tokens(&Vec::new(&env));
        assert!(client.is_token_approved(&token));
    }
}

// ─────────────────────────────────────────────────────────────────────────
// #841 — Dispute resolution & clawback
// ─────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod dispute_tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};

    fn setup(env: &Env) -> (Address, RoyaltySplitterClient<'_>) {
        let contract_id = env.register_contract(None, RoyaltySplitter);
        let client = RoyaltySplitterClient::new(env, &contract_id);
        client.initialize(
            &Vec::from_array(env, [Address::generate(env), Address::generate(env)]),
            &Vec::from_array(env, [6_000u32, 4_000u32]),
        );
        (contract_id, client)
    }

    #[test]
    fn record_then_resolve_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup(&env);

        let id = client.record_dispute(&42u64, &String::from_str(&env, "chargeback"), &500i128);
        assert_eq!(id, 1);
        let disputes = client.get_disputes();
        assert_eq!(disputes.len(), 1);
        assert_eq!(disputes.get(0).unwrap().status, DisputeStatus::Open);

        client.resolve_dispute(&id);
        assert_eq!(
            client.get_disputes().get(0).unwrap().status,
            DisputeStatus::Resolved
        );
        assert_eq!(
            client.try_resolve_dispute(&id),
            Err(Ok(ContractError::DisputeAlreadyResolved))
        );
    }

    #[test]
    fn record_dispute_rejects_non_positive_amount() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup(&env);
        assert_eq!(
            client.try_record_dispute(&1u64, &String::from_str(&env, "x"), &0i128),
            Err(Ok(ContractError::AmountNotPositive))
        );
    }

    #[test]
    fn clawback_pulls_funds_back_and_marks_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, client) = setup(&env);

        let token = env.register_stellar_asset_contract(Address::generate(&env));
        let recipient = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&recipient, &800);

        let id = client.record_dispute(&7u64, &String::from_str(&env, "fraud"), &800i128);
        client.clawback(
            &id,
            &token,
            &Vec::from_array(&env, [recipient.clone()]),
            &Vec::from_array(&env, [800i128]),
        );

        assert_eq!(TokenClient::new(&env, &token).balance(&recipient), 0);
        assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 800);
        assert_eq!(
            client.get_disputes().get(0).unwrap().status,
            DisputeStatus::ClawedBack
        );
    }

    #[test]
    fn clawback_rejects_length_mismatch() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup(&env);
        let token = env.register_stellar_asset_contract(Address::generate(&env));
        let id = client.record_dispute(&1u64, &String::from_str(&env, "x"), &10i128);
        assert_eq!(
            client.try_clawback(
                &id,
                &token,
                &Vec::from_array(&env, [Address::generate(&env)]),
                &Vec::new(&env),
            ),
            Err(Ok(ContractError::LengthMismatch))
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────
// #842 — Governance: propose / vote / execute
// ─────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod governance_tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

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
    fn majority_yes_executes_rate_change() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, a, _b, client) = setup(&env);

        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let id = client.propose_rate_change(&a, &750u32, &MIN_PROPOSAL_DURATION);
        client.vote(&a, &id, &true); // 6000 weight yes

        assert_eq!(
            client.try_execute_proposal(&id),
            Err(Ok(ContractError::ProposalStillOpen))
        );

        env.ledger()
            .with_mut(|l| l.timestamp = 1_000 + MIN_PROPOSAL_DURATION);
        client.execute_proposal(&id);

        assert_eq!(client.get_royalty_rate(), 750);
        assert!(client.get_proposal(&id).executed);
    }

    #[test]
    fn rejected_when_yes_weight_below_half() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _a, b, client) = setup(&env);

        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let id = client.propose_rate_change(&b, &750u32, &MIN_PROPOSAL_DURATION);
        client.vote(&b, &id, &true); // only 4000 weight

        env.ledger()
            .with_mut(|l| l.timestamp = 1_000 + MIN_PROPOSAL_DURATION);
        client.execute_proposal(&id);
        assert!(client.get_proposal(&id).rejected);
        assert!(!client.get_proposal(&id).executed);
        assert_eq!(client.get_royalty_rate(), 0); // unchanged (never set)

        // A finalized proposal cannot be re-run.
        assert_eq!(
            client.try_execute_proposal(&id),
            Err(Ok(ContractError::ProposalAlreadyExecuted))
        );
    }

    #[test]
    fn double_voting_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, a, _b, client) = setup(&env);
        let id = client.propose_rate_change(&a, &750u32, &MIN_PROPOSAL_DURATION);
        client.vote(&a, &id, &true);
        assert_eq!(
            client.try_vote(&a, &id, &false),
            Err(Ok(ContractError::AlreadyVoted))
        );
    }

    #[test]
    fn non_collaborator_cannot_propose_or_vote() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, a, _b, client) = setup(&env);
        let stranger = Address::generate(&env);
        assert_eq!(
            client.try_propose_rate_change(&stranger, &750u32, &MIN_PROPOSAL_DURATION),
            Err(Ok(ContractError::CollaboratorNotFound))
        );
        let id = client.propose_rate_change(&a, &750u32, &MIN_PROPOSAL_DURATION);
        assert_eq!(
            client.try_vote(&stranger, &id, &true),
            Err(Ok(ContractError::CollaboratorNotFound))
        );
    }

    #[test]
    fn proposal_duration_is_bounded() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, a, _b, client) = setup(&env);
        assert_eq!(
            client.try_propose_rate_change(&a, &750u32, &(MIN_PROPOSAL_DURATION - 1)),
            Err(Ok(ContractError::InvalidProposalDuration))
        );
        assert_eq!(
            client.try_propose_rate_change(&a, &750u32, &(MAX_PROPOSAL_DURATION + 1)),
            Err(Ok(ContractError::InvalidProposalDuration))
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────
// #844 — M-of-N multi-sig admin policy
// ─────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod multisig_admin_tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup(env: &Env, n: usize) -> (Vec<Address>, RoyaltySplitterClient<'_>) {
        let contract_id = env.register_contract(None, RoyaltySplitter);
        let client = RoyaltySplitterClient::new(env, &contract_id);
        client.initialize(
            &Vec::from_array(env, [Address::generate(env), Address::generate(env)]),
            &Vec::from_array(env, [6_000u32, 4_000u32]),
        );
        let mut signers = Vec::new(env);
        for _ in 0..n {
            signers.push_back(Address::generate(env));
        }
        (signers, client)
    }

    #[test]
    fn default_config_is_single_key() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup(&env, 0);
        let (signers, threshold) = client.get_admin_config();
        assert!(signers.is_empty());
        assert_eq!(threshold, 1);
    }

    #[test]
    fn m_of_n_2_of_3() {
        let env = Env::default();
        env.mock_all_auths();
        let (signers, client) = setup(&env, 3);
        client.set_admins(&signers, &2u32);

        let (stored, threshold) = client.get_admin_config();
        assert_eq!(stored.len(), 3);
        assert_eq!(threshold, 2);

        // A critical function now runs under the M-of-N policy.
        client.set_royalty_rate(&500u32);
        assert_eq!(client.get_royalty_rate(), 500);
    }

    #[test]
    fn m_of_n_3_of_5() {
        let env = Env::default();
        env.mock_all_auths();
        let (signers, client) = setup(&env, 5);
        client.set_admins(&signers, &3u32);

        let (stored, threshold) = client.get_admin_config();
        assert_eq!(stored.len(), 5);
        assert_eq!(threshold, 3);

        client.pause();
        assert!(client.is_paused());
        client.unpause();
    }
}