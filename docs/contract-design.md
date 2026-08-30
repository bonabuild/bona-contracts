# Contract design

Read this before reading the contracts. It explains the shape of the
system; the contracts' own comments carry the per-function detail.

---

## The system

Five contracts. One holds the asset, three hold it in place, one holds
money for the length of a round.

```
BonaToken ────────── the asset. 100M fixed, no admin surface at all
    │
    ├── TeamVesting ───── 5 seats x 2M, 36-month linear, tranche-funded
    ├── RoundVesting ──── buyer grants, 6-month lock enforced here
    ├── RequestBacking ── lock BONA behind a request; roadmap signal
    │
    └── SaleRound ─────── one per round: fixed price, escrow, floor,
                          refund, circuit breaker. Holds real money.
                          Writes grants into RoundVesting on claim.
```

| Contract | Privileged address | What it can do | What it can **never** do |
|---|---|---|---|
| BonaToken | **none** | — | — |
| TeamVesting | funder (multisig) | assign/vacate seats, fund tranches | move or claw back a funded tranche |
| RoundVesting | funder (multisig) | authorise/revoke granter contracts | touch an existing grant |
| RequestBacking | curator (multisig) | set a request's status label | move, freeze or reduce a lock |
| SaleRound | treasury (multisig) | settle after the floor, reclaim **unsold** | touch buyer funds, change a term, pause |

The pattern is uniform: **every privileged power is additive or
informational. None can reach tokens someone else already holds.**

---

## Four principles that produced the above

### 1. Absence beats renouncement

The common pattern is to deploy an ownable contract and renounce
ownership afterwards. That asks you to trust that the renounce happened
and was not front-run. Here the dangerous capabilities are never compiled
in — there is nothing to renounce and nothing to verify beyond reading
the source.

### 2. Design the failure case out, don't guard it

A failed round must void its buyers' vesting. The obvious design — grant
on contribution, cancel on failure — requires a cancellation power, which
then also exists for successful rounds. Instead grants are created only
**after** settlement, so a failed round has nothing to undo.

The same move, repeatedly:

| Instead of… | The design is… |
|---|---|
| revoke on a team member's departure | tranche funding — simply don't fund the next one |
| freeze backing once a request is queued | never freeze — scarcity comes from a finite balance |
| refunds approved by the multisig | escrow + permissionless `refund()` |
| pushing grants to thousands of buyers | buyers pull their own, paying their own gas |

### 3. Constraints live in the contract, not in policy

"Six months" is `RoundVesting.MIN_DURATION`, so an authorised round
cannot quietly set one second. "2,000,000 per seat" is `MAX_PER_SEAT`.
"30M sale ceiling" is `MAX_TOTAL`. **The only promises worth making are
the ones the contract cannot break.**

### 4. A power that can stall must not be a power to keep

Settlement needs a multisig vote, so a stalled multisig could otherwise
strand buyers. `SETTLEMENT_GRACE` (30 days) turns an unsettled successful
round refundable. `markFailed()` is permissionless. A late claimer past
the backdate window is clamped, not blocked.

---

## Per contract, briefly

**BonaToken** — ERC-20 + ERC20Permit, nothing else. ERC20Votes was
considered and rejected: it writes a checkpoint on every transfer and
requires self-delegation before tokens count at all, which silently
disenfranchises most holders. Off-chain voting reads balances without any
of that.

**TeamVesting** — five *seats*, not five addresses, because team
membership changes and a contract that redirects grants is a clawback
under a different name. `vacateSeat` moves nothing: the leaver keeps
every funded tranche, and a replacement inherits the seat's *remaining*
budget, never a fresh allocation.

> **The lump trap.** Schedules computed against `balance + released`
> — including OpenZeppelin's `VestingWallet` — treat later-added tokens
> as retroactively vested, so funding a second tranche at month 12 would
> unlock half of it instantly. Every tranche here is an independent grant
> with its own start, and a test asserts a new tranche begins at 0%.

**RoundVesting** — granters must be **contracts** (an EOA granter is one
key against the whole sale pool) and must be authorised by the multisig.
`MIN_DURATION` enforces the six months. `MAX_BACKDATE` (30 days) lets
buyers vest from the round's close without letting a granter hand over
pre-vested tokens. `revokeGranter` stops future grants only.

**RequestBacking** — anyone opens a request; unbacked ones score zero, so
spam self-filters. Backing locks tokens that only ever return to the
locker, withdrawable in **every** state — a freeze would hand the curator
a hostage and buy nothing, since backing never funds the build. The
quadratic score is computed off-chain because it is counted per member
*account*, and accounts are off-chain; the contract's job is to be the
complete public record of the inputs, including distinct backer counts.

**SaleRound** — everything that matters is `immutable`: both prices, the
goal, the floor, the deadline, the reference price. Progress is accounted
**in BONA rather than USD**, so a broken oracle can never corrupt the
goal, floor or refund arithmetic. The Chainlink feed answers exactly one
question — is the ETH lane within ±20% of the published reference — and
**fails closed**: stale, non-positive or reverting data shuts the ETH
lane while USDC keeps running. It can close a lane; it can never open one
and it never sets a price. `reclaimUnsold()` is bounded to the balance
minus everything owed to buyers, so it cannot reach a buyer's tokens in
any state, at any time.

---

## Deliberately off-chain

| Thing | Why |
|---|---|
| The quadratic score | Counted per member account; accounts are off-chain. Published with its inputs so anyone can recompute it |
| Member accounts | Email-gated downloads — nothing to prove on-chain |
| Proposals and votes | Off-chain voting, because free voting is the point |
| Request text | Only its hash is on-chain; the text lives on the site |

## Known weaknesses

Stated here rather than discovered later. Full detail in
[`../SECURITY.md`](../SECURITY.md).

- **Sybil splitting** in quadratic ranking — mitigated by per-account
  counting and published backer counts, not eliminated
- **A centralised sequencer** on Base
- **The multisig** is the root of every additive power
- **None of this is audited** — see [`audit-status.md`](audit-status.md)

## The test suite is a claim registry

187 tests. The convention: **every safety claim made in these documents
or on the website has a test here**, and the forbidden-function tests
inspect the compiled ABI, so the claim is about the artifact rather than
the intent. If a test is removed, the public claim it backs must be
removed in the same commit.
