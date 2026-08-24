#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, Env, Vec,
};
use stellar_royalty_splitter::{RoyaltySplitter, RoyaltySplitterClient};

fn setup(env: &Env) -> RoyaltySplitterClient {
    let contract_id = env.register_contract(None, RoyaltySplitter);
    RoyaltySplitterClient::new(env, &contract_id)
}

fn commitment(env: &Env, collaborators: &Vec<Address>, shares: &Vec<u32>) -> (soroban_sdk::BytesN<32>, soroban_sdk::BytesN<32>) {
    let collaborator_hash = env.crypto().sha256(&env.serialize(collaborators));
    let share_hash = env.crypto().sha256(&env.serialize(shares));
    (collaborator_hash, share_hash)
}

fn inputs(env: &Env) -> (Vec<Address>, Vec<u32>) {
    (
        vec![env, Address::generate(env), Address::generate(env)],
        vec![env, 5000_u32, 5000_u32],
    )
}

#[test]
fn commit_reveal_initializes_after_one_ledger() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let client = setup(&env);
    let (collaborators, shares) = inputs(&env);
    let (collaborator_hash, share_hash) = commitment(&env, &collaborators, &shares);

    client.commit_initialize(&collaborator_hash, &share_hash);
    env.ledger().with_mut(|ledger| ledger.sequence_number += 1);
    client.reveal_initialize(&collaborators, &shares);

    assert!(client.is_initialized());
    assert_eq!(client.get_admin(), collaborators.get(0).unwrap());
}

#[test]
fn reveal_before_next_ledger_fails() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let client = setup(&env);
    let (collaborators, shares) = inputs(&env);
    let (collaborator_hash, share_hash) = commitment(&env, &collaborators, &shares);
    client.commit_initialize(&collaborator_hash, &share_hash);

    assert!(client.try_reveal_initialize(&collaborators, &shares).is_err());
}

#[test]
fn collaborator_hash_mismatch_fails() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let client = setup(&env);
    let (collaborators, shares) = inputs(&env);
    let (collaborator_hash, share_hash) = commitment(&env, &collaborators, &shares);
    client.commit_initialize(&collaborator_hash, &share_hash);
    env.ledger().with_mut(|ledger| ledger.sequence_number += 1);
    let (mut changed, _) = inputs(&env);
    changed.set(0, Address::generate(&env));

    assert!(client.try_reveal_initialize(&changed, &shares).is_err());
}

#[test]
fn shares_hash_mismatch_fails() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let client = setup(&env);
    let (collaborators, shares) = inputs(&env);
    let (collaborator_hash, share_hash) = commitment(&env, &collaborators, &shares);
    client.commit_initialize(&collaborator_hash, &share_hash);
    env.ledger().with_mut(|ledger| ledger.sequence_number += 1);
    let changed_shares = vec![&env, 6000_u32, 4000_u32];

    assert!(client.try_reveal_initialize(&collaborators, &changed_shares).is_err());
}

#[test]
fn reveal_without_commitment_fails() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let client = setup(&env);
    let (collaborators, shares) = inputs(&env);

    assert!(client.try_reveal_initialize(&collaborators, &shares).is_err());
}

#[test]
fn commitment_is_consumed_after_successful_reveal() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let client = setup(&env);
    let (collaborators, shares) = inputs(&env);
    let (collaborator_hash, share_hash) = commitment(&env, &collaborators, &shares);
    client.commit_initialize(&collaborator_hash, &share_hash);
    env.ledger().with_mut(|ledger| ledger.sequence_number += 1);
    client.reveal_initialize(&collaborators, &shares);

    assert!(client.try_reveal_initialize(&collaborators, &shares).is_err());
}
