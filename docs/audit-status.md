# Audit status

**Short version: not audited. Deployed anyway, and here is exactly why
and what was done instead.**

---

## Where this stands

| | |
|---|---|
| External professional audit | ❌ **Not done** |
| Automated test suite | ✅ 186 tests |
| Full lifecycle rehearsal on testnet | ✅ 22 steps, Base Sepolia |
| Internal adversarial review | ✅ Done, findings below |
| Source verified on Basescan | ✅ All four deployed contracts |

## Why deployed before an audit

Deploying the token, the vesting contracts and the request board costs
almost nothing and holds no third-party money: the entire supply sits in
the project multisig, vesting is funded by the multisig to the team's own
addresses, and backing locks tokens that only ever return to whoever
locked them. **Nobody else's money is at risk in any contract deployed
today.**

`SaleRound.sol` is the one that escrows buyers' money, and it is **not
deployed.** That is the line: the audit gate sits in front of buyers'
funds, not in front of our own.

## The internal review

Adversarial pass over all five contracts, run against the full test
suite. Everything found is listed — including what was decided not to
fix, because a review that only lists wins is marketing.

| ID | Severity | Contract | Finding | Status |
|---|---|---|---|---|
| M-1 | **Medium** | SaleRound | Refund did not un-sell: BONA stranded forever, and settlement bricked after any grace-window refund | **Fixed** + 2 regression tests |
| L-1 | Low | TeamVesting, RoundVesting, SaleRound | An oversized duration permanently bricks a beneficiary (uint64 overflow reverts `vestedAmount`) | **Fixed** + 3 regression tests |
| L-2 | Low | SaleRound | An underfunded round could settle — money taken, every claim reverting | **Fixed** + regression test |
| I-1 | Info | SaleRound | The circuit breaker assumed 8 feed decimals without checking | **Fixed** + regression test |
| I-2 | Info | SaleRound | The ETH lane cannot exactly fill the last dust of an allocation | Accepted, documented |
| I-3 | Info | SaleRound | A Circle-blacklisted buyer's USDC refund reverts — their own funds only | Accepted, documented |
| I-4 | Info | all | No pause anywhere: a bug cannot be halted, only survived | By design |

**On I-4.** It reads like a missing safety feature and it is a
deliberate choice. A pause is a lever, and a lever that can stop a round
can also hold one hostage. The exits are built into the contracts
instead: `markFailed()` is permissionless, `refund()` is permissionless,
and a successful round left unsettled for 30 days becomes refundable
regardless of what the multisig does or does not do.

## What an audit still owes us

An internal review is done by the people who wrote the code, which is
precisely the wrong people to find the assumption they never questioned.
An external audit is still required before any round after Round 0, and
specifically for:

- `SaleRound.sol` end to end — it holds other people's money
- Oracle handling under adversarial feed conditions
- Cross-contract interaction between SaleRound and RoundVesting
- Economic review of the round parameters, not just the code

## Round 0

The first round is capped at **$2,500**, and the cap is enforced by the
contract's allocation, not by a promise. Its purpose is to fund the
audit. It is the only round that will ever run unaudited, and anyone
offered it is told so in the same breath as the price.

Worst case is bounded and stated up front: a critical bug in Round 0
loses at most the escrow in Round 0.

**Every round after it requires the published audit.**

---

Found something? [`../SECURITY.md`](../SECURITY.md)
