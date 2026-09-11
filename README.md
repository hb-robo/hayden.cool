# Personal notes
1. How to run locally
`wrangler dev`

2. Full first-time deployment to Cloudflare
Install Wrangler and log in:
`npm i -D wrangler`
`wrangler login`

Create the D1 database:
`wrangler d1 create notes-db`

Paste the returned database_id into wrangler.toml.
Create the notes table remotely:
`wrangler d1 execute notes-db --file=./schema.sql --remote`

Set the admin password:
`wrangler secret put ADMIN_PASSWORD`

Deploy:
`wrangler deploy`

Verify at the *.workers.dev URL first.
In the Cloudflare dashboard, go to:
Workers & Pages → worker → Settings → Domains & Routes → Add → Custom domain → firstname.cool
Cloudflare will automatically create the DNS record and TLS configuration.

3. How to change my password
Run:
`wrangler secret put ADMIN_PASSWORD`

Enter the new password when prompted. Existing sessions become invalid because the session key is derived from ADMIN_PASSWORD.
4. Ideas I deliberately did not implement
None.