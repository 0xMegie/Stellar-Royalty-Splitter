import re

with open('src/lib.rs', 'r') as f:
    content = f.read()

# Fix validate_initialize
content = re.sub(
    r'fn validate_initialize\(env: &Env, collaborators: &Vec<Address>, shares: &Vec<u32>\) \{',
    r'fn validate_initialize(env: &Env, collaborators: &Vec<Address>, shares: &Vec<u32>) -> Result<(), ContractError> {',
    content
)
# Add Ok(()) to validate_initialize
content = re.sub(
    r'(?s)fn validate_initialize.*?        if total != 10_000 \{\n            return Err\(ContractError::InvalidShareTotal\);\n        \}\n    \}',
    lambda m: m.group(0).replace('    }', '        Ok(())\n    }'),
    content
)

# Fix checked_add_share_total missing ? at line 243
content = re.sub(
    r'total = Self::checked_add_share_total\(env, total, share\);',
    r'total = Self::checked_add_share_total(env, total, share)?;',
    content
)

# Fix checked_bps_amount result return
content = re.sub(
    r'        result as i128\n    \}',
    r'        Ok(result as i128)\n    }',
    content
)

# Fix get_total_shares called in update_share (line 1564) and check in line 1363
content = re.sub(
    r'Self::get_total_shares\(env\.clone\(\)\) != 10_000',
    r'Self::get_total_shares(env.clone())? != 10_000',
    content
)
content = re.sub(
    r'let new_total = current_total\n            \.checked_sub\(old_share\)',
    r'let new_total = current_total?\n            .checked_sub(old_share)',
    content
)
content = re.sub(
    r'let new_total = current_total\.checked_sub\(old_share\)',
    r'let new_total = current_total?.checked_sub(old_share)',
    content
)

with open('src/lib.rs', 'w') as f:
    f.write(content)
