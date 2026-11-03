---
id: mern
kind: stack
version: 1
title: MERN (React client + Express server + MongoDB)
---
The client follows the React + Vite rules. The server (server/) is an Express app that serves the built client and the form
endpoints listed in server/forms.json. To add a form, add its definition to forms.json (fields, types, required) and post the
form to /api/forms/<id>; do not write new server routes unless a requirement needs one. Never store secrets in the code.
