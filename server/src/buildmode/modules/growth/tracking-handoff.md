---
id: tracking-handoff
kind: growth
version: 1
title: Growth OS playbook: Tracking hand-off (no trackers are added by the builder)
---
Tracking (Google Tag Manager, GA4, ad and visitor tags) is NOT installed by you: the safety rules ban trackers and outside scripts, and the
owner adds the tag container after the site is built. Make the site ready for it:
- One primary action. Put data-track="primary-cta" on every link or button that leads to the enquiry, and data-track="lead-form" on the
  enquiry form itself, so the owner's tags can find them without changing the page.
- Phone, email and WhatsApp links are real tel:, mailto: and https://wa.me/ links, each with data-track="phone", "email" or "whatsapp".
- The enquiry form has a clear thank-you state (a visible confirmation, or a /thank-you page), so a finished enquiry can be measured.
- Newsletter, careers and partner forms use data-track="other-form", never "lead-form": only real buyer enquiries count as leads.
- Never add a script, a tag, a pixel or an inline handler for any of this. In your finish report, say that tracking is left for the owner.
