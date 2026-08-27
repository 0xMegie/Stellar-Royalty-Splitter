import os
import re
import glob

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    original = content

    # Replace Err(Ok(ContractError::XYZ)) with Err(Ok(ContractError::XYZ.into()))
    content = re.sub(r'Err\(Ok\(ContractError::([A-Za-z0-9_]+)\)\)', r'Err(Ok(ContractError::\1.into()))', content)

    # Fix env.serialize to to_xdr
    if "env.serialize" in content:
        content = content.replace("env.serialize(collaborators)", "collaborators.to_xdr(env)")
        content = content.replace("env.serialize(shares)", "shares.to_xdr(env)")

    # Fix distribute_secondary_royalties
    content = content.replace("distribute_secondary_royalties", "distribute_secondary")

    # Fix client lifetimes in setup functions
    content = re.sub(
        r'fn setup_split<\'a>\(\n\s*env:\s*&\'a Env,\n\s*shares:\s*&\'a \[u32\],\n\)\s*->\s*\(Address,\s*RoyaltySplitterClient<\'_[^>]*>,\s*SorobanVec<Address>,\s*Address\)',
        r'fn setup_split<\'a>(\n    env: &\'a Env,\n    shares: &\'a [u32],\n) -> (Address, RoyaltySplitterClient<\'a>, SorobanVec<Address>, Address)',
        content,
        flags=re.MULTILINE
    )
    content = re.sub(
        r'fn setup_split\(\n\s*env:\s*&Env,\n\s*shares:\s*&\[u32\],\n\)\s*->\s*\(Address,\s*RoyaltySplitterClient<\'_[^>]*>,\s*SorobanVec<Address>,\s*Address\)',
        r'fn setup_split<\'a>(\n    env: &\'a Env,\n    shares: &\'a [u32],\n) -> (Address, RoyaltySplitterClient<\'a>, SorobanVec<Address>, Address)',
        content,
        flags=re.MULTILINE
    )
    
    # Fix undefined token / client in integration test minting
    if "mint(&env, &token, &contract_id, 1);" in content:
        # Looking at error E0425, in `tests/integration_test.rs:5623`
        # token, contract_id, client are not found. We might need to see the context.
        pass
        
    # Unused variables
    content = re.sub(r'let \(contract_id, client\) = setup\(&env\);', r'let (_contract_id, client) = setup(&env);', content)

    if content != original:
        with open(filepath, 'w') as f:
            f.write(content)
        print(f"Fixed {filepath}")

for root, _, files in os.walk('tests'):
    for f in files:
        if f.endswith('.rs'):
            process_file(os.path.join(root, f))
