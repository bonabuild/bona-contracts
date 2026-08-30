# Security policy

## These contracts are NOT audited

Everything in `contracts/` is deployed on Base mainnet, or will be, and
holds real value. **None of it has been through a professional external
audit.** That is stated here, in the README, and on the website, and it
is the most important fact on this page.

What was done instead — all published, all reproducible:

| Mitigation | Where |
|---|---|
| 150 automated tests, including tests asserting the *absence* of mint / owner / pause / blacklist | `test/` — run `npm test` |
| An independent review, with all three findings and what changed | [`docs/audit-status.md`](docs/audit-status.md) |
| Static analysis on every push, failing the build on High findings | `.github/workflows/ci.yml` |
| Verified source on Basescan, byte for byte | links in the README |

None of these replace an audit. They are what could be done without one.

## Scope

**Highest priority — written, tested, not yet deployed:**

| Contract | Why it matters most |
|---|---|
| `DirectSale.sol` | Takes buyers' money |
| `SaleVesting.sol` | Holds buyers' tokens for six months |

These two are the ones to read first. They are not on-chain yet, so a
finding here is still a commit rather than an incident.

**Also in scope** — deployed on Base mainnet (chain ID 8453):

| Contract | Address |
|---|---|
| BonaToken | `0xC0833296346D7a699949B5DF547279b1641Ea2cd` |
| TeamVesting | `0xEf05C6Ce1C47118d411a3C1D8FEcC128dcF87229` |
| RequestBacking | `0xbFB03dfb3cC04C95ff4a92F4866F1D9396F4b7E4` |

And everything in `scripts/`. A script that prints wrong multisig calldata
is a real vulnerability, not a convenience bug.

**Out of scope:** third-party infrastructure we do not control (the Base
sequencer, RPC providers, Snapshot, USDC itself), the retired
`RoundVesting` at `0xdaAF…5976` which holds nothing and will never be
used, and the known weaknesses below.

## Known and accepted — please don't file these as new

A report that adds a *concrete exploit path* to one of these is very
welcome. A report that restates them is not a finding.

- **Sybil splitting in quadratic ranking.** One holder can split across
  wallets. Mitigated at the membership layer — backing counted per member
  account, backer counts published — but not eliminated.
- **Base's sequencer is centralised.** Accepted, and the reason the
  contracts hold no assumption about transaction ordering.
- **The multisig is the root of trust** for every privileged action:
  assigning seats, funding tranches, reserving sale capacity, taking back
  unsold tokens. Each of those powers is additive or informational — none
  can reach tokens someone else already holds.
- **There is no pause function anywhere, deliberately.** A sale is stopped
  by the multisig taking back its reserved capacity or its BONA balance,
  both of which are ordinary transactions with no special privilege. A
  pause switch would be one more lever for no extra safety.
- **A buyer can hold at most 500 grants.** Vesting sums a beneficiary's
  grants, so an unbounded count would eventually cost more gas than a
  block allows — and the person it would strand is the buyer. 500 is far
  above any honest buying pattern; a minimum purchase in `DirectSale`
  keeps buyers further away from it still.

## Reporting

Email **security@bonabuild.org**. Please include:

- which contract or file, and the address if it is deployed
- what an attacker gains, concretely — funds, control, or denial of service
- steps to reproduce, ideally as a failing test against this repository

**Do not open a public issue for anything that can move funds.** For
everything else — a wrong number, a claim the code does not support, a
document that contradicts a contract — a public issue is better, and we
would rather have it in the open.

## What we commit to

- **Acknowledgement within 72 hours.** If you don't get one, the mail did
  not arrive — say so publicly and treat that as our failure, not yours.
- **We publish the finding, the fix, and the timeline**, including our
  own mistakes, whether or not it was exploited. The three findings in
  `docs/audit-status.md` are there because of this, not despite it.
- **Credit by name or handle, or anonymity** — your choice.
- **Safe harbour.** No legal action against anyone acting in good faith
  under this policy: test against the addresses above or your own fork,
  do not exfiltrate data or disrupt other users, and give us a reasonable
  window before publishing.

## What we do not commit to

**There is no funded bug bounty yet.** 15% of supply is allocated to
contributor programs, and a published bounty schedule is the first thing
it is for — severity bands and amounts fixed in advance, so what a finding
is worth is decided before it is found rather than after. Until that
schedule is published, treat this as intent rather than a rate card.

Two things about it stated plainly now rather than discovered later: any
payment would be made in BONA, which has no market and no exit today; and
this paragraph changes only when the schedule exists, here, in this file.
