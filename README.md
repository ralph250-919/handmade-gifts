# Handmade Gifts — online shop on AWS

An online shop for hand-created gifts. It runs on AWS serverless services, takes payment through **Stripe Checkout**, has a small **admin** area for products and orders, and comes with **customer-experience monitoring** so you hear about problems before your customers tell you. The product data can already be exported as an **Instagram Shopping** catalog.

```
Shopper ─► CloudFront ─┬─► S3                 storefront (HTML/CSS/JS)
                       ├─► S3                 product photos (/images/*)
                       └─► API Gateway ─► Lambda (Node 22) ─► DynamoDB (products, orders)
                                                          ├─► Secrets Manager (Stripe keys)
                                                          └─► SES (order emails)
Stripe Checkout (hosted payment page) ──webhook──► /api/webhooks/stripe
Admin (you) ─► Cognito sign-in ─► /admin/
Monitoring: CloudWatch RUM · Synthetics canary · X-Ray · custom metrics · alarms ─► SNS email
```

At low volume this costs very little. Most of it fits in the AWS free tier, with a few dollars a month for the canary, Secrets Manager and CloudWatch. A budget alarm emails you if spending passes your limit.

---

## 1. Try it locally (no AWS or Stripe needed)

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. The admin page is http://localhost:5173/admin/ and needs no login locally. A simulated Stripe page stands in for the real checkout, and order emails are printed in the terminal. Data resets when you restart the server.

```bash
npm test            # unit tests (pricing, checkout, webhook idempotency, feed…)
```

```bash
npm run test:e2e    # browser tests: browse → cart → pay → admin → ship (desktop + mobile)
```

## 2. One-time setup

1. **AWS account.** Install the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and sign in (`aws configure sso` or access keys). Then bootstrap CDK once per account and region:
   ```bash
   npx cdk bootstrap
   ```
2. **Stripe account.** Sign up at https://dashboard.stripe.com. Start in **test mode**.
3. **Edit `cdk.json` → `context`:**

   | Setting | What it does |
   |---|---|
   | `shopName` | Shown on the site and in emails |
   | `currency` | e.g. `usd`, `gbp`, `eur` |
   | `allowedShippingCountries` | ISO codes Stripe will accept addresses for, e.g. `["US","CA"]` |
   | `shippingStandardCents` / `freeShippingOverCents` | Flat shipping rate and free-shipping threshold (0 = never free) |
   | `adminEmail` | Your login. Cognito emails you a temporary password |
   | `alertEmail` | Where alarms, budget alerts and new-order notifications go |
   | `senderEmail` | The "from" address for customer emails. AWS sends a verification link to it |
   | `monthlyBudgetUsd` | You get an alert at 80% of this amount |

## 3. Deploy

```bash
npx cdk deploy
```

It takes about 10 minutes the first time. Write down the **outputs**: `SiteUrl`, `AdminUrl`, `StripeWebhookUrl`, `StripeSecretName`, `ProductsTable` and `DashboardUrl`.

After the first deploy:

1. **Confirm the emails AWS sends you:** the SNS alert subscription, the SES sender verification and the Cognito temporary password.
2. **Add a Stripe webhook.** In Stripe go to Developers → Webhooks → *Add endpoint* and enter the `StripeWebhookUrl` output. Select these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`.
   Copy the **signing secret** (`whsec_…`).
3. **Store your Stripe keys** (Developers → API keys → secret key `sk_test_…`):
   ```bash
   aws secretsmanager put-secret-value --secret-id <StripeSecretName> \
     --secret-string '{"STRIPE_SECRET_KEY":"sk_test_...","STRIPE_WEBHOOK_SECRET":"whsec_..."}'
   ```
   The Lambdas pick up the new value within 5 minutes. Running `cdk deploy` again won't overwrite it.
4. **Optional: load the sample products.** They are added hidden, without photos:
   ```bash
   PRODUCTS_TABLE=<ProductsTable> npm run seed
   ```
5. Sign in at `AdminUrl`, add products and photos, and tick **Visible in shop**.
6. **Run a test purchase** with card `4242 4242 4242 4242`, any future date and any CVC. The order appears in Admin → Orders → *To ship*, and you and the customer both get emails.

### Getting out of the SES sandbox

New AWS accounts can only email *verified* addresses. Before going live, open SES → *Account dashboard* → **Request production access**. Approval usually takes about a day.

### Going live

1. Activate your Stripe account and create a new webhook in **live mode**.
2. Put the live `sk_live_…` and `whsec_…` values into the secret, using the same command as above.
3. Optional: use your own domain. Add an ACM certificate (in us-east-1) and `domainNames` to the CloudFront distribution in `infra/lib/frontend.ts`, then point DNS (Route 53 or your registrar) at it. Add the new URL to the Cognito `callbackUrls` in `infra/lib/auth.ts` and to `SITE_URL`.

---

## 4. Running the shop day to day

**Admin (`/admin/`)**
- **Orders → To ship:** shows each paid order's items, customer and shipping address. Enter tracking details, then click **Mark shipped & email customer**.
- **⚠ warnings on an order:** something needs your attention. For example, two people bought the last item at the same moment. Contact the customer.
- **Products:** add or edit items, upload photos (the first photo is the main one) and set stock.
  - Leave **Stock** blank for *made to order* items, which have no limit.
  - Untick **Visible** to hide a product without deleting it.
  - The storefront updates within about a minute.

**Pricing safety:** the browser never decides prices. At checkout the server reloads every product from the database, checks stock and builds the Stripe session itself.

---

## 5. Monitoring: how you'll know customers are having a good experience

Everything lives in the CloudWatch dashboard (`DashboardUrl` output). Alarms email `alertEmail` when they go off **and** when they recover.

| What | How | Where to look |
|---|---|---|
| Real shoppers' page speed and JS errors | CloudWatch RUM snippet on every storefront page | CloudWatch → RUM → *storefront* |
| "Is the shop up?" every 5 min | Synthetics canary: loads home and product pages, checks `/api/health` (database + Stripe keys) | CloudWatch → Synthetics → Canaries (screenshots of each run) |
| Checkout funnel | Custom metrics `CheckoutStarted → CheckoutCompleted`, plus `Rejected` (sold out, etc.), `Failed` (our fault) and `Expired` (abandoned) | Dashboard → *Checkout funnel* |
| Request tracing | X-Ray on API Gateway, Lambda and AWS SDK calls | CloudWatch → X-Ray traces → Trace map |
| Logs | Structured JSON logs with `requestId` and `orderId`, plus API access logs | Logs Insights → saved queries **"Shop errors"**, **"Find an order"**, **"Slow or failed API requests"** |
| Spend | AWS Budget | Email at 80% of `monthlyBudgetUsd` |

When a customer hits an error, the message includes a **reference** (the request id). Search for it with the "Shop errors" query to see exactly what happened.

### Runbook: what to do when an alarm emails you

| Alarm | What it means | First steps |
|---|---|---|
| **CanaryFailing** | The robot shopper couldn't use the site for 10 minutes. | Open the canary run to see the screenshot and failing step. If `api-health` failed, check its response: `payments:false` means the Stripe secret is missing or invalid, and `database:false` means a DynamoDB or permissions problem. If only `home-page` failed, check CloudFront and recent deploys. |
| **CheckoutFailures** | 3+ customers in 15 minutes couldn't start checkout. | Run the "Shop errors" query filtered to `route = "POST /api/checkout"`. Common causes are an invalid or rotated Stripe key, a Stripe outage (https://status.stripe.com) or an unsupported country or currency. Customers' carts are saved, so they can retry. |
| **WebhookFailures** | Stripe's payment notifications are failing, so paid orders may stay "Abandoned/in checkout". | Stripe Dashboard → Webhooks → your endpoint → failed deliveries. `Invalid signature` means the `STRIPE_WEBHOOK_SECRET` is wrong, often because test and live are mixed up. Stripe retries for 3 days, so once fixed, click **Resend** on failed events. |
| **OrderEmailFailures** | An order or shipping email wasn't sent. | Usually the SES sandbox or an unverified sender. The order is still saved, so email the customer manually from the admin. |
| **StockConflict** | An item sold more times than you had in stock. | The order shows a ⚠ warning in admin. Contact the customer about timing or a refund (refunds are made in the Stripe Dashboard). |
| **Api5xx / *Function*Errors** | Server errors. | "Shop errors" query. If it started right after a deploy, roll back by redeploying the previous commit. |
| **ApiSlow** | p95 latency over 2 s for 15 minutes. | "Slow or failed API requests" query and the X-Ray trace map. Usually a slow dependency, such as Stripe. |
| **BrowserErrors** | Shoppers are hitting JavaScript errors. | CloudWatch RUM → Errors shows the message, page and browser. |

---

## 6. Instagram

**Ready now:**
- **Product catalog feed:** `https://<your-site>/api/feed/catalog.csv` is in Meta Commerce format (id, title, description, availability, price, link, image_link, brand…). Hidden products and products without photos are left out.
- Open Graph tags on pages, for link previews.

**To turn on Instagram Shopping later:**
1. Convert your Instagram account to a **Business** account and link it to a Facebook Page.
2. In **Meta Commerce Manager**, create a catalog and choose **Data feed → Scheduled feed**, using the URL above (daily refresh).
3. Set up a shop in Commerce Manager, select checkout *on your website*, and submit it for review.
4. Once approved, you can tag products in posts and reels. Tags link to your product pages, and checkout still happens through Stripe on your site.

Possible next steps: a Lambda that uses the Instagram Graph API to show your latest posts on the home page, and UTM tags on links so you can see Instagram-driven sales.

---

## Project layout

```
infra/                 AWS CDK (TypeScript): one stack built from these constructs
  lib/storage.ts       DynamoDB tables, S3 buckets, Stripe secret, SES identity
  lib/api.ts           HTTP API routes + Lambda functions + least-privilege IAM
  lib/frontend.ts      CloudFront (site, /images, /api) + site deployment
  lib/auth.ts          Cognito user pool for the admin
  lib/monitoring.ts    RUM, canary, alarms, dashboard, log queries, budget
backend/src/
  handlers/            One Lambda per concern (products, checkout, stripeWebhook, admin…)
  lib/                 Business logic (cart pricing, checkout, fulfillment, feed) + AWS adapters
frontend/              Static storefront + admin (no build step)
scripts/               Local dev server, seed script, sample data
tests/unit/            Vitest unit tests
tests/e2e/             Playwright browser tests (local, or BASE_URL=<site> for a live smoke test)
.github/workflows/     CI: typecheck, tests, cdk synth; optional deploy via GitHub OIDC
```

## Useful commands

| Command | |
|---|---|
| `npm run dev` | Local shop with a simulated Stripe |
| `npm test` / `npm run test:e2e` | Unit / browser tests |
| `npm run typecheck` | TypeScript check |
| `npx cdk diff` | Preview infrastructure changes |
| `npx cdk deploy` | Deploy |
| `BASE_URL=https://… npx playwright test --project=desktop` | Smoke-test the live site (read-only tests only) |
