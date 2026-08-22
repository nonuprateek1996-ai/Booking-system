# WhatsApp alerts for new booking requests

When a guest requests a room the owner is alerted by WhatsApp as well as email.
Nothing in the code needs changing to turn this on — the transport activates
purely from environment variables (`src/notify.js`), and until they are set the
messages simply sit in the dashboard marked `skipped`.

Creating the Meta Business account is step zero. The rest follows.

## 1. Create an app and add WhatsApp

1. Go to <https://developers.facebook.com> → **My Apps** → **Create App**.
2. Pick the **Business** app type and attach it to the Business account you
   just created.
3. On the app dashboard, add the **WhatsApp** product.

Adding the product creates a WhatsApp Business Account (WABA) and a free test
phone number for you.

## 2. Collect the two required values

Open **WhatsApp → API Setup** in the app. Two things there matter:

| Meta calls it | Goes into | Notes |
| --- | --- | --- |
| Phone number ID | `WHATSAPP_PHONE_NUMBER_ID` | A long number. **Not** the phone number itself — the digits shown next to it. |
| Temporary access token | `WHATSAPP_TOKEN` | Expires in 24 hours. Fine for a first test, useless in production — see step 4. |

On the same page, add your own mobile number under **To**. Meta's test number
can only message recipients you have explicitly verified there (up to five), so
alerts go nowhere until you do this.

## 3. Try it

Set the two variables locally and submit a booking through the site:

```bash
export WHATSAPP_TOKEN='EAAG...'
export WHATSAPP_PHONE_NUMBER_ID='123456789012345'
export NOTIFY_PHONE='919000000000'    # who receives the alert
npm start
```

`NOTIFY_PHONE` overrides the property's contact number from the dashboard. Meta
wants international format with no `+` and no leading zeros; the code strips
anything that is not a digit, so `+91 90000 00000` also works.

Two ways to check the result without guessing:

- The **Requests** tab prints which channels are live at the top: *"New requests
  alert you by email and WhatsApp."*
- `GET /api/owner/notifications` shows every message with its `status` and, when
  something went wrong, Meta's own error text in `detail`.

## 4. Make the token permanent

The API Setup token dies after 24 hours, so alerts stop the next day. Production
needs a **System User** token, which does not expire:

1. **Business Settings** → **System users** → **Add**. Give it a name and the
   **Admin** role.
2. **Assign assets** → your **app** (Full control → *Manage app*).
3. **Assign assets** again → your **WhatsApp account** (Full control →
   *Manage WhatsApp Business accounts*).
4. **Generate new token** → select the app → tick `whatsapp_business_messaging`
   and `whatsapp_business_management` → generate.

Copy it immediately; Meta shows it once. This is the value that belongs in
Render, not the temporary one.

## 5. Create the message template

A booking alert is *business-initiated*. Meta only allows free-form text within
24 hours of the recipient last messaging you, so without an approved template
your alerts work in testing and then quietly stop landing. `src/notify.js` falls
back to plain text when no template is set, which is why it can look fine at
first.

In **WhatsApp Manager → Message templates → Create template**:

- Category: **Utility** (not Marketing — Utility is for transactional notices
  and is approved faster).
- Body: exactly **five** placeholders, in this order — the code fills them
  positionally, so the order is not cosmetic:

  ```
  New booking request from {{1}} for {{2}}.
  Check-in {{3}}, check-out {{4}}. Total {{5}}.
  Approve or decline it in your dashboard.
  ```

  | Placeholder | Value sent |
  | --- | --- |
  | `{{1}}` | Guest name |
  | `{{2}}` | Room name |
  | `{{3}}` | Check-in date |
  | `{{4}}` | Check-out date |
  | `{{5}}` | Total, e.g. `INR 12,600` |

- Provide sample values when prompted; Meta rejects templates without them.

Approval usually takes minutes. Then set `WHATSAPP_TEMPLATE_NAME` to the
template's name, and `WHATSAPP_TEMPLATE_LANG` if the language is not `en`.

## 6. Set the variables in Render

Service → **Environment**:

| Key | Value |
| --- | --- |
| `WHATSAPP_TOKEN` | the System User token from step 4 |
| `WHATSAPP_PHONE_NUMBER_ID` | from step 2 |
| `WHATSAPP_TEMPLATE_NAME` | from step 5 |
| `WHATSAPP_TEMPLATE_LANG` | only if not `en` |
| `NOTIFY_PHONE` | only to override the dashboard contact number |

They are deliberately absent from `render.yaml`: the token is a credential and
does not belong in the repository.

## 7. Going live

The test number is fine for trying this out, but it cannot message guests who
are not on the verified list. For real use, add your own number under
**WhatsApp → API Setup → Add phone number** and complete Meta's business
verification for the Business account.

## Behaviour worth knowing

- **Delivery never blocks a booking.** Every message is written to the
  `notifications` table *before* delivery is attempted, and the send is
  fire-and-forget. A broken token or an unapproved template cannot fail or delay
  a guest's request — the dashboard stays the source of truth.
- **Failures are visible, not silent.** A rejected send is stored as `failed`
  with Meta's error text, so a wrong phone number ID shows up as a readable
  message rather than a missing alert.
- **Guests are emailed, not WhatsApped.** Approval and decline notices go out
  over email only; WhatsApp is the owner's alert channel.
