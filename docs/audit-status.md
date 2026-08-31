# Audit status

**Short version: not audited. Reviewed twice, with every finding published
below, including the two that changed the design.**

---

## Where this stands

| | |
|---|---|
| External professional audit | ❌ **Not done** |
| Independent review | ✅ Done — three findings, all acted on |
| Second review | ⏳ Arranged, not yet complete |
| Automated test suite | ✅ 150 tests |
| Full buyer-path rehearsal on Base Sepolia | ✅ 25 of 28 steps; the other 3 need time travel |
| Static analysis (Slither) on every push | ✅ Build fails on any High finding |
| Source verified on Basescan | ✅ All deployed contracts |

## What is deployed and what is not

The two contracts a buyer would touch — `DirectSale` and `SaleVesting` —
are **not deployed**. What is on-chain today holds no third-party money:
the entire supply sits in the project multisig, team vesting is funded by
the multisig to the team's own addresses, and request backing locks tokens
that only ever return to whoever locked them.

That is the line the audit gate sits on. It is in front of buyers' funds,
not in front of our own.

---

## The independent review

Three findings. All three concerned the same thing from different angles:
whether a buyer could end up having paid without being able to claim.

| ID | Severity | Where | Finding | Outcome |
|---|---|---|---|---|
| **F1** | High | RoundVesting | De-authorising a granter blocked buyers who had paid but not yet claimed. Their money was already settled to the treasury and their tokens were unreachable. Permanently | **Design changed** |
| **F2** | High | RoundVesting | The 30M cap was checked inside `grant`, first come first served. Two sale contracts whose allocations overlapped the remaining capacity would both work until the pool ran low, then a buyer's grant would simply revert — with the money taken. It would have surfaced near exhaustion, which is when the most money has been taken | **Design changed** |
| **F3** | Medium | SaleRound | After the 30-day settlement grace expired, buyers could refund — but the treasury could still settle, which flipped the status and killed the refund right. The published guarantee was that the multisig could delay but not keep. It could keep | **Contract removed** |

The reviewer was right that F2 was the most important of the three, and
for the reason they gave: it produces exactly the outcome the rest of this
system is arranged to make impossible, and it does so silently and late.

### What changed, and why it is more than a patch

**F1 and F2 were fixed by replacing the contract, not editing it.**
`RoundVesting` is retired; `SaleVesting` reserves capacity when a sale is
authorised rather than checking a cap when a buyer claims. A sale draws
only against its own reservation, so it can never be starved by another
sale's activity, and the cap is enforced once — at reservation time, where
a mistake is still free to fix. Releasing a reservation, which is how a
sale gets stopped, cannot reach below what that sale has committed.

**F3 was fixed by deleting the contract that had it.** `SaleRound`
implemented time-boxed rounds with escrow, a floor and refunds. The
funding model moved to a continuously open sale, so the contract had no
remaining purpose, and a contract nobody plans to deploy is audit budget
spent on nothing. It is in this repository's git history.

**And the class of bug was designed out.** F1 and F3 are both only
possible because a sale can take money in one transaction and settle the
buyer's claim in another. `DirectSale` writes the vesting grant in the
same call as the payment: either both happen or neither does. Three tests
pay into a sale that cannot grant and assert the buyer's USDC never left
their wallet.

---

## The internal review

Run before the independent one, over the contracts as they then stood.
Everything found is listed, including what was decided not to fix, because
a review that only lists wins is marketing.

### Findings in code that still ships

| ID | Severity | Contract | Finding | Status |
|---|---|---|---|---|
| L-1 | Low | vesting contracts | An oversized duration permanently bricks a beneficiary (uint64 overflow reverts `vestedAmount`) | **Fixed**, carried into `SaleVesting`, plus a deployment-time check in `DirectSale` |
| I-4 | Info | all | No pause anywhere: a bug cannot be halted, only survived | By design |

### Findings in `SaleRound`, which no longer exists

M-1 (a refund left its BONA stranded and could brick settlement), L-2 (an
underfunded round could settle), I-1 (the circuit breaker assumed 8 feed
decimals), I-2 and I-3 (accepted dust and blacklist edge cases), and S-1
(a feed timestamped in the future made `ethLaneOpen()` panic instead of
returning false) were all fixed at the time and are all moot now: escrow,
floors, refunds and the price oracle went with the contract.

They are listed rather than quietly dropped because the reasoning still
holds for anyone who reads the git history, and because a findings list
that shrinks without explanation is not worth reading.

**On I-4.** It reads like a missing safety feature and it is a deliberate
choice. A pause is a lever, and a lever that can stop a sale can also hold
one hostage. Stopping the sale is done instead with two ordinary
transactions that carry no special privilege: the multisig takes back the
sale's reserved capacity, or its BONA balance, or both.

---

## The rehearsal

`scripts/e2e-sale.js` deploys the whole system to a real chain, arms it the
way the multisig will, and walks the buyer path end to end. It ran on Base
Sepolia at 25 of 28 steps; the three it skips fast-forward six months, which
only a local chain allows.

The steps worth naming are the ones that are supposed to fail. It buys from
a sale with no tokens, from a sale with tokens but no reserved capacity,
below the minimum, beyond the reservation, and after the multisig has taken
the capacity back — and after each one it checks the buyer's USDC balance is
untouched. A rehearsal that only walks the happy path proves the least
interesting thing about a contract that handles other people's money.

It also runs the three roles as three different addresses. The first live
run did not, because a testnet hands you one funded key, and three checks
passed for the wrong reason: "the money reached the treasury" cannot fail
when the treasury is the buyer. The script now creates and funds the other
two keys itself.

---

## Static analysis

Slither runs on every push and every pull request and **fails the build on
any High-impact finding**. Medium and below are triaged by hand, because a
build that fails on informational noise is a build nobody reads.

The most useful thing to say about it is what it did not catch. During
triage of a clean Slither run, reading the code by hand turned up S-1: a
logic error in the success branch of a `try` block, which is not a shape
any pattern matcher looks for. Static analysis finds shapes it has seen
before. That is worth having and it is not worth trusting.

---

## What an audit still owes us

A review by the people who wrote the code is done by precisely the wrong
people to find the assumption they never questioned — and the independent
review proved it, by finding two High-severity issues in a contract that
had already passed an internal pass and shipped to mainnet.

An external audit is still required before the sale opens at any
meaningful size, and specifically for:

- `DirectSale` end to end — it takes other people's money
- `SaleVesting`'s reservation and commitment arithmetic
- The interaction between the two, which is where F1 and F2 lived
- Economic review of the price and the caps, not just the code

---

Found something? [`../SECURITY.md`](../SECURITY.md)
