use criterion::{criterion_group, criterion_main, BatchSize, BenchmarkId, Criterion};
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env};
use stellar_royalty_splitter::RoyaltySplitter;

/// Build a fresh environment, register the contract, initialise N collaborators,
/// and fund the contract. Returns everything needed to call `distribute`.
fn prepare(n: u32) -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let contract_id = env.register_contract(None, RoyaltySplitter);

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract(token_admin);

    let equal_share = 10_000u32 / n;
    let last_share = 10_000u32 - equal_share * (n - 1);

    let mut collaborators: soroban_sdk::Vec<Address> = soroban_sdk::Vec::new(&env);
    let mut shares: soroban_sdk::Vec<u32> = soroban_sdk::Vec::new(&env);

    for i in 0..n {
        collaborators.push_back(Address::generate(&env));
        shares.push_back(if i == n - 1 { last_share } else { equal_share });
    }

    let client = stellar_royalty_splitter::RoyaltySplitterClient::new(&env, &contract_id);
    client.initialize(&collaborators, &shares);

    StellarAssetClient::new(&env, &token).mint(&contract_id, &1_000_000_000_i128);

    (env, contract_id, token)
}

/// Benchmark the `distribute` entrypoint in isolation (setup excluded from timing).
///
/// Three collaborator counts are measured to show how execution cost scales:
/// - 1  (small)
/// - 5  (medium)
/// - 10 (maximum — `MAX_COLLABORATORS`)
fn bench_distribute(c: &mut Criterion) {
    let mut group = c.benchmark_group("distribute");

    for n in [1_u32, 5, 10] {
        group.bench_with_input(
            BenchmarkId::new("collaborators", n),
            &n,
            |b, &n| {
                b.iter_batched(
                    || prepare(n),
                    |(env, contract_id, token)| {
                        let client =
                            stellar_royalty_splitter::RoyaltySplitterClient::new(&env, &contract_id);
                        client.distribute(&token);
                    },
                    BatchSize::SmallInput,
                );
            },
        );
    }

    group.finish();
}

/// Benchmark the full path including environment setup, initialisation, and distribution.
///
/// Useful for detecting regressions in the overall contract lifecycle rather than
/// just the distribution entrypoint.
fn bench_full_lifecycle(c: &mut Criterion) {
    let mut group = c.benchmark_group("full_lifecycle");

    for n in [1_u32, 5, 10] {
        group.bench_with_input(
            BenchmarkId::new("collaborators", n),
            &n,
            |b, &n| {
                b.iter(|| {
                    let (env, contract_id, token) = prepare(n);
                    let client =
                        stellar_royalty_splitter::RoyaltySplitterClient::new(&env, &contract_id);
                    client.distribute(&token);
                });
            },
        );
    }

    group.finish();
}

criterion_group!(benches, bench_distribute, bench_full_lifecycle);
criterion_main!(benches);
