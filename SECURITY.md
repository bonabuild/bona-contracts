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
| A 28-step rehearsal of the whole buyer path, run on Base Sepolia | `scripts/e2e-sale.js` |
| An independent review, with everything it raised addressed | [`docs/audit-status.md`](docs/audit-status.md) |
| Static analysis on every push, failing the build on High findings | `.github/workflows/ci.yml` |
| Verified source on Basescan, byte for byte | links in the README |

None of these replace an audit. They are what could be done without one.

## Scope

**Highest priority — deployed, but holding nothing yet:**

| Contract | Address | Why it matters most |
|---|---|---|
| `DirectSale` | `0xc552c1eE35629d29e9A7d73b1deb14cfea433881` | Takes buyers' money |
| `SaleVesting` | `0x51f748210D3d6D409f95325e2F9ef9C5Ea590F41` | Holds buyers' tokens for six months |

Read these two first. The sale is not open: it holds no BONA and has no
reserved capacity, so every `buy()` reverts. A finding today is still a
commit rather than an incident, and that window closes the moment the
multisig arms it.

**Also in scope** — deployed on Base mainnet (chain ID 8453):

| Contract | Address |
|---|---|
| BonaToken | `0xC0833296346D7a699949B5DF547279b1641Ea2cd` |
| TeamVesting | `0xEf05C6Ce1C47118d411a3C1D8FEcC128dcF87229` |
| RequestBacking | `0xbFB03dfb3cC04C95ff4a92F4866F1D9396F4b7E4` |

And everything in `scripts/`. A script that prints wrong multisig calldata
is a real vulnerability, not a convenience bug.

**Out of scope:** third-party infrastructure we do not control (the Base
sequencer, RPC providers, Snapshot, USDC itself), the superseded vesting
contract at `0xdaAF…5976` which holds nothing and will never be used, and
the known weaknesses below.

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
  own mistakes, whether or not anything was exploited.
- **Credit by name or handle, or anonymity** — your choice.
- **Safe harbour.** No legal action against anyone acting in good faith
  under this policy: test against the addresses above or your own fork,
  do not exfiltrate data or disrupt other users, and give us a reasonable
  window before publishing.

## The bounty

**There is a published schedule**, with severity bands and amounts fixed in
advance: [`docs/bounty.md`](docs/bounty.md). What a finding is worth is
settled before it is found, because settling it afterwards puts the
negotiation in the hands of the party with an interest in calling the bug
small.

Two things stated here rather than left to be discovered: payment is in
**BONA, which has no market and no way to sell it today**, and the top band
tracks the amount actually at risk in the sale rather than staying flat
while the exposure changes.

Ties between bands go **up**. Every payment is published with the finding,
the band, and the reasoning — including the ones where the reasoning looks
bad for us.
