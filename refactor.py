import re

with open('src/lib.rs', 'r') as f:
    content = f.read()

# 1. Replace unwrap_or_else(|| Self::fail(...)) with ok_or(...)?
content = re.sub(
    r'\.unwrap_or_else\(\|\|\s*Self::fail\((?:&env|env),\s*(ContractError::[A-Za-z0-9_]+)\)\)',
    r'.ok_or(\1)?',
    content
)

# 2. Replace Self::fail(env, Error) with return Err(Error)
content = re.sub(
    r'Self::fail\((?:&env|env),\s*(ContractError::[A-Za-z0-9_]+)\);',
    r'return Err(\1);',
    content
)

# 3. We need to manually fix function signatures.
# Since it's tricky to do automatically, I will print all function signatures that need to be updated.
print("Finished basic replacements. Need manual signature updates.")

with open('src/lib.rs', 'w') as f:
    f.write(content)
