# Audit status

**Short version: not audited. Deployed anyway, and here is exactly why
and what was done instead.**

---

## Where this stands

| | |
|---|---|
| External professional audit | ❌ **Not done** |
| Automated test suite | ✅ 187 tests |
| Static analysis (Slither 0.11.6) | ✅ Run — 0 High, 3 Medium (all false positives) |
| Full lifecycle rehearsal on testnet | ✅ 22 steps, Base Sepolia |
| Internal adversarial review | ✅ Done, findings below |
| Static analysis (Slither) | ✅ Run, findings triaged below |
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
| S-1 | Low | SaleRound | A feed timestamped in the future underflowed the age check, so `ethLaneOpen()` panicked instead of returning false | **Fixed** + regression test |

**On I-4.** It reads like a missing safety feature and it is a
deliberate choice. A pause is a lever, and a lever that can stop a round
can also hold one hostage. The exits are built into the contracts
instead: `markFailed()` is permissionless, `refund()` is permissionless,
and a successful round left unsettled for 30 days becomes refundable
regardless of what the multisig does or does not do.

## Static analysis

Slither 0.11.6, run across all five contracts with `node_modules` and the
test mocks filtered out.

**Result: 20 findings. 0 High. 3 Medium, all false positives.**

| Impact | Count | Verdict |
|---|---|---|
| High | 0 | — |
| Medium | 3 | All false positives — reasoning below |
| Low | 11 | All `timestamp`: a time-boxed sale round compares against `block.timestamp` by design |
| Informational | 6 | Naming convention on an interface's constant getters, low-level calls (the two deliberate ETH sends), constructor complexity |

### The three Medium findings, and why each is not a bug

**`incorrect-equality` in `reclaimUnsold()` — `amount == 0`.** The
detector flags strict equality because comparing against a manipulable
value can be griefed. Here the comparison is a "nothing to do" guard on a
locally computed amount, and reverting on exactly zero is the intent.

**`incorrect-equality` in `settle()` — `closedAt == 0`.** `closedAt` is a
sentinel: zero means the round was never explicitly closed, so settlement
backfills it with the deadline. Testing a sentinel for zero is what a
sentinel is for.

**`unused-return` in `_readEthUsd()`.** `latestRoundData()` returns five
values and we destructure two: `answer` and `updatedAt`. The classic
staleness check also compares `answeredInRound` against `roundId` — but
Chainlink has deprecated `answeredInRound`, and adding a deprecated check
would be cargo cult, not safety. Freshness is enforced by `updatedAt`
against `MAX_ORACLE_AGE`, and the design bounds the damage anyway: the
oracle answers one question (is the ETH lane within ±20% of the published
reference), it can only ever close a lane, and all accounting is in BONA
rather than USD, so no feed reading can corrupt the goal, floor or refund
arithmetic.

### What Slither did not find

**S-1 was found by reading the code during triage, not by the tool** —
which is the honest summary of what static analysis is worth.

`_readEthUsd()` computed `block.timestamp - updatedAt`. A feed reporting
a timestamp in the future underflows that subtraction and reverts. The
revert happens in the success branch of the `try`, so the `catch` does
**not** absorb it — meaning `ethLaneOpen()`, a view whose entire contract
is to return `false` when the lane is shut, would panic instead.

Fixed by treating an impossible timestamp as a broken feed and failing
closed like every other bad reading. The regression test asserts the
panic is gone; removing the fix makes it fail with
`panic 0x11 (arithmetic overflow)`.

This is the pattern-matcher's blind spot in one example: Slither finds
shapes it has seen before, and a logic error in a `try` block's success
branch is not one of them. It is also why the external audit gate stands.

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
