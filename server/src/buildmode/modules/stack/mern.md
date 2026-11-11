---
id: mern
kind: stack
version: 2
title: MERN (React client + Express server + MongoDB)
---
The site is a React 19 + Vite multi-page client in client/ (the React + Vite rules apply, with every path under client/), and
a fixed Express server in server/ that serves it and stores form submissions in MongoDB; the owner reads them on /admin. The
backend is the forms: contact, booking requests, newsletter sign-ups, as plain <form method="post" action="/api/forms/<id>">
that work without JavaScript, each described in server/forms.json (fields, types, required, limits). No server code is
written, so no logins, payments, search or file uploads: plan around them, and say so in the brief.
