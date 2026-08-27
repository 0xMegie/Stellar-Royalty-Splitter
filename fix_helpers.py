import re

with open('src/lib.rs', 'r') as f:
    content = f.read()

# Fix require_admin_address
content = re.sub(
    r'fn require_admin_address\(env: &Env\) -> Address \{',
    r'fn require_admin_address(env: &Env) -> Result<Address, ContractError> {',
    content
)
# Update callers of require_admin_address
content = re.sub(
    r'let admin = Self::require_admin_address\(&env\);',
    r'let admin = Self::require_admin_address(&env)?;',
    content
)

# Fix require_collaborators
content = re.sub(
    r'fn require_collaborators\(env: &Env\) -> Vec<Address> \{',
    r'fn require_collaborators(env: &Env) -> Result<Vec<Address>, ContractError> {',
    content
)
content = re.sub(
    r'let collaborators = Self::require_collaborators\(&env\);',
    r'let collaborators = Self::require_collaborators(&env)?;',
    content
)
content = re.sub(
    r'let collaborators = Self::require_collaborators\(env\);',
    r'let collaborators = Self::require_collaborators(env)?;',
    content
)

# Fix require_share_map
content = re.sub(
    r'fn require_share_map\(env: &Env\) -> Map<Address, u32> \{',
    r'fn require_share_map(env: &Env) -> Result<Map<Address, u32>, ContractError> {',
    content
)
content = re.sub(
    r'let mut share_map = Self::require_share_map\(&env\);',
    r'let mut share_map = Self::require_share_map(&env)?;',
    content
)
content = re.sub(
    r'let share_map = Self::require_share_map\(&env\);',
    r'let share_map = Self::require_share_map(&env)?;',
    content
)

# Fix checked_add_share_total
content = re.sub(
    r'fn checked_add_share_total\(env: &Env, total: u32, share: u32\) -> u32 \{',
    r'fn checked_add_share_total(env: &Env, total: u32, share: u32) -> Result<u32, ContractError> {',
    content
)
# Change the return statement inside checked_add_share_total to Ok(...)
content = re.sub(
    r'(?s)fn checked_add_share_total\(env: &Env, total: u32, share: u32\) -> Result<u32, ContractError> \{\s*(.*?\.ok_or.*?)\n    \}',
    r'fn checked_add_share_total(env: &Env, total: u32, share: u32) -> Result<u32, ContractError> {\n        Ok(\1)\n    }',
    content
)
# Update callers of checked_add_share_total
content = re.sub(
    r'total_shares = Self::checked_add_share_total\(&env, total_shares, share\);',
    r'total_shares = Self::checked_add_share_total(&env, total_shares, share)?;',
    content
)
content = re.sub(
    r'total_shares = Self::checked_add_share_total\(env, total_shares, \*share\);',
    r'total_shares = Self::checked_add_share_total(env, total_shares, *share)?;',
    content
)


# Fix checked_bps_amount
content = re.sub(
    r'fn checked_bps_amount\(env: &Env, amount: i128, bps: u32\) -> i128 \{',
    r'fn checked_bps_amount(env: &Env, amount: i128, bps: u32) -> Result<i128, ContractError> {',
    content
)
# End of checked_bps_amount
content = re.sub(
    r'        res\.unwrap_or_else\(\|\| return Err\(ContractError::ArithmeticOverflow\)\)\n    \}',
    r'        res.ok_or(ContractError::ArithmeticOverflow)\n    }',
    content
)
content = re.sub(
    r'let royalty = Self::checked_bps_amount\(&env, amount, rate\);',
    r'let royalty = Self::checked_bps_amount(&env, amount, rate)?;',
    content
)
content = re.sub(
    r'let share_amount = Self::checked_bps_amount\(&env, net_amount, share\);',
    r'let share_amount = Self::checked_bps_amount(&env, net_amount, share)?;',
    content
)
content = re.sub(
    r'let share_amount = Self::checked_bps_amount\(&env, pool_amount, share\);',
    r'let share_amount = Self::checked_bps_amount(&env, pool_amount, share)?;',
    content
)

# Fix initialize_validated (it is currently `fn initialize_validated(env: &Env, ...)` and needs Result)
content = re.sub(
    r'fn initialize_validated\(env: &Env, collaborators: Vec<Address>, shares: Vec<u32>\) \{',
    r'fn initialize_validated(env: &Env, collaborators: Vec<Address>, shares: Vec<u32>) -> Result<(), ContractError> {',
    content
)
# Update callers to initialize_validated
content = re.sub(
    r'Self::initialize_validated\(&env, collaborators, shares\);',
    r'Self::initialize_validated(&env, collaborators, shares)?;',
    content
)
content = re.sub(
    r'Self::initialize_validated\(env, collaborators, shares\);',
    r'Self::initialize_validated(env, collaborators, shares)?;',
    content
)
# Add Ok(()) to initialize_validated (tricky, but it ends around line 290 before `pub fn initialize_validated`)
# We can just manually replace the last line before `pub fn initialize`
content = content.replace(
    'env.storage().instance().set(&StorageKey::Admin, &admin);\n    }\n\n    /// Initialize the contract',
    'env.storage().instance().set(&StorageKey::Admin, &admin);\n        Ok(())\n    }\n\n    /// Initialize the contract'
)

# Fix get_share
content = re.sub(
    r'pub fn get_share\(env: Env, collaborator: Address\) -> u32 \{',
    r'pub fn get_share(env: Env, collaborator: Address) -> Result<u32, ContractError> {',
    content
)
content = re.sub(
    r'\.ok_or\(ContractError::CollaboratorNotFound\)\?\n    \}',
    r'.ok_or(ContractError::CollaboratorNotFound)\n    }',
    content
)

# Fix record_secondary_sale
content = re.sub(
    r'pub fn record_secondary_sale\(env: Env, sale_price: i128\) -> i128 \{',
    r'pub fn record_secondary_sale(env: Env, sale_price: i128) -> Result<i128, ContractError> {',
    content
)
# Change the return val of record_secondary_sale
content = re.sub(
    r'        royalty_amount\n    \}',
    r'        Ok(royalty_amount)\n    }',
    content
)

with open('src/lib.rs', 'w') as f:
    f.write(content)
