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
| **Stock → Deliveries** | Record stock coming in from suppliers, with invoice number and unit cost. Cost prices update from the latest delivery. |
| **Stock → Adjust** | Write off breakages, spillage, expired stock, staff drinks or complimentary drinks — always with a reason. |
| **Stock → Movement log** | Audit trail of every change to every product: sales, voids, deliveries, adjustments and count variances, with running balance. |
| **Sales** | All transactions for any date range. Open a sale to see its items or void it (a reason is required and the stock is returned). |
| **Reports** | Revenue, cost of sales, gross profit and margin; breakdowns by category, payment method, staff member, hour and day; product performance; stock variance. Export to CSV or print. |
| **Settings** | Bar details, staff, categories, backup / restore, sample data, erase. |

## Recommended routine

- **Opening:** pick who is on shift.
- **During service:** record every sale on the **Sell** screen.
- **Deliveries:** record them as soon as they are checked in.
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
- Products that have history are archived rather than deleted, so old reports stay correct.

### Running the tests

Requires Node.js 18 or newer:

```sh
cd black-diamond-bar
npm test
```
