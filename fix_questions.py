import re

with open('src/lib.rs', 'r') as f:
    content = f.read()

# Fix payout? missing where payout is Result
content = re.sub(
    r'\.checked_add\(payout\)',
    r'.checked_add(payout?)',
    content
)
content = re.sub(
    r'payouts\.push_back\(\(recipient\.address\.clone\(\), payout\)\);',
    r'payouts.push_back((recipient.address.clone(), payout?));',
    content
)
content = re.sub(
    r'payouts\.push_back\(\(addr, payout\)\);',
    r'payouts.push_back((addr, payout?));',
    content
)
content = re.sub(
    r'payouts\.push_back\(\(collaborator_addr, payout\)\);',
    r'payouts.push_back((collaborator_addr, payout?));',
    content
)

# Fix checked_add_share_total missing ?
content = re.sub(
    r'total_shares = Self::checked_add_share_total\((\s*&?env,\s*total_shares,\s*[^)]+)\);',
    r'total_shares = Self::checked_add_share_total(\1)?;',
    content
)
content = re.sub(
    r'total = Self::checked_add_share_total\(&env, total, item\.1\);',
    r'total = Self::checked_add_share_total(&env, total, item.1)?;',
    content
)
content = re.sub(
    r'total_shares = Self::checked_add_share_total\(env, total_shares, recipient\.share\);',
    r'total_shares = Self::checked_add_share_total(env, total_shares, recipient.share)?;',
    content
)

with open('src/lib.rs', 'w') as f:
    f.write(content)
