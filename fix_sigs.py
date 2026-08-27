import re

with open('src/lib.rs', 'r') as f:
    lines = f.readlines()

def fix_func(name, new_ret, returns_value=False):
    for i, line in enumerate(lines):
        if re.search(r'\bpub fn ' + name + r'\(', line):
            # Check if it already has a return type
            if '->' in line:
                line = re.sub(r'->\s*([^{]+)\s*\{', f'-> Result<\\1, ContractError> {{', line)
            else:
                line = re.sub(r'\s*\{', f' -> {new_ret} {{', line)
            lines[i] = line
            
            # Find the end of the function and insert Ok(...)
            # This is tricky without a proper parser. We will just look for the matching closing brace.
            brace_count = 0
            found_start = False
            for j in range(i, len(lines)):
                if '{' in lines[j]:
                    brace_count += lines[j].count('{')
                    found_start = True
                if '}' in lines[j]:
                    brace_count -= lines[j].count('}')
                if found_start and brace_count == 0:
                    if returns_value:
                        # Assuming the last expression was the return value, we might need to wrap it.
                        # It's better to just manually fix the ones that return a value.
                        pass
                    else:
                        lines.insert(j, '        Ok(())\n')
                    break
            break

fix_func('initialize', 'Result<(), ContractError>')
fix_func('set_default_recipients', 'Result<(), ContractError>')
fix_func('commit_initialize', 'Result<(), ContractError>')
fix_func('set_royalty_rate', 'Result<(), ContractError>')
fix_func('withdraw', 'Result<(), ContractError>')
fix_func('distribute_with_override', 'Result<(), ContractError>')
fix_func('batch_distribute', 'Result<(), ContractError>')
fix_func('record_secondary_royalty', 'Result<(), ContractError>')
fix_func('distribute_secondary', 'Result<(), ContractError>')
fix_func('update_share', 'Result<(), ContractError>')
fix_func('set_admins', 'Result<(), ContractError>')
fix_func('distribute', 'Result<(), ContractError>')

# Internal functions
for i, line in enumerate(lines):
    if 'fn validate_unique_addresses' in line:
        lines[i] = line.replace(') {', ') -> Result<(), ContractError> {')
        # Find end and insert Ok(())
        brace_count = 0
        found_start = False
        for j in range(i, len(lines)):
            if '{' in lines[j]: brace_count += lines[j].count('{'); found_start = True
            if '}' in lines[j]: brace_count -= lines[j].count('}')
            if found_start and brace_count == 0:
                lines.insert(j, '        Ok(())\n')
                break
    elif 'fn validate_recipient_list' in line:
        lines[i] = line.replace(') {', ') -> Result<(), ContractError> {')
        brace_count = 0
        found_start = False
        for j in range(i, len(lines)):
            if '{' in lines[j]: brace_count += lines[j].count('{'); found_start = True
            if '}' in lines[j]: brace_count -= lines[j].count('}')
            if found_start and brace_count == 0:
                lines.insert(j, '        Ok(())\n')
                break
    elif 'fn validate_default_rcpt_bps' in line:
        lines[i] = line.replace(') {', ') -> Result<(), ContractError> {')
        brace_count = 0
        found_start = False
        for j in range(i, len(lines)):
            if '{' in lines[j]: brace_count += lines[j].count('{'); found_start = True
            if '}' in lines[j]: brace_count -= lines[j].count('}')
            if found_start and brace_count == 0:
                lines.insert(j, '        Ok(())\n')
                break

with open('src/lib.rs', 'w') as f:
    f.writelines(lines)
