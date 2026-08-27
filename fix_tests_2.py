import os

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    original = content
    content = content.replace("let (_contract_id, client) = setup(&env);", "let (contract_id, client) = setup(&env);")
    
    if "integration_test.rs" in filepath:
        if "RATE_HISTORY_CAP" not in content[:1000]: # check imports
            content = content.replace("stellar_royalty_splitter::{", "stellar_royalty_splitter::{RATE_HISTORY_CAP, ")

    if content != original:
        with open(filepath, 'w') as f:
            f.write(content)
        print(f"Fixed {filepath}")

for root, _, files in os.walk('tests'):
    for f in files:
        if f.endswith('.rs'):
            process_file(os.path.join(root, f))
