use soroban_sdk::{Env, Address, testutils::Address as _};
#[test]
fn test_panic() {
    let env = Env::default();
    let addr = Address::generate(&env);
    addr.require_auth();
}
