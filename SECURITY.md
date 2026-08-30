# Security policy

## These contracts are NOT audited

Everything in `contracts/` is deployed on Base mainnet, or will be, and
holds real value. **None of it has been through a professional external
audit.** That is stated here, in the README, and on the website, and it
is the most important fact on this page.

What was done instead — all published, all reproducible:

| Mitigation | Where |
|---|---|
| 186 automated tests, including tests asserting the *absence* of mint / owner / pause / blacklist | `test/` — run `npm test` |
| 22-step full lifecycle rehearsal, run on Base Sepolia | `scripts/e2e-round.js` |
| Internal adversarial review, with findings and fixes | [`docs/audit-status.md`](docs/audit-status.md) |
| Verified source on Basescan, byte for byte | links in the README |

None of these replace an audit. They are what could be done without one.

## Scope

**In scope** — deployed on Base mainnet (chain ID 8453):

| Contract | Address |
|---|---|
| BonaToken | `0xC0833296346D7a699949B5DF547279b1641Ea2cd` |
| TeamVesting | `0xEf05C6Ce1C47118d411a3C1D8FEcC128dcF87229` |
| RoundVesting | `0xdaAFEFfBA13f0573609575Ee028621C812eD5976` |
| RequestBacking | `0xbFB03dfb3cC04C95ff4a92F4866F1D9396F4b7E4` |

Also in scope: everything in `scripts/`. A script that prints wrong
multisig calldata is a real vulnerability, not a convenience bug.

**`SaleRound.sol` is the priority.** It is written, tested, and **not
deployed** — it is the contract that will escrow buyers' money, and
findings are still free to act on. Review it first.

**Out of scope:** third-party infrastructure we do not control (the Base
sequencer, Chainlink price feeds, Snapshot, RPC providers), and the known
weaknesses below.

## Known and accepted — please don't file these as new

A report that adds a *concrete exploit path* to one of these is very
welcome. A report that restates them is not a finding.

- **Sybil splitting in quadratic ranking.** One holder can split across
  wallets. Mitigated at the membership layer — backing counted per member
  account, backer counts published — but not eliminated.
- **Base's sequencer is centralised.** Accepted, and the reason the
  contracts hold no assumption about transaction ordering.
- **The multisig is the root of trust** for every privileged action:
  assigning seats, funding tranches, authorising granters, settling
  rounds. Each of those powers is additive or informational — none can
  reach tokens someone else already holds.
- **There is no pause function anywhere, deliberately.** The same lever
  that could stop a round could hold one hostage. The response to an
  incident here is disclosure plus the contracts' own exits — a
  permissionless `markFailed()`, a permissionless `refund()`, and a
  30-day settlement grace after which a stalled round becomes refundable
  regardless of us.

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
  own mistakes, whether or not it was exploited.
- **Credit by name or handle, or anonymity** — your choice.
- **Safe harbour.** No legal action against anyone acting in good faith
  under this policy: test against the addresses above or your own fork,
  do not exfiltrate data or disrupt other users, and give us a reasonable
  window before publishing.

## What we do not commit to

**There is no funded bug bounty.** The treasury exists to build software
and could not honour a bounty schedule today. Promising one we cannot pay
would be exactly the kind of claim this project refuses to make.

If a report saves real money, we will say so publicly and pay what we
honestly can. That is a statement of intent, not a rate card. It changes
when a sale round settles — and it will be updated here, in this file,
not announced anywhere else first.
