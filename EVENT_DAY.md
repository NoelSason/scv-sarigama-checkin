# Event Day Runbook — SCV Sarigama Onam 2026

**Site:** https://checkin.scvsarigama.com
**Everyone signs in at:** https://checkin.scvsarigama.com/staff

Print this. Keep one copy at the registration desk and one at the Sadhya entrance.

---

## The one rule everyone needs

**The QR code does not contain the ticket count.** It only identifies the family.
The real balance lives on the server and is checked every time you scan.

That means a family can screenshot the code, text it to their kids, and use it
at three different times — and it still can't be used more times than they paid
for. It also means **a screenshot showing "3 remaining" proves nothing.** Only
the green success screen on *your* phone counts.

---

## REGISTRATION VOLUNTEER

You are at the front desk. Your job is to get people their pass.

### Someone arrives — this is the whole job

1. **Ask their name** and type it in the big search box.
   Partial names work — typing `kavith` finds `Kavitha Raveendra Raja`.
2. **Tap their name.** Their QR code appears straight away.
3. **Check the payment status** shown above the QR:
   - **PAID** or **COMPED** → carry on.
   - **UNPAID** → collect payment first (below).
   - **NEEDS REVIEW** → get the admin. Don't guess.
4. **Say the number out loud:** *"I have you down for 4 — is that right?"*
5. **"Point your phone camera at this."** Their phone opens their pass.
6. **Tell them to screenshot it.** That screenshot is what gets scanned at the
   Sadhya line, and one pass covers the whole family.

That's it. They now carry their own pass and never need you again.

If their phone camera won't cooperate, tap
**"Camera not working? Show the link instead"** under the QR and let them type
it in. Slow, but it works.

Two families have bought twice (two separate payments). They'll show up as two
rows — give them both QRs, or point them at whichever has admissions left.

### They paid but aren't in the system

Most likely they paid by Zelle and the row hasn't synced, or the name is spelled
differently. Try:
- Searching a **shorter** piece of the name (`thom` not `Thomas Kurien`)
- Searching their **email or phone**

Still nothing? Get the admin before creating anything new. Creating a duplicate
household is worse than a two-minute wait.

### Walk-in (paying at the door)

1. Tap **+ NEW WALK-IN**.
2. Fill in name, number of admissions, and payment method.
3. **Children under 6 go in the "under 6" box, not the admissions box.**
   They eat free and do not need a ticket.
4. **Take the money first.** Only tick "payment confirmed" once cash is in your
   hand, you've seen the Zelle notification, or you've seen the Square receipt.
5. The QR appears immediately. Let them photograph it.

### Fixing details

- Wrong email or phone → **Edit**, fix it, save.
- Wrong number of admissions → **Adjust tickets**. You'll be asked to confirm
  and to type a reason. That's deliberate: it's a permanent change to what they
  are owed, and someone may need to understand it later.

### Registration does NOT use up admissions

Checking someone in at the desk consumes nothing. Admissions are only used at
the Sadhya line.

---

## SADHYA SCANNER VOLUNTEER

You are at the food entrance. Your job is fast, correct counting.

### Every single person

1. Tap **Scan**, point at their QR.
2. **Read the family name out loud.** Confirms you scanned the right code.
3. Ask: **"How many are eating right now?"**
4. Tap that number.
5. **Wait for the green screen.** Then let them through.

### What the screens mean

| Screen | What to do |
|---|---|
| ✓ green, "2 ADMITTED" | Let those 2 through. Done. |
| ✕ "ONLY 1 REMAINING" | Nothing was used. They asked for more than they have. Send them to registration. |
| ✕ "NO TICKETS REMAINING" | All admissions used. Send to registration — don't argue at the food line. |
| ✕ "NOT PAID" | Send to registration to pay. |
| ✕ "PASS NOT VALID" | Send to registration. |
| ⚠ red bar: "Connection unavailable" | **STOP. Do not admit anyone.** Wait for signal. |

### Things that will happen, and what to do

- **A family splits up.** Grandparents eat at 1pm, kids at 3pm, same QR. Totally
  fine — just scan and redeem what's in front of you each time.
- **Someone shows a screenshot from this morning.** Scan it anyway. The server
  gives you the live number. Never trust the number printed in the screenshot.
- **Their phone is dead / screen is cracked.** Tap **Search manually**, find them
  by name, redeem from there.
- **Camera won't open.** Use **Search manually**. Get someone to check camera
  permissions on that phone between guests.
- **You tapped the wrong number.** Don't try to fix it yourself. Send the family
  through and tell the admin the family name and what happened — it takes them
  about fifteen seconds to reverse.

### Never

- Never admit anyone on a screenshot alone.
- Never redeem while the red connection bar is showing.
- Never redeem "in advance" for people who aren't standing there.

---

## ADMIN

You have `/staff/admin`. Emergency lookup is at the top of that page.

### Someone's QR isn't working

Emergency lookup → search the name → you can see everything and redeem directly.
You never need to open the spreadsheet.

### A redemption was entered wrong (3 instead of 2)

1. Find the household → **View history**.
2. Find the redemption → **Reverse**.
3. Enter how many to give back (1) and a reason.

The original record is never deleted. You get both the mistake and the
correction in the history, which is what you want if anyone asks later.

### Wrong ticket count

Household → **Adjust tickets** → new total + reason.
The system will refuse to set the total below what they've already eaten —
if you need that, reverse the redemptions first.

### Duplicate households

Check the **Review queue**. If two records are genuinely the same family:
1. Note both ticket counts and both redemption counts.
2. Adjust the record they're actually using to the correct combined total.
3. **Disable** the other pass (don't delete it).
4. Write a note on both saying what you did.

### Someone paid but isn't in the system

Fastest path is a walk-in record with the right payment method, marked paid.
Then tell the sync to run so it doesn't get created twice — or leave it and
resolve the duplicate in the review queue afterwards.

### Email didn't arrive

Household → **Resend email**. If it fails again, check the admin status panel
for email health. Not urgent — just show them the QR on your screen instead.

### Square payment mismatch

The **review queue** lists any Square order we couldn't map confidently. Open it,
look at the raw order data shown, and set the ticket count by hand with a reason.
Never guess from the dollar amount — the price changed from $25 to $30 partway
through the sale, and some Square labels still show the old price.

### Spreadsheet mismatch

The spreadsheet is an *import source*, not the live ledger. If it disagrees with
the app during the event, **the app wins**. Fix the app, note it, and reconcile
the spreadsheet afterwards.

### Refund after someone already ate

The system flags this for review and changes nothing on its own. That's
intentional. Decide by hand and write a note.

---

## If everything breaks

1. **Check the red banner.** If it says the connection is down, it's the venue
   Wi-Fi, not the app. Switch a phone to cellular and test.
2. **Check https://checkin.scvsarigama.com/staff/admin** — the status panel shows
   database, webhook, sync, and email health.
3. **Fall back to paper.** `/staff/admin/roster` is a printable list of every
   household and their balance. **Print it before the event starts.** If the
   venue's network dies completely, mark the paper by hand and reconcile after.

Do not improvise an offline version of the app. Two phones working offline can
both hand out the same last ticket — that's exactly the failure this system
exists to prevent.

---

## Contacts

| Role | Name | Phone |
|---|---|---|
| System admin | Noel Sason | |
| Registration lead | | |
| Sadhya lead | | |

_Fill these in before the event._
