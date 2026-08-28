import re

with open("tests/integration_test.rs", "r") as f:
    content = f.read()

bad_test = """fn test_distribute_fails_when_contract_is_paused() {
    // 1 stroop < 2 recipients — must reject with AmountTooSmall
    mint(&env, &token, &contract_id, 1);
    let result = client.try_distribute(&token);
    assert_eq!(result, Err(Ok(ContractError::AmountTooSmall.into())));
}"""

good_test = """fn test_distribute_fails_when_contract_is_paused() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    mint(&env, &token, &contract_id, 1000);
    client.pause();
    let result = client.try_distribute(&token);
    assert_eq!(result, Err(Ok(ContractError::ContractPaused.into())));
}"""

content = content.replace(bad_test, good_test)

with open("tests/integration_test.rs", "w") as f:
    f.write(content)
