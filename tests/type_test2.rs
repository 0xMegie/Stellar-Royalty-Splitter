#![cfg(test)]
use soroban_sdk::{testutils::Address as _, Address, Env, Vec, vec};
use stellar_royalty_splitter::{RoyaltySplitterClient, ContractError};

#[test]
fn print_type() {
    let env = Env::default();
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(&env, &contract_id);
    let result = client.try_distribute(&Address::generate(&env));
    let expected: Result<Result<(), soroban_sdk::ConversionError>, Result<ContractError, soroban_sdk::InvokeError>> = Err(Ok(ContractError::Underfunded.into()));
    assert_eq!(result, expected);
}
