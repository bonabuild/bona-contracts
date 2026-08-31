# Security status

**Short version: these contracts have not been audited. Read this before
you put money anywhere near them.**

---

## Where this stands

| | |
|---|---|
| External professional audit | ❌ **Not done** |
| Independent review | ✅ Done — findings addressed |
| Second review | ⏳ Arranged, not yet complete |
| Automated test suite | ✅ 150 tests |
| Full buyer-path rehearsal on Base Sepolia | ✅ 25 of 28 steps; the other 3 need time travel |
| Static analysis on every push | ✅ Build fails on any High finding |
| Source verified on Basescan | ✅ All deployed contracts |

None of this replaces an audit. It is what can be done without one.

## What is deployed, and what is not

`DirectSale` and `SaleVesting` — the two contracts a buyer would touch —
are **not deployed**. What is on-chain today holds no third-party money:
the entire supply sits in the project multisig, team vesting is funded by
the multisig to the team's own addresses, and request backing locks tokens
that only ever return to whoever locked them.

That is where the gate sits. In front of buyers' funds, not in front of
our own.

---

## The rehearsal

`scripts/e2e-sale.js` deploys the whole system to a real chain, arms it the
way the multisig will, and walks the buyer path end to end. It ran on Base
Sepolia at 25 of 28 steps; the three it skips fast-forward six months,
which only a local chain allows.

The steps worth naming are the ones that are supposed to fail. It buys from
a sale with no tokens, from a sale with tokens but no reserved capacity,
below the minimum, beyond the reservation, and after the multisig has taken
the capacity back — and after each one it checks that the buyer's USDC
balance is untouched.

That is the property `DirectSale` exists to have: payment and grant happen
in one transaction, so there is no state in which someone has paid and
cannot claim. A rehearsal should try hardest to break the thing a contract
is built to guarantee.

It runs the three roles as three separate addresses. That sounds obvious
and it is not: a testnet hands you one funded key, and with buyer,
treasury and deployer sharing an address, "every dollar reached the
treasury" passes without meaning anything. The script creates and funds the
other two keys itself.

---

## Static analysis

Slither runs on every push and every pull request and **fails the build on
any High-impact finding**. Medium and below are triaged by hand and the
reasoning is recorded, because a build that fails on informational noise is
a build nobody reads.

The useful thing to say about it is what it cannot do. Pattern matchers
find shapes they have seen before; a logic error in the success branch of a
`try` block is not one of those shapes, and it took reading the code to
find one. Static analysis is worth having and it is not worth trusting.

---

## The reviews

An independent review has been carried out and everything it raised has
been addressed — in two cases by changing the design rather than patching
around it. A second review is arranged.

Neither is an audit, and the line at the top of this page does not move
until one has been published here.

---

## What an audit still owes us

A review by the people who wrote the code is done by precisely the wrong
people to find the assumption they never questioned. That is not modesty;
it is why the independent review was worth having and why the gate stays
where it is.

An external audit is required before the sale opens at any meaningful
size, and specifically for:

- `DirectSale` end to end — it takes other people's money
- `SaleVesting`'s reservation and commitment arithmetic
- The interaction between the two, which is where the sharpest edges are
- Economic review of the price and the caps, not just the code

---

Found something? [`../SECURITY.md`](../SECURITY.md)
