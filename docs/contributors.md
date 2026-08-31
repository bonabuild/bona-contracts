# Contributor payments

Every payment this project makes for contributed work, with what was
delivered, what it was worth, and the transaction that paid it.

**Nothing has been paid yet.** This page exists before the first payment
rather than after it, so the format is fixed while there is nothing to
present in a flattering light.

---

## The log

| Date | Contributor | What was delivered | Band | Amount | Transaction |
|---|---|---|---|---:|---|
| — | — | *No payments yet* | — | — | — |

Credit is by name, handle, or anonymous — the contributor chooses, and the
choice is respected here. "Anonymous" in the second column means someone
asked not to be named, not that we do not know who they are.

---

## How a payment happens

1. **Work arrives.** A security report by email, or anything else through
   a public issue.
2. **It is verified.** A bug is reproduced. A translation is reviewed. A
   document fix is checked against the code it describes.
3. **A band is assigned** from the published schedule in
   [`bounty.md`](bounty.md). Ties go to the higher band.
4. **The multisig pays it.** A BONA transfer from the
   [2-of-4 Safe](https://basescan.org/address/0x6410d637abcD92f3B68A8a2c285581b5551A801B),
   requiring two of the four published signers.
5. **It is added here**, with the transaction hash, in the same session.

Between steps 4 and 5 there is a window where a payment exists on-chain and
not on this page. That window should be minutes. If you find a transfer
from the Safe that is a contributor payment and is not listed here, that is
a reportable failure of this page, and it will be treated as one.

## Paid outright, not vested

Contributors receive BONA directly. It does not vest.

Buyers accept a six-month lock because they are funding work that has not
happened yet. A contributor has already done the work. Making them wait
six months to receive payment for something already delivered would be a
different arrangement wearing the same word.

## What the payment is, plainly

**BONA has no market.** There is no exchange listing and no liquidity pool,
so a payment cannot be sold today and there is no date by which it can be.
Anyone deciding whether contributing is worth their time should decide with
that in front of them.

What it does carry: voting weight from the moment it lands, and weight in
the request ranking that decides what gets built next.

**Tax is the recipient's own.** Receiving tokens may be taxable where you
live, and the project gives no advice on it and withholds nothing.

---

## Why this page is not generated from the chain

Every payment below is a public transfer, so the amounts and the recipients
are already on-chain and need no page to be trusted. What the chain cannot
record is *what the payment was for* — which finding, which band, what was
delivered. That is the only thing this page adds, and it is the part that
requires someone to write it down honestly.

The payments come from the main treasury rather than a separate contributor
address. That means a total cannot be computed from the chain alone; it has
to be read off this table. The transaction hashes are what make each line
checkable, and a line without one is not evidence of anything.

---

## The schedule

Amounts come from [`bounty.md`](bounty.md), fixed in advance so that what a
finding is worth is not decided by the party paying for it after seeing how
much it hurt.

Reporting: [`../SECURITY.md`](../SECURITY.md)
