# Black Diamond Bar — Stock & Sales System

A simple, offline-first system for running the bar: ring up sales, count stock,
receive deliveries and see what was sold, what was made and what went missing.

It runs entirely in a web browser. There is nothing to install and no internet
connection needed — open `index.html` on the bar laptop or tablet and start.

## Getting started

1. Open `black-diamond-bar/index.html` in Chrome, Edge, Safari or Firefox.
2. Go to **Settings** and set the bar name, currency and staff names.
3. Add your products under **Products** (or click **Load sample products** to try it out).
4. Pick who is on shift from the top-right menu and start selling.

## What each section does

| Section | Use it to… |
|---|---|
| **Dashboard** | See tonight's sales, profit, items sold, stock value, the reorder list and the latest sales. |
| **Sell** | Tap drinks to build an order, choose Cash / Card / EFT / Tab, and record the sale. Stock goes down automatically and you can't sell what isn't there. |
| **Products** | Keep the price list: name, category, unit (bottle, tot, glass…), cost price, selling price, reorder level. Shows margin and stock status. |
| **Stock → Stock take** | Enter the physical count for each item. The system shows expected vs counted and the rand value of any variance (shortage), then sets stock to the count. |
| **Stock → Deliveries** | Record stock coming in from suppliers, with invoice number, unit cost and an optional best-before date. Cost prices update from the latest delivery. |
| **Stock → Record damage** | Write off broken, spilled, damaged, spoiled or expired stock. It is removed from stock and listed in Stock Watch with its cost. |
| **Stock → Adjust** | Other corrections such as staff drinks, complimentary drinks or found stock — always with a reason. |
| **Stock → Movement log** | Audit trail of every change to every product: sales, voids, deliveries, adjustments and count variances, with running balance. |
| **Stock Watch** | One place for problems: **Needs restocking** (out of stock, below reorder level, or selling fast enough to run out within a week, with a suggested order quantity and cost — download or print it as an order list), **Damaged stock** (everything broken, spilled, spoiled or expired, with reason, who recorded it and what it cost), and **Expiring soon** (stock past or near its best-before date, with one-click write-off). The tab shows a red count when something needs attention. |
| **Sales** | All transactions for any date range, with who made each one. Filter by staff member. Open a sale to see its items or void it. |
| **Staff & Voids** | Sales per staff member (number, items, value, average) and how many of their sales were voided. The **void log** lists every correction: which sale, who made it, who voided it, which manager authorised it, and why. A manager voiding their own sale is flagged. |
| **Reports** | Revenue, cost of sales, gross profit and margin; breakdowns by category, payment method, staff member, hour and day; product performance; stock variance. Export to CSV or print. |
| **Settings** | Bar details, staff, categories, **who can authorise voids** (with a PIN per manager), backup / restore, sample data, erase. |

## Recommended routine

- **Opening:** pick who is on shift. Every sale is recorded against that name, so change it at each shift change.
- **Mistakes:** open the sale under **Sales** and choose **Void sale**. Pick what went wrong; a manager picks their name and enters their PIN to approve it.
- **During service:** record every sale on the **Sell** screen.
- **Deliveries:** record them as soon as they are checked in.
- **Breakages and spills:** record them straight away with **Record damage**.
- **Before ordering:** open **Stock Watch → Needs restocking** and download the order list.
- **Weekly:** check **Stock Watch → Expiring soon**; move short-dated stock to the front or write it off.
- **Closing (or weekly):** do a **Stock take**, then check **Reports → Stock variance**.
  A big negative variance means stock is going missing — check the movement log for that product.
- **End of day:** **Settings → Download backup** and keep the file somewhere safe (email, USB, cloud drive).

## Data and backups

- Everything is saved automatically in the browser on that device (local storage).
- Clearing the browser's site data deletes it, so download backups regularly.
- To move to a new device, download a backup on the old one and use **Restore backup** on the new one.
- Each device has its own data; this version does not sync between tills.

## How it is built

| File | Purpose |
|---|---|
| `index.html` | Page shell and navigation. |
| `styles.css` | Black Diamond theme (dark, ice-blue accents), responsive for phone, tablet and desktop, print styles for reports. |
| `core.js` | All business rules — products, sales, voids, deliveries, stock takes, adjustments, reports — as pure functions with validation. No UI code. |
| `app.js` | The user interface: renders each section and calls `core.js`. |
| `tests/core.test.js` | Automated tests for the business rules. |

Key rules enforced by `core.js`:

- Sales snapshot the price and cost at the time of sale, so changing a price never rewrites history.
- A sale is refused if any item would go below zero stock; nothing is changed when a sale fails.
- Voids, adjustments and stock takes are logged with who, when and why — nothing is silently deleted.
- A void needs a manager from the approved list (Settings → Who can authorise voids) and that manager's PIN if one is set. If every manager is later removed from the staff list, anyone on it can approve until new managers are ticked.
- Manager PINs are a simple safeguard against someone approving in another person's name. They are stored on this device, so they are not strong security.
- Products that have history are archived rather than deleted, so old reports stay correct.
- Expiry tracking assumes stock is rotated first-expiry-first-out: units left on the shelf are counted against the latest best-before dates, so sales, damage and stock takes update the expiry list automatically.

### Running the tests

Requires Node.js 18 or newer:

```sh
cd black-diamond-bar
npm test
```
