#!/usr/bin/env bash
# security_lint.sh - Custom Soroban linter for common security issues

set -euo pipefail

echo "▶ Running custom security linter..."

EXIT_CODE=0

# 1. Check for missing auth checks in pub fn
echo "Checking for potential missing auth checks in contract endpoints..."
# A simplistic check: any pub fn should either have 'require_auth', 'require_admin'
# or be explicitly read-only. We will look for functions that might mutate state
# but lack auth checks. Note: This is heuristic-based.

# We grep for pub fn and then check if it's missing require_auth or require_admin.
# To do this safely, we search for instance_set or persistent_set calls in functions
# without auth checks.
# It's hard to do purely with grep, so we'll do a basic check:
# Ensure certain critical functions (e.g. set_royalty_rate, pause, update_wasm) have auth.

CRITICAL_FUNCTIONS=("set_royalty_rate" "pause" "unpause" "update_wasm" "admin_transfer")

for FUNC in "${CRITICAL_FUNCTIONS[@]}"; do
    # Find the function body (simplified) and check for auth
    if ! awk "/pub fn $FUNC/,/}/{print}" src/lib.rs | grep -q -E "require_auth|check_admin_auth|require_admin"; then
        echo "❌ ERROR: Critical function '$FUNC' might be missing an authorization check."
        EXIT_CODE=1
    fi
done

# 2. Check for unsafe unwrap and expect (fallback to clippy but good for custom linter)
if grep -q "\.unwrap()" src/lib.rs; then
    echo "❌ ERROR: Found unsafe '.unwrap()' usage in src/lib.rs"
    EXIT_CODE=1
fi

if grep -q "\.expect(" src/lib.rs; then
    echo "❌ ERROR: Found unsafe '.expect()' usage in src/lib.rs"
    EXIT_CODE=1
fi

if [[ $EXIT_CODE -eq 0 ]]; then
    echo "✅ Custom security lint passed!"
else
    echo "❌ Security lint failed."
fi

exit $EXIT_CODE
