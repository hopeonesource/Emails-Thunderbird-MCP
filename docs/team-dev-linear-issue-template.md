# Team Dev Linear Issue Template

Copy this into every Linear issue that requires local development access, external services, or MVP integration testing.

~~~markdown
## Team Dev Access

Branch:

Required services:
- [ ] Local only
- [ ] AWS
- [ ] Salesforce
- [ ] Google service account
- [ ] Gmail drafts
- [ ] Twilio / WhatsApp Sandbox
- [ ] Other:

AWS profile:
- Expected local profile: `HopeOneSource-Dev`
- Compatibility profile, if needed: `HOP42-Sandbox-Developer`

Required secrets:
- [ ] `hope1source/dev/salesforce/jwt`
- [ ] `hope1source/dev/google/service-account`
- [ ] Other:

Local setup:
```bash
npm run dev:doctor
npm run dev:secrets
npm run dev:smoke
```

Repo test command:
```bash
npm test
```

Blast radius:
- [ ] Level 0: local only, no external calls
- [ ] Level 1: read-only dev service calls
- [ ] Level 2: writes test artifacts in dev/sandbox only
- [ ] Level 3: test sends or shared dev data changes
- [ ] Level 4: production-impacting, requires explicit approval

Allowed side effects:
- Gmail drafts:
- Salesforce validation writes:
- Twilio/live sends:
- Other:

Test account/data:
-

Production approval:
- [ ] No production impact
- [ ] Production deploy or write requires PR review plus GitHub Environment approval

Cleanup or rollback:
-

Developer handoff:
- Setup result:
- Tests run:
- External services touched:
- Blast radius observed:
```
~~~
