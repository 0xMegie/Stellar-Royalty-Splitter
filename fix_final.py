import re

with open('src/lib.rs', 'r') as f:
    content = f.read()

# Fix pause, unpause, pause_operation, unpause_operation signatures
content = re.sub(
    r'pub fn (pause|unpause)\(env: Env\) \{',
    r'pub fn \1(env: Env) -> Result<(), ContractError> {',
    content
)
content = re.sub(
    r'pub fn (pause_operation|unpause_operation)\(env: Env, operation: OperationType\) \{',
    r'pub fn \1(env: Env, operation: OperationType) -> Result<(), ContractError> {',
    content
)

# Fix get_admin and get_total_shares signatures
content = re.sub(
    r'pub fn get_admin\(env: Env\) -> Address \{',
    r'pub fn get_admin(env: Env) -> Result<Address, ContractError> {',
    content
)
content = re.sub(
    r'Self::require_admin_address\(&env\)\n    \}',
    r'Self::require_admin_address(&env)\n    }',
    content
)
# Wait, require_admin_address returns Result, so get_admin is just `Self::require_admin_address(&env)` without `?`
# which automatically returns Result.

content = re.sub(
    r'pub fn get_total_shares\(env: Env\) -> u32 \{',
    r'pub fn get_total_shares(env: Env) -> Result<u32, ContractError> {',
    content
)

# For get_total_shares, return Ok(total)
content = re.sub(
    r'(?s)pub fn get_total_shares.*?total\n    \}',
    lambda m: m.group(0).replace('total\n    }', 'Ok(total)\n    }'),
    content
)

# For pause/unpause, insert Ok(())
def add_ok(name, text):
    pattern = r'(?s)pub fn ' + name + r'.*?    \}'
    def repl(m):
        t = m.group(0)
        t = t[:t.rfind('}')] + '    Ok(())\n    }'
        return t
    return re.sub(pattern, repl, text)

content = add_ok('pause', content)
content = add_ok('unpause', content)
content = add_ok('pause_operation', content)
content = add_ok('unpause_operation', content)

# Fix total_shares at line 1193
content = re.sub(
    r'total_shares = Self::checked_add_share_total\(\s*&env,\s*total_shares,\s*recipients_to_use\.get\(i\)\.unwrap\(\)\.share,\s*\);',
    r'total_shares = Self::checked_add_share_total(&env, total_shares, recipients_to_use.get(i).unwrap().share)?;',
    content
)

with open('src/lib.rs', 'w') as f:
    f.write(content)
