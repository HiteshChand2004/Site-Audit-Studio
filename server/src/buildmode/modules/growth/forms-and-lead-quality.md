---
id: forms-and-lead-quality
kind: growth
version: 1
title: Growth OS playbook: Forms and lead quality
---
**The form:**
- **MUST** be short: name, work email, company, "What do you want to solve?" (a dropdown of offers), free text. Phone optional.
- **SHOULD** add **one qualifying question** that separates good-fit buyers (e.g. number of sites: 1 / 2–5 / 6+, or number of cameras). Poor-fit leads cost the same ad money as good ones.
- **MUST** include a hidden honeypot field against spam.
- **MUST** send attribution with every submission (section 7).
- Under the form, show 3 short proof lines.
- The thank-you state names the next step and when it happens.

**Separate buyer forms from non-buyer forms.** Newsletter, careers/expert applications and partner enquiries MUST fire different events and MUST NOT count as leads. (On indikaai.com, expert applications were being counted as leads until fixed.)

**Lead storage and routing:**
- Each lead is written to a lead sheet / CRM with: time, form type, contact fields, offer, message, score, tier, source, medium, campaign, ad content, search term, landing page, first touch, referrer, **gclid**, status, owner, next step.
- The endpoint that writes leads MUST require a server-side secret, so nobody can post fake leads. Tested: a fake lead without the secret was refused.
- Writing to the sheet MUST never block or fail the lead; the visitor always sees success.
- Send an internal alert email per lead, from a company domain address, showing source, campaign, keyword and landing page.

**Calls, emails and WhatsApp are leads too, but no form captures them.** Every inbound contact that did not come through a form MUST be logged in the same lead sheet the same day, with: date, channel (phone / email / WhatsApp), name, contact, company, role, what they asked, **"How did you find us?"** (asked on the call), fit verdict and reason. Unqualified contacts are stored too (status "Not qualified" + reason), never deleted: they show who the site attracts and feed the negative-keyword list. If paid ads run, use call assets/call reporting in Google Ads so calls from ads are counted.

**Evidence:** in the first 4 days, 2 of 4 inbound contacts did not use the form (an email to the footer address and a phone call), and the caller was an engineering student seeking a partnership, not a buyer.

**Lead scoring (transparent rubric, not a model):** business email +, senior role +, phone +, detailed message +, matching industry +, engagement stage (tender/deploy) +; personal email −, very short message −. Tiers: hot / warm / nurture. Add points for the qualifier (e.g. 2+ sites) so poor-fit leads drop to nurture automatically.

**Evidence:** of the first 3 inbound leads, 1 was a good fit (enterprise), 1 was an SME and 1 had a sub-₹1 lakh budget. The form had no size question. Cost per qualified lead is about 3× cost per lead without a filter.
