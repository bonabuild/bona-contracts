# BONA — contracts

[![CI](https://github.com/bonabuild/bona-contracts/actions/workflows/ci.yml/badge.svg)](https://github.com/bonabuild/bona-contracts/actions/workflows/ci.yml)

The smart contracts behind [BonaBuild](https://bonabuild.org), and the
tests that prove what they can and cannot do.

**This repository is not the software library.** BonaBuild's business
applications live elsewhere and are free to every member. What is here is
the token layer: the contract that holds the supply, the contracts that
hold it in vesting, and the contract that sells it.

---

## Deployed on Base (chain ID 8453)

| Contract | Address | |
|---|---|---|
| **BonaToken** | `0xC0833296346D7a699949B5DF547279b1641Ea2cd` | [source ↗](https://basescan.org/address/0xC0833296346D7a699949B5DF547279b1641Ea2cd#code) |
| TeamVesting | `0xEf05C6Ce1C47118d411a3C1D8FEcC128dcF87229` | [source ↗](https://basescan.org/address/0xEf05C6Ce1C47118d411a3C1D8FEcC128dcF87229#code) |
| RequestBacking | `0xbFB03dfb3cC04C95ff4a92F4866F1D9396F4b7E4` | [source ↗](https://basescan.org/address/0xbFB03dfb3cC04C95ff4a92F4866F1D9396F4b7E4#code) |

**`SaleVesting` and `DirectSale` are written and tested but not deployed.**
They are the two contracts a buyer would interact with, so they are the two
most worth reviewing while a finding is still free to act on.

> **One address is retired.** `0xdaAFEFfBA13f0573609575Ee028621C812eD5976` is
> an earlier vesting contract, `RoundVesting`. It holds nothing, granted
> nothing, and will never be used: an external review found that its capacity
> cap was checked at grant time rather than reserved in advance, which could
> have left a buyer paid-up and unable to claim. `SaleVesting` replaces it.
> The address stays on-chain and verified because deleting history is not
> available to anyone, including us.

The entire supply — 100,000,000 BONA, fixed — is held by the project
multisig at
[`0x6410…801B`](https://basescan.org/address/0x6410d637abcD92f3B68A8a2c285581b5551A801B),
which requires 2 of 4 published signers for any movement. No single key
can move anything.

---

## The claims, and where to check them

Every line below is checkable without trusting us. That is the point of
publishing this repository at all.

| Claim | How to check it yourself |
|---|---|
| Supply is fixed at 100,000,000 | `contracts/BonaToken.sol` — the constructor mints once. There is no other mint path |
| There is **no** mint function | `npm test` — `BonaToken.test.js` inspects the *compiled ABI* and fails if one appears |
| There is no owner, pause, or blacklist | Same test file, same method |
| One price, for every buyer, always | `DirectSale.sol` — `bonaPerUsdc` is `immutable`. `DirectSale.test.js` asserts no setter exists |
| Money and grant move together, or not at all | `DirectSale.test.js` — three tests pay into a sale that cannot grant, and assert the buyer's USDC never left their wallet |
| Vesting cannot be clawed back | `SaleVesting.test.js`, `TeamVesting.test.js` — no revoke path exists to test |
| Stopping a sale cannot strand a buyer | `SaleVesting.test.js` — capacity cannot be released below what a sale has committed |
| Backers can always withdraw | `RequestBacking.test.js` — withdrawal is asserted in every request state |
| The deployed bytecode matches this source | The "source ↗" links above — verified, byte for byte |

The convention this project holds itself to: **every safety claim made on
the website has a test here.** If a test is deleted, the claim it backs
must be deleted in the same commit.

That used to be a promise. It is now enforced: CI runs the suite on every
push and every pull request, reads the real passing count, and **fails the
build if any published number in this repository disagrees with it**
(`tools/verify-claims.js`). A second job runs Slither and fails on any
High-impact finding. So the badge above is not decoration — a red badge
means a claim on this page is currently false.

### Run the tests

```bash
npm install
npm test          # 150 tests
```

No configuration, no keys, no network needed. Tests run against a local
chain.

---

## How the sale works

One contract, one price, open continuously.

```
buyer's USDC ──▶ DirectSale.buy() ──┬──▶ treasury    (the whole payment, immediately)
                                    └──▶ SaleVesting (a 6-month grant, same transaction)
```

Both legs happen in one call. If the grant cannot be written — no capacity
reserved, no BONA in the contract, the buyer at their grant limit — the
whole transaction reverts and the buyer keeps their money. There is no
state in which the project holds a payment that has not bought anything.

There are no rounds, no escrow, no floor and no refund, because there is no
window for any of them to cover. There are also no tiers, no volume
discounts, no early-bird rate and no referral bonus: the amount of BONA a
dollar buys does not depend on who is spending it or when.

**USDC only.** A frozen BONA/ETH rate drifts as ETH moves and a live one
puts an oracle in charge of the price; accepting a second stablecoin at a
fixed one-to-one means absorbing the difference on every sale whenever the
two diverge. Anyone holding either can swap to USDC on Base for a few
cents.

**The tokens arrive in instalments.** The multisig tops up the sale's BONA
balance and its reserved capacity in small amounts rather than handing over
the allocation, so the most any single failure can reach is the current
instalment.

---

## ⚠️ Not audited

These contracts have **not been through a professional external audit.**
Some of them are deployed on mainnet and hold real value.

An independent review has been carried out and its three findings are
described in [`docs/audit-status.md`](docs/audit-status.md), along with
what changed in response. A second review is planned. Neither replaces an
audit, and this section will not change until one has been published.

**Review of `DirectSale.sol` and `SaleVesting.sol` is especially welcome.**
They are the contracts that will handle buyers' money, and they are not
deployed yet. See [`SECURITY.md`](SECURITY.md).

---

## What is in here

```
contracts/    5 contracts + mocks used only by tests
test/         150 tests — the claim registry described above
scripts/      deploy, sale deployment, seat assignment, cost measurement
docs/         design reasoning and audit status
tools/        the CI check that keeps published numbers honest
```

## Licence

MIT — see [`LICENSE`](LICENSE). Read it, fork it, audit it, reuse it.

Other BonaBuild repositories carry different licences by design:
self-hosted applications are AGPL-3.0 with full source; desktop and
mobile applications are free but **closed** under the BonaBuild Freeware
Licence. Those are free software in price, not in the open-source sense,
and this project does not describe them as open source.

---

## There is one BONA contract

**`0xC0833296346D7a699949B5DF547279b1641Ea2cd` on Base. Nothing else is
BONA.**

This code is MIT, so anyone may copy it and deploy their own token — and
sooner or later someone will. That is what the licence permits and it
takes nothing from this project. But a copy is a *different contract at a
different address*: it has no connection to BonaBuild, no claim on this
treasury, no weight in this governance, and no relationship to the supply
above. It is a new and unrelated token that happens to share a name.

Before you touch anything calling itself BONA, check its address against
this README **and** against [bonabuild.org](https://bonabuild.org). If
the two ever disagree, trust neither and open an issue here.

We will never announce a new contract address on social media alone, and
we will never ask you to send funds to an address that is not published
in both places at once.

---

## BONA is not an investment

BonaBuild writes the software and gives it away; that does not depend on
BONA. Buying BONA adds capacity — more built, sooner — and backing directs
what gets built next. BONA is not a share, it carries no claim on revenue,
and it comes with no promise of return. There is no buy-back and no price
floor — not as policy, but as a rule this project does not break.

If you ever pay for BONA: **you may lose the entire amount you pay.**

Project, model and governance: **[bonabuild.org](https://bonabuild.org)**
