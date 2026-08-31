# Contract design

Read this before reading the contracts. It explains the shape of the
system; the contracts' own comments carry the per-function detail.

---

## The system

Five contracts. One holds the asset, two hold it in place, one records a
signal, one sells.

```
BonaToken ────────── the asset. 100M fixed, no admin surface at all
    │
    ├── TeamVesting ───── 5 seats x 2M, 36-month linear, tranche-funded
    ├── SaleVesting ───── buyer grants, 6-month lock enforced here
    ├── RequestBacking ── lock BONA behind a request; roadmap signal
    │
    └── DirectSale ────── one published price, open continuously.
                          Payment and grant in the same transaction.
```

| Contract | Privileged address | What it can do | What it can **never** do |
|---|---|---|---|
| BonaToken | **none** | — | — |
| TeamVesting | funder (multisig) | assign/vacate seats, fund tranches | move or claw back a funded tranche |
| SaleVesting | funder (multisig) | reserve capacity for a sale, release what it has not used | touch an existing grant |
| RequestBacking | curator (multisig) | set a request's status label | move, freeze or reduce a lock |
| DirectSale | treasury (multisig) | receive payments, take back unsold BONA | change the price, reach a buyer's tokens, pause |

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

The clearest example is the sale. A contract that takes payment in one
transaction and writes the buyer's vesting grant in another can fail in
between, and when it does the money is gone and the tokens are unreachable.
Every guard you could add is a guard against a window that did not have to
exist.

`DirectSale` writes the grant in the same call as the payment. Either both
happen or neither does. The failure is not guarded against; there is
nowhere for it to occur.

The same move appears elsewhere:

| Instead of… | The design is… |
|---|---|
| revoke on a team member's departure | tranche funding — simply don't fund the next one |
| freeze backing once a request is queued | never freeze — scarcity comes from a finite balance |
| a pause switch on the sale | take back its capacity or its tokens; both are ordinary transactions |
| a cap checked when a buyer claims | capacity reserved when the sale is authorised |

### 3. Constraints live in the contract, not in policy

"Six months" is `SaleVesting.MIN_DURATION`, so an authorised sale cannot
quietly grant over one second. "2,000,000 per seat" is `MAX_PER_SEAT`.
"60M sale allocation" is `MAX_TOTAL`. "One price, for everyone" is
`bonaPerUsdc` being `immutable`. **The only promises worth making are the
ones the contract cannot break.**

### 4. A power that can stall must not be a power to keep

The multisig can stop the sale — by taking back reserved capacity or
unsold tokens — but it cannot take back capacity a sale has committed to
buyers it has already accepted. It can end the sale; it cannot strand
someone inside it.

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

**SaleVesting** — granters must be **contracts** (an EOA granter is one
key against the whole sale pool) and are given a *reservation* rather than
a flag. `grant` draws only against the caller's own reservation, so no
sale can be starved by another's activity and the 60M cap is enforced once,
at reservation time, where a mistake is still free to fix. A granter that
carries an obligation across two transactions declares it with `commit`,
and the funder cannot release capacity below that floor. A beneficiary
holds at most 500 grants, so summing them always fits in a block.

**RequestBacking** — anyone opens a request; unbacked ones score zero, so
spam self-filters. Backing locks tokens that only ever return to the
locker, withdrawable in **every** state — a freeze would hand the curator
a hostage and buy nothing, since backing never funds the build. The
quadratic score is computed off-chain because it is counted per member
*account*, and accounts are off-chain; the contract's job is to be the
complete public record of the inputs, including distinct backer counts.

**DirectSale** — `bonaPerUsdc`, `maxBona` and `vestingDuration` are all
`immutable`. The buyer's USDC goes straight to the multisig, so this
contract never holds a dollar and there is no balance for anyone to argue
about. What it can sell is bounded three separate ways: its own lifetime
ceiling, the BONA it currently holds, and the capacity reserved for it.
`reclaimUnsold()` can take the entire balance precisely because a purchase
moves the buyer's tokens out in the same transaction — nothing held here
is ever owed.

> **Repricing is a redeployment.** The price cannot be changed, so a new
> price means a new contract: reclaim, release the reservation, deploy,
> reserve again. Every price the project has ever offered therefore stays
> on-chain as its own permanent, immutable record, which is a better audit
> trail than one address whose price history has to be taken on trust.

---

## Deliberately off-chain

| Thing | Why |
|---|---|
| The quadratic score | Counted per member account; accounts are off-chain. Published with its inputs so anyone can recompute it |
| Member accounts | Email-gated downloads — nothing to prove on-chain |
| Proposals and votes | Off-chain voting, because free voting is the point |
| Request text | Only its hash is on-chain; the text lives on the site |
| The 20/70/10 split of proceeds | A treasury spending policy, not something a contract enforces. Published with every transaction hash, and honest about being a policy |

## Known weaknesses

Stated here rather than discovered later. Full detail in
[`../SECURITY.md`](../SECURITY.md).

- **Sybil splitting** in quadratic ranking — mitigated by per-account
  counting and published backer counts, not eliminated
- **A centralised sequencer** on Base
- **The multisig** is the root of every additive power
- **None of this is audited** — see [`audit-status.md`](audit-status.md)

## The test suite is a claim registry

150 tests. The convention: **every safety claim made in these documents
or on the website has a test here**, and the forbidden-function tests
inspect the compiled ABI, so the claim is about the artifact rather than
the intent. If a test is removed, the public claim it backs must be
removed in the same commit — and CI fails the build until it is.
