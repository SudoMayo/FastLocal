# FastLocal: Copilot context
Read docs/PRD.md. FastLocal is instant disruption cover for local train commuters.
Tap once to protect your ride. If the train stops (rain flooding, signal, power,
or track fault), an autonomous agent pays you. No claim.

You work on UI only: web/components/ and styling in web/app/page.tsx and
web/app/screen/page.tsx. Do not edit web/lib/, web/app/api/, web/scripts/, contracts/.

Stack: Next.js App Router, TypeScript, Tailwind. No UI kits, no state libraries.
Use types from web/lib/types.ts. Use mock data until real helpers are wired.

Design:
- Phone: mobile first, large touch targets, one action per screen. Dark background,
  purple accent, green for payout success.
- Status colors: CLEAR gray, ALERT amber, DISRUPTED red with pulse.
- Cause labels: Rain flooding, Signal failure, Power failure, Track fault, Other.
  Rain gets a rain icon.
- Screen: projector view, readable from the back of a room, very large numbers.
- Money in rupees with a small "demo rate" label.
Code: small components, clear names, short comments.
